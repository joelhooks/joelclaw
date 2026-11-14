import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectAlerts } from "../src/alerts";
import { walCheckFor } from "../src/cell";
import { createDrain, type DrainDeps, type WalCheck } from "../src/drain";
import { BlobUnreadableError } from "../src/failure";
import { fold, openOutbox, readHealth, replay } from "../src/outbox";
import { shadowAppend } from "../src/shadow-append";
import type { AppendObservation, CapturedPayload } from "../src/types";
import { capturedPayload, OBSERVED_APPENDED, SOURCE, tempRoot } from "./fixtures";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function harness(overrides: Partial<DrainDeps> = {}) {
  const db = openOutbox(":memory:");
  let clock = 1_000;
  const appended: string[] = [];
  const shipped: Array<Record<string, unknown>> = [];
  const deps: DrainDeps = {
    db,
    now: () => clock,
    appendStep: (payload: CapturedPayload): AppendObservation => {
      appended.push(payload.run_id);
      return OBSERVED_APPENDED;
    },
    shipOtel: async (event) => {
      shipped.push(event);
    },
    walCheck: () => ({ paused: false }),
    tickMs: 60_000,
    log: () => undefined,
    ...overrides,
  };
  const drain = createDrain(deps);
  return {
    db,
    drain,
    appended,
    shipped,
    advance: (ms: number) => {
      clock += ms;
    },
    capture: (payload: CapturedPayload) => fold(db, { type: "captured", payload, at: clock }),
    owed: () =>
      db.query("SELECT run_id, step, state, attempts FROM owed ORDER BY run_id, step").all(),
  };
}

describe("drain", () => {
  test("drains in arrival order across sessions and never waits for a gap", async () => {
    const h = harness();
    // One session's offsets arrive out of order (0, then 200, with 100 still missing).
    h.capture(
      capturedPayload("s1-at-0", { source_identity: SOURCE, from_offset: 0, to_offset: 100 }),
    );
    h.capture(
      capturedPayload("other-session", {
        source_identity: `sha256:${"d".repeat(64)}`,
        from_offset: 0,
      }),
    );
    h.capture(
      capturedPayload("s1-at-200", { source_identity: SOURCE, from_offset: 200, to_offset: 300 }),
    );
    h.capture(capturedPayload("legacy"));
    await h.drain.settle();
    h.drain.stop();
    expect(h.appended).toEqual(["s1-at-0", "other-session", "s1-at-200", "legacy"]);
    expect(h.owed()).toEqual([]);
    // One verdict event per run, each with the deterministic id.
    expect(h.shipped.map((event) => event.id).sort()).toEqual(
      ["legacy", "other-session", "s1-at-0", "s1-at-200"]
        .map((run) => `capture-cell:${run}:append`)
        .sort(),
    );
    expect(readHealth(h.db, 2_000)).toMatchObject({ depth: 0, dead: 0, verdicts: 4 });
  });

  test("a later run of a session goes ahead while an earlier one backs off", async () => {
    let failFirst = true;
    const h = harness({
      appendStep: (payload) => {
        if (payload.run_id === "first" && failFirst) {
          failFirst = false;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return OBSERVED_APPENDED;
      },
    });
    h.capture(capturedPayload("first", { source_identity: SOURCE, from_offset: 0 }));
    h.capture(capturedPayload("second", { source_identity: SOURCE, from_offset: 100 }));
    await h.drain.settle();
    expect(h.owed()).toEqual([
      { run_id: "first", step: "append", state: "owed", attempts: 1 },
      { run_id: "first", step: "otel", state: "owed", attempts: 0 },
    ]);
    expect(h.db.query("SELECT run_id FROM verdicts").all()).toEqual([{ run_id: "second" }]);
    // After the backoff the transient failure is retried and succeeds.
    h.advance(1_000);
    await h.drain.settle();
    h.drain.stop();
    expect(h.owed()).toEqual([]);
  });

  test("a deterministic failure goes dead with its reason, alerts once, and replays", async () => {
    let missing = true;
    const h = harness({
      appendStep: (payload) => {
        if (missing)
          throw new BlobUnreadableError(
            payload.jsonl_path,
            Object.assign(new Error("gone"), { code: "ENOENT" }),
          );
        return OBSERVED_APPENDED;
      },
    });
    h.capture(capturedPayload("r1"));
    await h.drain.settle();
    const dead = h.db.query("SELECT step, state, reason, replay FROM owed").all();
    expect(dead).toEqual([
      {
        step: "append",
        state: "dead",
        reason: "CAPTURE_CELL_BLOB_UNREADABLE: run blob unreadable: ENOENT",
        replay: "capture-cell replay r1",
      },
    ]);
    expect(readHealth(h.db, 1_000)).toMatchObject({ dead: 1, depth: 0 });

    const alerts = collectAlerts(h.db, 1_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("capture-cell replay r1");
    expect(collectAlerts(h.db, 1_001)).toEqual([]);

    missing = false;
    expect(replay(h.db, "r1", 1_000)).toBe(true);
    await h.drain.settle();
    h.drain.stop();
    expect(h.owed()).toEqual([]);
    expect(h.shipped.map((event) => event.id)).toEqual(["capture-cell:r1:append"]);
  });

  test("a transient failure never goes dead and trips the age alert once", async () => {
    const h = harness({
      appendStep: () => {
        throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    });
    h.capture(capturedPayload("r1"));
    for (let pass = 0; pass < 12; pass += 1) {
      await h.drain.settle();
      h.advance(5 * 60_000);
    }
    h.drain.stop();
    const [append] = h.owed() as Array<{ state: string; attempts: number }>;
    expect(append?.state).toBe("owed");
    expect(append?.attempts).toBeGreaterThanOrEqual(10);
    const now = 1_000 + 12 * 5 * 60_000;
    const alerts = collectAlerts(h.db, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("capture-cell stalled");
    expect(collectAlerts(h.db, now + 1)).toEqual([]);
  });

  test("the WAL stop pauses shadow reads, records why, and resumes", async () => {
    let wal: WalCheck = { paused: true, wal_bytes: 3, limit_bytes: 2 };
    const h = harness({ walCheck: () => wal });
    h.capture(capturedPayload("r1"));
    await h.drain.settle();
    expect(h.appended).toEqual([]);
    const paused = readHealth(h.db, 1_000).wal_paused;
    expect(paused).toMatchObject({ wal_bytes: 3, limit_bytes: 2 });
    expect(paused?.reason).toContain("WAL");

    wal = { paused: false };
    await h.drain.settle();
    h.drain.stop();
    expect(h.appended).toEqual(["r1"]);
    expect(readHealth(h.db, 1_000).wal_paused).toBeNull();
  });

  test("the WAL check reads the size of sessions.db-wal against the limit", async () => {
    const temp = tempRoot();
    cleanup = temp.cleanup;
    const path = join(temp.root, "sessions.db");
    await Bun.write(`${path}-wal`, new Uint8Array(4_096));
    expect(walCheckFor(path, 1_024)()).toEqual({
      paused: true,
      wal_bytes: 4_096,
      limit_bytes: 1_024,
    });
    expect(walCheckFor(path, 8_192)()).toEqual({ paused: false });
    expect(walCheckFor(join(temp.root, "absent.db"), 1)()).toEqual({ paused: false });
  });

  test("an otel failure retries and the verdict ships with the same id", async () => {
    let fail = true;
    const shipped: string[] = [];
    const h = harness({
      shipOtel: async (event) => {
        if (fail) throw new Error("connection refused");
        shipped.push(String(event.id));
      },
    });
    h.capture(capturedPayload("r1"));
    await h.drain.settle();
    expect(h.owed()).toEqual([{ run_id: "r1", step: "otel", state: "owed", attempts: 1 }]);
    fail = false;
    h.advance(1_000);
    await h.drain.settle();
    h.drain.stop();
    expect(shipped).toEqual(["capture-cell:r1:append"]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM otel_pending").get()).toEqual({ n: 0 });
  });

  test("a real shadow read on a missing sessions.db is transient", async () => {
    const temp = tempRoot();
    cleanup = temp.cleanup;
    const h = harness({
      appendStep: (payload) =>
        shadowAppend(payload, { sessionsDbPath: join(temp.root, "none.db"), readTimeoutMs: 100 }),
    });
    const jsonl = '{"type":"user","message":{"role":"user","content":"hi"}}\n';
    const path = join(temp.root, "blob.jsonl");
    await Bun.write(path, jsonl);
    h.capture(
      capturedPayload("r1", {
        jsonl_path: path,
        jsonl_bytes: Buffer.byteLength(jsonl),
        jsonl_sha256: new Bun.CryptoHasher("sha256").update(jsonl).digest("hex"),
      }),
    );
    await h.drain.settle();
    h.drain.stop();
    expect(h.owed()).toContainEqual({ run_id: "r1", step: "append", state: "owed", attempts: 1 });
  });
});
