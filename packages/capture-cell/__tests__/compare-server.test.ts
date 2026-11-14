import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compare, formatCompareReport } from "../src/compare";
import { createDrain } from "../src/drain";
import { fold, openOutbox, readVerdict } from "../src/outbox";
import { createCellHandler, parseCapturedPayload } from "../src/server";
import { shadowAppend } from "../src/shadow-append";
import type { CapturedPayload } from "../src/types";
import {
  capturedPayload,
  createSessionsDb,
  indexWithWriter,
  SOURCE,
  tempRoot,
  turnLines,
  writeCapture,
} from "./fixtures";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const MINUTE = 60_000;

/** A cell over a fixture sessions.db: capture, shadow, then let "Inngest" write. */
function shadowFixture() {
  const temp = tempRoot();
  cleanup = temp.cleanup;
  const sessionsDbPath = join(temp.root, "sessions.db");
  createSessionsDb(sessionsDbPath);
  const db = openOutbox(join(temp.root, "outbox.db"));
  let clock = Date.UTC(2026, 9, 17, 12);
  const drain = createDrain({
    db,
    now: () => clock,
    appendStep: (payload) => shadowAppend(payload, { sessionsDbPath, readTimeoutMs: 3_000 }),
    shipOtel: async () => undefined,
    walCheck: () => ({ paused: false }),
    tickMs: 60_000,
    log: () => undefined,
  });
  return {
    root: temp.root,
    sessionsDbPath,
    db,
    drain,
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    async shadow(payload: CapturedPayload) {
      fold(db, { type: "captured", payload, at: clock });
      await drain.settle();
    },
  };
}

describe("compare", () => {
  test("matches appended, already_indexed and conflict verdicts against the writer", async () => {
    const f = shadowFixture();
    const since = f.now - MINUTE;
    const first = writeCapture(f.root, "run-a", turnLines(4), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    // The shadow reads before the writer appends: appended.
    await f.shadow(first);
    indexWithWriter(f.sessionsDbPath, first, f.now);

    // The writer races ahead: the shadow sees run-b already indexed and the
    // stable-outcome rule records appended.
    const second = writeCapture(f.root, "run-b", turnLines(2, 20), {
      source_identity: SOURCE,
      from_offset: first.to_offset,
    });
    indexWithWriter(f.sessionsDbPath, second, f.now);
    await f.shadow(second);
    expect(readVerdict(f.db, "run-b")).toMatchObject({
      verdict: "appended",
      observed: "already_indexed",
    });

    // A resend under another run id at the same cursor: already_indexed on both sides.
    const resend = writeCapture(f.root, "run-c", turnLines(4), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    await f.shadow(resend);
    expect(indexWithWriter(f.sessionsDbPath, resend, f.now).status).toBe("already_indexed");

    // An overlap: conflict on both sides; the writer stores nothing.
    const overlap = writeCapture(f.root, "run-d", turnLines(2, 40), {
      source_identity: SOURCE,
      from_offset: 10,
    });
    await f.shadow(overlap);
    expect(() => indexWithWriter(f.sessionsDbPath, overlap, f.now)).toThrow();

    f.drain.stop();
    const report = compare(f.db, f.sessionsDbPath, since, f.now + 11 * MINUTE);
    expect(report).toMatchObject({
      verdicts: 4,
      matched: 4,
      mismatched: 0,
      pending: 0,
      unseen: 0,
      match_rate: 1,
    });
    expect(formatCompareReport(report)).toContain("Match rate 100.00%");
  });

  test("reports a chunk_count mismatch, a run never indexed, and a run the cell never saw", async () => {
    const f = shadowFixture();
    const since = f.now - MINUTE;
    const indexed = writeCapture(f.root, "run-a", turnLines(4), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    await f.shadow(indexed);
    indexWithWriter(f.sessionsDbPath, indexed, f.now);
    // Simulate a writer that chunked differently.
    const writer = new Database(f.sessionsDbPath, { readwrite: true });
    writer.query("UPDATE runs SET chunk_count = chunk_count + 1 WHERE run_id = 'run-a'").run();
    writer.close();

    const lost = writeCapture(f.root, "run-lost", turnLines(2, 30), {
      source_identity: `sha256:${"e".repeat(64)}`,
      from_offset: 0,
    });
    await f.shadow(lost);

    const unseen = writeCapture(f.root, "run-unseen", turnLines(2, 50, "2026-10-17"), {
      source_identity: `sha256:${"f".repeat(64)}`,
      from_offset: 0,
    });
    indexWithWriter(f.sessionsDbPath, unseen, f.now);
    f.drain.stop();

    // Inside ten minutes the unindexed run is pending, not a mismatch.
    const early = compare(f.db, f.sessionsDbPath, since, f.now + MINUTE);
    expect(early.pending_runs).toEqual(["run-lost"]);

    const report = compare(f.db, f.sessionsDbPath, since, f.now + 11 * MINUTE);
    expect(report.matched).toBe(0);
    expect(report.mismatches.map((m) => [m.run_id, m.kind, m.reason])).toEqual([
      ["run-a", "computed", "computed differs: chunk_count"],
      ["run-lost", "verdict", "cell appended; index has no row"],
    ]);
    expect(report).toMatchObject({ verdict_mismatched: 1, computed_mismatched: 1 });
    expect(report.unseen_runs).toEqual(["run-unseen"]);
    expect(report.match_rate).toBe(0);
    const text = formatCompareReport(report);
    expect(text).toContain("run-unseen");
    expect(text).toContain("computed differs: chunk_count");
    expect(text).toContain("(1 verdict, 1 computed)");
  });

  test("the writer wins the race with a wrong stored chunk_count: compare checks the cell's own parse", async () => {
    const f = shadowFixture();
    const since = f.now - MINUTE;
    const payload = writeCapture(f.root, "run-a", turnLines(4), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    // Inngest's write lands first, and its chunk_count is wrong.
    indexWithWriter(f.sessionsDbPath, payload, f.now);
    const writer = new Database(f.sessionsDbPath, { readwrite: true });
    writer.query("UPDATE runs SET chunk_count = chunk_count + 3 WHERE run_id = 'run-a'").run();
    const stored = (
      writer.query("SELECT chunk_count FROM runs WHERE run_id = 'run-a'").get() as {
        chunk_count: number;
      }
    ).chunk_count;
    writer.close();

    await f.shadow(payload);
    f.drain.stop();
    const verdict = readVerdict(f.db, "run-a");
    // The stable outcome keeps the stored count; the cell's own parse is kept beside it.
    expect(verdict).toMatchObject({
      verdict: "appended",
      observed: "already_indexed",
      chunk_count: stored,
      computed_chunk_count: stored - 3,
      computed_turn_count: 4,
      computed_format: "claude-code",
    });

    const report = compare(f.db, f.sessionsDbPath, since, f.now + 11 * MINUTE);
    expect(report).toMatchObject({
      matched: 0,
      mismatched: 1,
      verdict_mismatched: 0,
      computed_mismatched: 1,
    });
    expect(report.mismatches[0]).toMatchObject({
      run_id: "run-a",
      kind: "computed",
      reason: "computed differs: chunk_count",
    });
    expect(formatCompareReport(report)).toContain("computed mismatches");
  });
});

describe("HTTP surface", () => {
  function handler() {
    const db = openOutbox(":memory:");
    let kicks = 0;
    const drain = {
      kick: () => void (kicks += 1),
      settle: async () => undefined,
      stop: () => undefined,
    };
    const handle = createCellHandler({ db, drain, token: "fixture-token", now: () => 5 });
    return { db, handle, kicks: () => kicks };
  }

  const post = (body: unknown, token = "fixture-token") =>
    new Request("http://cell/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("POST /capture returns 202 only after the save committed, and a duplicate is a no-op", async () => {
    const { db, handle, kicks } = handler();
    const payload = capturedPayload("r1", {
      source_identity: SOURCE,
      from_offset: 0,
      to_offset: 10,
    });
    const response = await handle(post(payload));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, run_id: "r1", duplicate: false });
    expect(db.query("SELECT COUNT(*) AS n FROM owed").get()).toEqual({ n: 2 });
    expect(kicks()).toBe(1);

    const again = await handle(post({ name: "memory/run.captured", data: payload }));
    expect(await again.json()).toEqual({ ok: true, run_id: "r1", duplicate: true });
    expect(db.query("SELECT COUNT(*) AS n FROM captured").get()).toEqual({ n: 1 });
  });

  test("rejects a wrong token, an invalid payload and inline JSONL", async () => {
    const { handle } = handler();
    expect((await handle(post(capturedPayload("r1"), "wrong"))).status).toBe(401);
    expect((await handle(post({ run_id: "r1" }))).status).toBe(400);
    expect((await handle(post({ ...capturedPayload("r1"), jsonl_inline: "{}" }))).status).toBe(400);
    expect(parseCapturedPayload(capturedPayload("r1", { tags: ["a"] }))?.tags).toEqual(["a"]);
  });

  test("a save that fails returns 503, never 202", async () => {
    const { db, handle } = handler();
    db.close();
    expect((await handle(post(capturedPayload("r1")))).status).toBe(503);
  });

  test("GET /health reports depth, oldest owed age, dead and the WAL pause", async () => {
    const { handle } = handler();
    await handle(post(capturedPayload("r1")));
    const health = await (await handle(new Request("http://cell/health"))).json();
    expect(health).toEqual({
      ok: true,
      mode: "shadow",
      depth: 2,
      oldest_owed_age_ms: 0,
      dead: 0,
      verdicts: 0,
      wal_paused: null,
    });
  });
});
