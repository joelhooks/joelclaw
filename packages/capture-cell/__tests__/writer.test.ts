import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeSessionIndexConnections } from "@joelclaw/memory";
import { appendCapture } from "../src/append";
import { startCell } from "../src/cell";
import { compareIndexToCell, readIndexPages } from "../src/compare";
import { loadConfig } from "../src/config";
import { createDrain } from "../src/drain";
import { createHandbackSender, type HandbackEvent, handback } from "../src/handback";
import { fold, openOutbox, readHealth, readVerdict, replay } from "../src/outbox";
import { createCellHandler } from "../src/server";
import {
  createSessionsDb,
  indexWithWriter,
  SOURCE,
  tempRoot,
  turnLines,
  writeCapture,
} from "./fixtures";

const cleanups: Array<() => void> = [];
afterEach(() => {
  closeSessionIndexConnections();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const { root, cleanup } = tempRoot();
  cleanups.push(cleanup);
  const sessions = join(root, "sessions.db");
  createSessionsDb(sessions);
  const outbox = join(root, "outbox.db");
  const db = openOutbox(outbox);
  cleanups.push(() => db.close(false));
  const payload = writeCapture(root, "r1", turnLines(3), { source_identity: SOURCE });
  const shipped: unknown[] = [];
  const drain = createDrain({
    db,
    now: Date.now,
    mode: "cell",
    tickMs: 60_000,
    appendStep: (data) => appendCapture(data, { sessionsDbPath: sessions, readTimeoutMs: 100 }),
    shipOtel: async (event) => {
      shipped.push(event);
    },
    walCheck: () => ({ paused: false }),
  });
  cleanups.push(() => drain.stop());
  return { root, sessions, outbox, db, payload, drain, shipped };
}

function counts(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      runs: (db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
      chunks: (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
    };
  } finally {
    db.close(false);
  }
}

describe("cell writer", () => {
  test("a shadow-configured cell refuses an authoritative POST before saving", async () => {
    const f = fixture();
    const handler = createCellHandler({ db: f.db, drain: f.drain, token: "test", now: Date.now });
    const response = await handler(
      new Request("http://cell/capture", {
        method: "POST",
        headers: { authorization: "Bearer test", "x-capture-cell-mode": "cell" },
        body: JSON.stringify(f.payload),
      }),
    );
    expect(response.status).toBe(503);
    expect(readHealth(f.db, Date.now()).depth).toBe(0);
  });

  test("the outbox migration preserves historical shadow captures", () => {
    const { root, cleanup } = tempRoot();
    cleanups.push(cleanup);
    const path = join(root, "legacy.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE captured (run_id TEXT PRIMARY KEY, arrival_seq INTEGER NOT NULL UNIQUE,
      session_key TEXT NOT NULL, payload_json TEXT NOT NULL, arrived_at INTEGER NOT NULL) STRICT`);
    old.query("INSERT INTO captured VALUES ('old', 1, 'old', '{}', 1)").run();
    old.close(false);
    for (let i = 0; i < 2; i++) {
      const migrated = openOutbox(path);
      try {
        expect(migrated.query("SELECT run_id, writer FROM captured").get()).toEqual({
          run_id: "old",
          writer: 0,
        });
      } finally {
        migrated.close(false);
      }
    }
  });

  test("real writer appends once on duplicate POST, with one durable outcome", async () => {
    const f = fixture();
    const handler = createCellHandler({
      db: f.db,
      drain: f.drain,
      token: "test",
      now: Date.now,
      mode: "cell",
    });
    const post = () =>
      handler(
        new Request("http://cell/capture", {
          method: "POST",
          headers: { authorization: "Bearer test", "x-capture-cell-mode": "cell" },
          body: JSON.stringify(f.payload),
        }),
      );
    const response = await post();
    expect(response.status).toBe(202);
    expect(f.db.query("SELECT COUNT(*) AS n FROM captured").get()).toEqual({ n: 1 });
    await f.drain.settle();
    const original = counts(f.sessions);
    expect(original.runs).toBe(1);
    expect(original.chunks).toBeGreaterThan(0);
    expect(await (await post()).json()).toMatchObject({ duplicate: true });
    await f.drain.settle();
    expect(counts(f.sessions)).toEqual(original);
    expect(f.shipped).toHaveLength(1);
    expect(f.shipped[0]).toMatchObject({
      id: "capture-cell:r1:append",
      action: "capture.cell.append",
      metadata: { mode: "cell", status: "appended" },
    });
    expect(readVerdict(f.db, "r1")?.verdict).toBe("appended");
    expect(readHealth(f.db, Date.now()).depth).toBe(0);
    expect(f.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  });

  test.each(["after-save", "after-append"])(
    "planted process crash %s is recovered on boot",
    async (point) => {
      const f = fixture();
      // A separate process commits real SQLite files then dies before the next save.
      const code = `
      import { openOutbox, fold } from ${JSON.stringify(join(import.meta.dir, "../src/outbox.ts"))};
      import { appendCapture } from ${JSON.stringify(join(import.meta.dir, "../src/append.ts"))};
      const db = openOutbox(${JSON.stringify(f.outbox)});
      const payload = ${JSON.stringify(f.payload)};
      fold(db, {type:'captured', payload, at:Date.now(), writer:true});
      ${point === "after-append" ? `appendCapture(payload, {sessionsDbPath:${JSON.stringify(f.sessions)}, readTimeoutMs:100});` : ""}
      process.exit(73);
    `;
      const child = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(73);
      expect(counts(f.sessions).runs).toBe(point === "after-save" ? 0 : 1);
      expect(readHealth(f.db, Date.now()).depth).toBe(2);
      // Boot the actual runtime; it chooses the writer from CAPTURE_CELL_MODE.
      const config = loadConfig({
        CAPTURE_CELL_MODE: "cell",
        CAPTURE_CELL_DB: f.outbox,
        SESSION_INDEX_PATH: f.sessions,
        CAPTURE_CELL_PORT: "1",
        CAPTURE_CELL_TOKEN: "test",
      });
      const cell = startCell({ ...config, port: 0, token: "test" });
      await cell.drain.settle();
      expect(counts(f.sessions).runs).toBe(1);
      expect(readVerdict(cell.db, "r1")).toMatchObject({
        verdict: "appended",
        chunk_count: counts(f.sessions).chunks,
      });
      // OTEL remains owed without a configured endpoint, with the original stable outcome.
      const event = cell.db
        .query("SELECT event_json FROM otel_pending WHERE run_id = 'r1'")
        .get() as { event_json: string };
      expect(JSON.parse(event.event_json)).toMatchObject({
        id: "capture-cell:r1:append",
        action: "capture.cell.append",
        metadata: { status: "appended", turn_count: 3 },
      });
      cell.stop();
    },
  );

  test("a missing blob goes dead without recording a fake append", async () => {
    const f = fixture();
    fold(f.db, {
      type: "captured",
      payload: { ...f.payload, jsonl_path: join(f.root, "missing") },
      at: Date.now(),
    });
    await f.drain.settle();
    expect(readHealth(f.db, Date.now()).dead).toBe(1);
    expect(readVerdict(f.db, "r1")).toBeNull();
  });
});

describe("handback", () => {
  test.each(["cell-first", "handback-first"] as const)(
    "in-flight append/handback race %s relies on memory dedupe",
    async (order) => {
      const f = fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cellStatuses: string[] = [];
      const handbackStatuses: string[] = [];
      const events: HandbackEvent[] = [];
      const drain = createDrain({
        db: f.db,
        now: Date.now,
        mode: "cell",
        tickMs: 60_000,
        appendStep: async (payload) => {
          // The drain has already checked isHandedBack. Hold the effect open
          // across a separate handback process, not just across drain selection.
          let observation =
            order === "cell-first"
              ? appendCapture(payload, { sessionsDbPath: f.sessions, readTimeoutMs: 100 })
              : undefined;
          entered.resolve();
          await release.promise;
          observation ??= appendCapture(payload, {
            sessionsDbPath: f.sessions,
            readTimeoutMs: 100,
          });
          cellStatuses.push(observation.observed);
          return observation;
        },
        shipOtel: async () => {},
        walCheck: () => ({ paused: false }),
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const event = (await request.json()) as HandbackEvent;
          events.push(event);
          try {
            handbackStatuses.push(indexWithWriter(f.sessions, event.data).status);
            return Response.json({ status: 200, ids: [event.id] });
          } catch {
            // Keep a planted broken dedupe on the ordinary handback failure
            // path, rather than turning it into an unhandled server exception.
            return Response.json({ status: 503 }, { status: 503 });
          }
        },
      });
      try {
        const capture = createCellHandler({
          db: f.db,
          drain,
          mode: "cell",
          token: "test",
          now: Date.now,
        });
        expect(
          (
            await capture(
              new Request("http://cell/capture", {
                method: "POST",
                headers: { authorization: "Bearer test", "x-capture-cell-mode": "cell" },
                body: JSON.stringify(f.payload),
              }),
            )
          ).status,
        ).toBe(202);
        await entered.promise;
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../src/cli.ts"), "handback", "--json"],
          {
            env: {
              PATH: process.env.PATH,
              CAPTURE_CELL_DB: f.outbox,
              INNGEST_URL: `http://127.0.0.1:${server.port}`,
              INNGEST_EVENT_KEY: "test",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const report = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(JSON.parse(report)).toMatchObject({ sent: ["r1"], failed: [] });
        release.resolve();
        await drain.settle();
        expect(events).toEqual([{ id: "r1", name: "memory/run.captured", data: f.payload }]);
        expect(cellStatuses).toEqual([order === "cell-first" ? "appended" : "already_indexed"]);
        expect(handbackStatuses).toEqual([
          order === "handback-first" ? "appended" : "already_indexed",
        ]);
        expect(counts(f.sessions)).toEqual({ runs: 1, chunks: 3 });
      } finally {
        release.resolve();
        await drain.settle();
        drain.stop();
        server.stop(true);
      }
    },
  );

  test("rollback cannot settle an old writer debt as a read-only shadow verdict", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now(), writer: true });
    const config = loadConfig({
      CAPTURE_CELL_MODE: "both",
      CAPTURE_CELL_DB: f.outbox,
      SESSION_INDEX_PATH: f.sessions,
    });
    const shadow = startCell({ ...config, port: 0, token: "test" });
    try {
      await shadow.drain.settle();
      expect(readVerdict(f.db, "r1")).toBeNull();
      expect(readHealth(f.db, Date.now()).depth).toBe(2);
      expect(counts(f.sessions).runs).toBe(0);
      expect(
        await handback(f.db, {
          dryRun: false,
          send: async (event) => {
            indexWithWriter(f.sessions, event.data);
          },
        }),
      ).toMatchObject({ sent: ["r1"] });
      expect(counts(f.sessions).runs).toBe(1);
    } finally {
      shadow.stop();
    }
  });

  test("an authoritative retry adopts a shadow marker already scheduled by the drain", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    const config = loadConfig({
      CAPTURE_CELL_MODE: "cell",
      CAPTURE_CELL_DB: f.outbox,
      SESSION_INDEX_PATH: f.sessions,
    });
    const writer = startCell({ ...config, port: 0, token: "test" });
    try {
      // startCell has scheduled a shadow read but yielded before executing it.
      fold(f.db, { type: "captured", payload: f.payload, at: Date.now(), writer: true });
      await writer.drain.settle();
      expect(counts(f.sessions).runs).toBe(1);
      const row = f.db.query("SELECT event_json FROM otel_pending").get() as { event_json: string };
      expect(JSON.parse(row.event_json).metadata.mode).toBe("cell");
    } finally {
      writer.stop();
    }
  });

  test("cutover does not silently promote historical shadow captures to writer work", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    const config = loadConfig({
      CAPTURE_CELL_MODE: "cell",
      CAPTURE_CELL_DB: f.outbox,
      SESSION_INDEX_PATH: f.sessions,
    });
    const writer = startCell({ ...config, port: 0, token: "test" });
    try {
      await writer.drain.settle();
      expect(counts(f.sessions).runs).toBe(0);
      expect(readVerdict(f.db, "r1")).toMatchObject({ verdict: "appended" });
      const row = f.db.query("SELECT event_json FROM otel_pending").get() as { event_json: string };
      expect(JSON.parse(row.event_json).metadata.mode).toBe("shadow");
      // A real client retry can straddle the flag flip. It must adopt the
      // stored payload and append, not merely re-ack a shadow prediction.
      const post = () =>
        fetch(`http://127.0.0.1:${writer.port}/capture`, {
          method: "POST",
          headers: { authorization: "Bearer test", "x-capture-cell-mode": "cell" },
          body: JSON.stringify(f.payload),
        });
      expect((await post()).status).toBe(202);
      await writer.drain.settle();
      expect(counts(f.sessions).runs).toBe(1);
      expect(await (await post()).json()).toMatchObject({ duplicate: true });
      await writer.drain.settle();
      expect(counts(f.sessions).runs).toBe(1);
    } finally {
      writer.stop();
    }
  });

  test("CLI dry-run and handback use the stored original event over HTTP", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    const events: HandbackEvent[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const event = (await request.json()) as HandbackEvent;
        events.push(event);
        indexWithWriter(f.sessions, event.data);
        return Response.json({ status: 200, ids: [event.id] });
      },
    });
    cleanups.push(() => server.stop(true));
    const run = async (args: string[], expectedExit = 0) => {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args, "--json"],
        {
          env: {
            PATH: process.env.PATH,
            CAPTURE_CELL_DB: f.outbox,
            SESSION_INDEX_PATH: f.sessions,
            INNGEST_URL: `http://127.0.0.1:${server.port}`,
            INNGEST_EVENT_KEY: "test",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(expectedExit);
      return text ? JSON.parse(text) : null;
    };
    expect(await run(["handback", "--dry_run"], 2)).toBeNull();
    expect(events).toHaveLength(0);
    expect(await run(["handback", "--dry-run"])).toMatchObject({
      dry_run: true,
      runs: ["r1"],
      sent: [],
    });
    expect(events).toHaveLength(0);
    expect(await run(["handback"])).toMatchObject({ sent: ["r1"] });
    expect(await run(["handback"])).toMatchObject({ runs: [] });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(f.payload.run_id);
    expect(counts(f.sessions).runs).toBe(1);
    expect(
      await run(["compare", "--since", "2026-01-01", "--direction", "index-to-cell"]),
    ).toMatchObject({ direction: "index-to-cell", verdicts: 1 });
  });

  test("dry-run changes nothing; handback round-trip and repeated command append exactly once", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    const sent: HandbackEvent[] = [];
    const send = async (event: HandbackEvent) => {
      sent.push(event);
      indexWithWriter(f.sessions, event.data);
    };
    expect(await handback(f.db, { dryRun: true, send })).toMatchObject({ runs: ["r1"], sent: [] });
    expect(f.db.query("SELECT COUNT(*) AS n FROM handbacks").get()).toEqual({ n: 0 });
    expect(sent).toHaveLength(0);
    // The scheduled append must re-check the transfer marker after its yield.
    f.drain.kick();
    expect(
      await handback(f.db, {
        dryRun: false,
        send: async (event) => {
          await f.drain.settle();
          expect(counts(f.sessions).runs).toBe(0);
          await send(event);
        },
      }),
    ).toMatchObject({ runs: ["r1"], sent: ["r1"], failed: [] });
    const original = counts(f.sessions);
    expect(original.runs).toBe(1);
    expect(sent[0]).toEqual({ id: "r1", name: "memory/run.captured", data: f.payload });
    expect(await handback(f.db, { dryRun: false, send })).toMatchObject({ runs: [], sent: [] });
    expect(sent).toHaveLength(1);
    expect(replay(f.db, "r1", Date.now())).toBe(false);
    await f.drain.settle();
    expect(counts(f.sessions)).toEqual(original);
    expect(readHealth(f.db, Date.now()).depth).toBe(0);
  });

  test("lost handback acknowledgement retries its original event and cannot append twice", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    const sent: HandbackEvent[] = [];
    const result = await handback(f.db, {
      dryRun: false,
      send: async (event) => {
        sent.push(event);
        indexWithWriter(f.sessions, event.data);
        throw new Error("lost ack");
      },
    });
    expect(result.failed).toEqual(["r1"]);
    const original = counts(f.sessions);
    await f.drain.settle();
    expect(f.shipped).toHaveLength(0);
    expect(await handback(f.db, { dryRun: true, send: async () => {} })).toMatchObject({
      runs: ["r1"],
    });
    expect(
      await handback(f.db, {
        dryRun: false,
        send: async (event) => {
          sent.push(event);
          expect(indexWithWriter(f.sessions, event.data).status).toBe("already_indexed");
        },
      }),
    ).toMatchObject({ sent: ["r1"] });
    expect(sent[1]).toEqual(sent[0]);
    expect(counts(f.sessions)).toEqual(original);
  });

  test("dead appends are handed back too; settled appends are excluded", async () => {
    const f = fixture();
    fold(f.db, { type: "captured", payload: f.payload, at: Date.now() });
    fold(f.db, {
      type: "step_failed",
      run_id: "r1",
      step: "append",
      at: Date.now(),
      failure: { class: "deterministic", reason: "missing blob" },
    });
    const report = await handback(f.db, {
      dryRun: false,
      send: async (event) => {
        indexWithWriter(f.sessions, event.data);
      },
    });
    expect(report.sent).toEqual(["r1"]);
    expect(readHealth(f.db, Date.now()).dead).toBe(0);
  });

  test("transport preserves the original id and rejects non-acknowledgements", async () => {
    const f = fixture();
    const event: HandbackEvent = { id: "r1", name: "memory/run.captured", data: f.payload };
    const sender = createHandbackSender(
      { INNGEST_URL: "http://events", INNGEST_EVENT_KEY: "test" },
      (async (url, init) => {
        expect(String(url)).toBe("http://events/e/test");
        expect(JSON.parse(init!.body as string)).toEqual(event);
        return Response.json({ status: 200, ids: ["accepted"] });
      }) as typeof fetch,
    );
    await sender(event);
    const noAck = createHandbackSender(
      { INNGEST_URL: "http://events", INNGEST_EVENT_KEY: "test" },
      (async (_url: unknown, _init?: RequestInit) =>
        Response.json({ status: 500 })) as typeof fetch,
    );
    await expect(noAck(event)).rejects.toThrow("not acknowledged");
  });
});

describe("reverse shadow", () => {
  test("keyset pages release every read snapshot before the next page", async () => {
    const f = fixture();
    const now = Date.now();
    indexWithWriter(f.sessions, f.payload, now);
    const writer = new Database(f.sessions);
    try {
      const copy = writer.query(`INSERT INTO runs
        SELECT ?, user_id, machine_id, agent_runtime, conversation_id, parent_run_id,
          source_identity, prefix_group_identity, verdict, started_at, captured_at,
          ended_at, jsonl_path, jsonl_bytes, jsonl_sha256, turn_count, chunk_count,
          from_offset, to_offset, tags_json FROM runs WHERE run_id = 'r1'`);
      writer
        .transaction(() => {
          for (let i = 0; i < 450; i++) copy.run(`page-${i}`);
        })
        .immediate();
      const pages = readIndexPages(f.sessions, Date.UTC(2026, 0, 1), 100);
      const ids: string[] = [];
      for (const page of pages) {
        expect(page.length).toBeLessThanOrEqual(200);
        ids.push(...page.map((row) => row.run_id));
        // A held WAL snapshot would make TRUNCATE busy. This also exercises
        // rows sharing ended_at across page boundaries (rowid tie-breaker).
        writer.query("UPDATE runs SET chunk_count = chunk_count WHERE run_id = 'r1'").run();
        expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
      }
      expect(ids).toHaveLength(451);
      expect(new Set(ids).size).toBe(451);
      expect(compareIndexToCell(f.db, f.sessions, Date.UTC(2026, 0, 1), now).unseen).toBe(451);
    } finally {
      writer.close(false);
    }
  });

  test("index-to-cell reports matches, unseen, pending and count mismatches", async () => {
    const f = fixture();
    const now = Date.now();
    const since = Date.UTC(2026, 0, 1);
    fold(f.db, { type: "captured", payload: f.payload, at: now });
    await f.drain.settle();
    expect(compareIndexToCell(f.db, f.sessions, since, now)).toMatchObject({
      direction: "index-to-cell",
      matched: 1,
      unseen: 0,
    });
    const unseen = writeCapture(f.root, "unseen", turnLines(2));
    indexWithWriter(f.sessions, unseen, now);
    const pending = writeCapture(f.root, "pending", turnLines(2));
    indexWithWriter(f.sessions, pending, now);
    fold(f.db, { type: "captured", payload: pending, at: now });
    expect(compareIndexToCell(f.db, f.sessions, since, now)).toMatchObject({
      matched: 1,
      unseen: 1,
      unseen_runs: ["unseen"],
      pending_runs: ["pending"],
    });
    const db = new Database(f.sessions);
    db.query("UPDATE runs SET chunk_count = chunk_count + 10 WHERE run_id = 'r1'").run();
    db.close(false);
    const report = compareIndexToCell(f.db, f.sessions, since, now + 11 * 60_000);
    expect(report.computed_mismatched).toBe(1);
    expect(report.verdict_mismatched).toBe(1);
  });
});
