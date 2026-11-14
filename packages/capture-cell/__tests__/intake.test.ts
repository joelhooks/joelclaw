import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  closeSessionIndexConnections,
  peekSessionIndexConnection,
  sessionIndexConnectionStats,
  writeRunBlob,
} from "@joelclaw/memory";
import { Hono } from "hono";
import {
  DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES,
  registerRunCaptureRoute,
} from "../../system-bus/src/routes/run-capture";
import { appenderBackoff, createAppender } from "../src/intake/appender";
import { main as intakeMain } from "../src/intake/cli";
import {
  createLegacySender,
  drainRemoteToLegacy,
  drainToLegacy,
  transferRemoteBack,
} from "../src/intake/legacy";
import {
  assertLegacyMinimumSize,
  LEGACY_MAX_INLINE_BYTES,
  legacyBodyMetadata,
} from "../src/intake/legacy-body";
import { createIntakeHandler, type IntakeServerOptions } from "../src/intake/server";
import {
  ACK_RETENTION_MS,
  acknowledge,
  blobPath,
  getRow,
  intakeHealth,
  ORPHAN_RETENTION_MS,
  openIntake,
  owedPage,
  pruneIntake,
  sweepOrphanBlobs,
  transferBackToAppender,
  transferToLegacy,
} from "../src/intake/store";
import { inlineBody } from "../src/intake/stream";
import { createSessionsDb, indexWithWriter, SOURCE, turnLines } from "./fixtures";

const cleanups: Array<() => void> = [];
afterEach(() => {
  closeSessionIndexConnections();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const principal = { user_id: "user", machine_id: "machine" };
function fixture(overrides: Partial<IntakeServerOptions> = {}) {
  const root = mkdtempSync(
    join(process.env.CAPTURE_TEST_ROOT ?? join(homedir(), ".cache"), "capture-intake-test-"),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = openIntake(join(root, "intake"));
  cleanups.push(() => store.close());
  const handler = createIntakeHandler({
    store,
    ingestToken: "ingest",
    pullToken: "pull",
    principal,
    ...overrides,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => {
    void server.stop(true);
  });
  const url = `http://127.0.0.1:${server.port}`;
  const sessions = join(root, "sessions.db");
  const post = (data: unknown) =>
    handler(
      new Request(`${url}/api/runs`, {
        method: "POST",
        headers: { authorization: "Bearer ingest" },
        body: JSON.stringify({ machine_id: "machine", ...(data as object) }),
      }),
    );
  const appender = (options: Partial<Parameters<typeof createAppender>[0]> = {}) =>
    createAppender({
      url,
      token: "pull",
      runDir: join(root, "indexed"),
      sessionsDbPath: sessions,
      compareOnly: false,
      load: () => ({ load1: 0, cpus: 16 }),
      ...options,
    });
  return { root, store, server, url, sessions, post, appender, handler };
}
function requestBody(run_id = "r1", jsonl = turnLines(3)) {
  return {
    run_id,
    agent_runtime: "claude-code",
    started_at: 1,
    jsonl,
    source_identity: SOURCE,
    from_offset: 0,
    to_offset: Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
  };
}
function runCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  } finally {
    db.close(false);
  }
}

describe("streamed capture intake", () => {
  test("202 follows blob fsync and FULL outbox commit; intake never opens the index", async () => {
    const stages: string[] = [];
    const f = fixture({
      beforeBlobSync: () => {
        stages.push("before-sync");
        expect(owedPage(f.store)).toHaveLength(0);
      },
      afterBlobSync: () => {
        stages.push("synced");
        expect(owedPage(f.store)).toHaveLength(0);
      },
      afterCommit: () => {
        stages.push("committed");
        expect(owedPage(f.store)).toHaveLength(1);
      },
    });
    const response = await f.post(requestBody());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      run_id: "r1",
      machine_id: "machine",
      to_offset: requestBody().to_offset,
      status: "accepted",
    });
    expect(stages).toEqual(["before-sync", "synced", "committed"]);
    expect(f.store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(f.store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const row = owedPage(f.store)[0]!;
    expect(readFileSync(blobPath(f.store, row.id), "utf8")).toBe(requestBody().jsonl);
    expect(existsSync(f.sessions)).toBe(false);
    expect(intakeHealth(f.store).blob_disk_free_bytes).toBeGreaterThan(0);
  });
  test("DB and blob locations are independent and health measures the blob filesystem", () => {
    const f = fixture();
    const separate = openIntake(join(f.root, "state"), {
      dbPath: join(f.root, "db", "intake.db"),
      blobDir: join(f.root, "mounted-blobs"),
    });
    try {
      expect(existsSync(join(f.root, "db", "intake.db"))).toBe(true);
      expect(separate.blobDir).toBe(join(f.root, "mounted-blobs"));
      expect(intakeHealth(separate).blob_disk_free_bytes).toBeGreaterThan(0);
      expect(existsSync(join(f.root, "mounted-blobs", "intake.db"))).toBe(false);
    } finally {
      separate.close();
    }
  });
  test("four active ingests bound admission; excess bodies receive retryable 503", async () => {
    const f = fixture();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending: Array<Promise<Response>> = [];
    try {
      for (let i = 0; i < 4; i++) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            controller.enqueue(
              Buffer.from(
                JSON.stringify({
                  machine_id: "test",
                  agent_runtime: "pi",
                  run_id: `held-${i}`,
                  jsonl: "x",
                }),
              ),
            );
          },
        });
        pending.push(
          f.handler(
            new Request(`${f.url}/api/runs`, {
              method: "POST",
              headers: { authorization: "Bearer ingest" },
              body: stream,
            }),
          ),
        );
      }
      expect((await f.post(requestBody())).status).toBe(503);
      expect(owedPage(f.store)).toHaveLength(0);
    } finally {
      for (const controller of controllers) controller.close();
    }
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([
      202, 202, 202, 202,
    ]);
  });
  test("failure before fsync returns 503 with no row", async () => {
    const f = fixture({
      beforeBlobSync: () => {
        throw new Error("planted fsync boundary failure");
      },
    });
    expect((await f.post(requestBody())).status).toBe(503);
    expect(owedPage(f.store)).toHaveLength(0);
  });
  test("a real process crash before fsync cannot acknowledge or leave a row", async () => {
    const f = fixture();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "intake-crash-child.ts"), f.store.root],
      {
        env: { PATH: process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      const { port } = JSON.parse(Buffer.from(first.value!).toString("utf8")) as { port: number };
      reader.releaseLock();
      await expect(
        fetch(`http://127.0.0.1:${port}/api/runs`, {
          method: "POST",
          headers: { authorization: "Bearer ingest" },
          body: JSON.stringify({ ...requestBody(), machine_id: "synthetic" }),
        }),
      ).rejects.toThrow();
      expect(await child.exited).not.toBe(0);
      expect(readFileSync(join(f.store.root, "crash-boundary"), "utf8")).toBe("before-fsync");
      expect(owedPage(f.store)).toHaveLength(0);
    } finally {
      child.kill();
      await child.exited;
    }
  });
  test("payload machine/runtime identify senders; client user IDs cannot replace the authenticated owner", async () => {
    const f = fixture();
    expect(
      (await f.post({ ...requestBody(), machine_id: "payload-machine", user_id: "untrusted-user" }))
        .status,
    ).toBe(202);
    expect(owedPage(f.store)[0]!.metadata).toMatchObject({
      machine_id: "payload-machine",
      user_id: "user",
      agent_runtime: "claude-code",
    });
    expect(
      (await f.post({ agent_runtime: "pi", run_id: "bad-machine", jsonl: "x", machine_id: null }))
        .status,
    ).toBe(400);
  });
  test("lost 202 after commit retries as the same durable row", async () => {
    let fail = true;
    const f = fixture({
      afterCommit: () => {
        if (fail) {
          fail = false;
          throw new Error("lost reply");
        }
      },
    });
    expect((await f.post(requestBody())).status).toBe(503);
    const row = owedPage(f.store)[0]!;
    const retry = await f.post(requestBody());
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: row.id, run_id: "r1" });
    expect(owedPage(f.store)).toHaveLength(1);
  });
  test("duplicates on run ID and cursor reuse the original run and reject changed bytes", async () => {
    const f = fixture();
    const first = await (await f.post(requestBody())).json();
    expect(await (await f.post(requestBody())).json()).toEqual(first);
    expect(await (await f.post(requestBody("another-id"))).json()).toEqual(first);
    expect((await f.post(requestBody("r1", turnLines(3, 10)))).status).toBe(409);
    expect(owedPage(f.store)).toHaveLength(1);
  });
  test("a grown retry returns the original cursor receipt, then accepts only its new tail", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    const original = requestBody();
    await f.post(original);
    const full = turnLines(4);
    const prefix = await f.post(requestBody("r1", full));
    expect(prefix.status).toBe(202);
    expect(await prefix.json()).toMatchObject({
      run_id: "r1",
      to_offset: original.to_offset,
      status: "accepted_prefix",
    });
    expect(owedPage(f.store)).toHaveLength(1);
    const tail = full.slice(original.jsonl.length);
    const next = await f.post({
      ...requestBody("r2", tail),
      from_offset: original.to_offset,
      to_offset: Buffer.byteLength(full),
    });
    expect(next.status).toBe(202);
    expect((await f.appender().tick()).processed).toBe(2);
    expect(runCount(f.sessions)).toBe(2);
    expect(intakeHealth(f.store).depth).toBe(0);
  });
  test("cursor clients may omit the ID; non-cursor clients must provide one", async () => {
    const f = fixture();
    const body = { ...requestBody(), run_id: undefined };
    const a = (await (await f.post(body)).json()) as { run_id: string };
    const b = await (await f.post(body)).json();
    expect(b).toEqual(a);
    expect(a.run_id).toHaveLength(64);
    expect((await f.post({ agent_runtime: "pi", jsonl: "x" })).status).toBe(400);
    expect(
      (await f.post({ agent_runtime: "pi", jsonl: "x", source_identity: SOURCE })).status,
    ).toBe(400);
  });
  test("JSON escapes and UTF-8 decode correctly across every byte boundary", async () => {
    const f = fixture();
    const jsonl = 'π 🐀 "quoted" \\ \b\f\n\r\t / \u0000';
    const wire = Buffer.from(
      JSON.stringify({
        agent_runtime: "pi",
        machine_id: "machine",
        run_id: "escaped",
        tags: ["{braces}", "jsonl"],
        jsonl,
      }).replace("🐀", "\\ud83d\\udc00"),
    );
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < wire.length) c.enqueue(wire.subarray(i, ++i));
        else c.close();
      },
    });
    const response = await f.handler(
      new Request(`${f.url}/api/runs`, {
        method: "POST",
        headers: { authorization: "Bearer ingest" },
        body: stream,
      }),
    );
    expect(response.status).toBe(202);
    const row = owedPage(f.store)[0]!;
    expect(readFileSync(blobPath(f.store, row.id), "utf8")).toBe(jsonl);
  });
  test.each([
    '{"jsonl":"a","jsonl":"b","run_id":"r","agent_runtime":"pi"}',
    '{"jsonl":"\\x","run_id":"r","agent_runtime":"pi"}',
    '{"jsonl":"x"} trailing',
  ])("rejects malformed or duplicate JSONL without rows: %s", async (wire) => {
    const f = fixture();
    expect(
      (
        await f.handler(
          new Request(`${f.url}/api/runs`, {
            method: "POST",
            headers: { authorization: "Bearer ingest" },
            body: wire,
          }),
        )
      ).status,
    ).toBe(400);
    expect(owedPage(f.store)).toHaveLength(0);
  });
  test("enforces the streamed wire cap and bounds metadata independently", async () => {
    const f = fixture({ maxBytes: 100 });
    expect(
      (await f.post({ run_id: "large", agent_runtime: "pi", jsonl: "x".repeat(101) })).status,
    ).toBe(413);
    expect(owedPage(f.store)).toHaveLength(0);
    const g = fixture();
    expect(
      (
        await g.post({
          run_id: "metadata",
          agent_runtime: "pi",
          ignored: "x".repeat(65537),
          jsonl: "x",
        })
      ).status,
    ).toBe(413);
  });
  test("pull auth, bounded keyset pages, streamed blob and digest-bound idempotent ack", async () => {
    const f = fixture();
    await f.post(requestBody());
    await f.post({ agent_runtime: "pi", run_id: "r2", jsonl: "two" });
    const headers = { authorization: "Bearer pull" };
    expect(
      (await fetch(`${f.url}/owed`, { headers: { authorization: "Bearer ingest" } })).status,
    ).toBe(401);
    const first = (await (await fetch(`${f.url}/owed?limit=1`, { headers })).json()) as {
      items: Array<{ id: string; seq: number }>;
    };
    const second = (await (
      await fetch(`${f.url}/owed?after=${first.items[0]!.seq}&limit=1`, { headers })
    ).json()) as { items: Array<{ id: string }> };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await fetch(`${f.url}/owed?limit=101`, { headers })).status).toBe(400);
    const row = owedPage(f.store)[0]!;
    expect(await (await fetch(`${f.url}/blob/${row.id}`, { headers })).text()).toBe(
      requestBody().jsonl,
    );
    expect(acknowledge(f.store, row.id, "bad", 100)).toBe(false);
    expect(acknowledge(f.store, row.id, row.metadata.jsonl_sha256, 100)).toBe(true);
    expect(acknowledge(f.store, row.id, row.metadata.jsonl_sha256, 200)).toBe(true);
    expect(getRow(f.store, row.id)?.acked_at).toBe(100);
    expect(owedPage(f.store)).toHaveLength(1);
  });
  test("prune waits seven days after ack and always skips unacknowledged blobs", async () => {
    const f = fixture();
    await f.post(requestBody());
    await f.post({ agent_runtime: "pi", run_id: "owed", jsonl: "owed" });
    const [row, owed] = owedPage(f.store);
    acknowledge(f.store, row!.id, row!.metadata.jsonl_sha256, 1000);
    expect(pruneIntake(f.store, 1000 + ACK_RETENTION_MS - 1)).toEqual([]);
    expect(pruneIntake(f.store, 1000 + ACK_RETENTION_MS)).toEqual([row!.id]);
    expect(existsSync(blobPath(f.store, owed!.id))).toBe(true);
    expect(owedPage(f.store)).toHaveLength(1);
    expect((await f.post(requestBody())).status).toBe(202);
    expect(owedPage(f.store)).toHaveLength(1);
    expect(
      (
        await f.handler(
          new Request(`${f.url}/blob/${row!.id}`, { headers: { authorization: "Bearer pull" } }),
        )
      ).status,
    ).toBe(410);
  });
});

describe("pull appender", () => {
  test("writer keeps one canonical handle across ticks and emits append duration/stages", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    const before = sessionIndexConnectionStats().opens;
    const events: Array<{ action: string; extra?: Record<string, unknown> }> = [];
    const worker = f.appender({
      telemetry: { emit: (action, _detail, extra) => events.push({ action, extra }) },
    });
    await f.post(requestBody("cached-first"));
    expect((await worker.tick()).failed).toBe(0);
    await f.post({ run_id: "cached-next", agent_runtime: "pi", jsonl: turnLines(1) });
    expect((await worker.tick()).failed).toBe(0);
    expect(sessionIndexConnectionStats().opens - before).toBe(1);
    const appends = events.filter((event) => event.action === "memory.run.session-index.append");
    expect(appends).toHaveLength(2);
    expect(appends[0]!.extra).toMatchObject({
      component: "capture-appender",
      status: "appended",
      run_id: "cached-first",
    });
    expect(Number(appends[0]!.extra!.duration_ms)).toBeGreaterThan(0);
    expect(appends[0]!.extra!.phase_ms).toHaveProperty("schema_ms");
    expect(appends[1]!.extra!.phase_ms).not.toHaveProperty("schema_ms");
    const missing = events.filter(
      (event) => event.action === "capture.session_index.cursor_index_missing",
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]!.extra).toEqual({
      command: "capture-intake index-migrate --db <sessions-db>",
    });
    expect(
      peekSessionIndexConnection(f.sessions)!
        .query("SELECT 1 FROM sqlite_master WHERE name='runs_source_cursor_to'")
        .get(),
    ).toBeNull();
    expect(runCount(f.sessions)).toBe(2);
  });
  test("replacement is fenced, remains owed and emits one sanitized replacement alarm", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    const events: Array<{ action: string; extra?: Record<string, unknown> }> = [];
    const worker = f.appender({
      telemetry: {
        emit: (action, _detail, extra) => {
          events.push({ action, extra });
        },
      },
    });
    await f.post(requestBody("before-replacement"));
    expect((await worker.tick()).processed).toBe(1);
    peekSessionIndexConnection(f.sessions)!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    renameSync(f.sessions, `${f.sessions}.old`);
    createSessionsDb(f.sessions);
    await f.post({ run_id: "after-replacement", agent_runtime: "pi", jsonl: turnLines(1) });
    expect((await worker.tick()).failed).toBe(1);
    expect((await worker.tick()).failed).toBe(1);
    const alarms = events.filter(
      (x) => x.action === "capture.intake.appender.session_index_replaced",
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.extra).toEqual({
      run_id: "after-replacement",
      code: "SESSION_INDEX_REPLACED",
    });
    expect(owedPage(f.store)).toHaveLength(1);
    expect(runCount(f.sessions)).toBe(0);
  });
  test("telemetry failure never blocks commit or ack", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    expect(
      await f
        .appender({
          telemetry: {
            emit: () => {
              throw new Error("sink unavailable");
            },
          },
        })
        .tick(),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(owedPage(f.store)).toEqual([]);
    expect(runCount(f.sessions)).toBe(1);
  });
  test.each([
    ["tagged-synthetic-run", "ordinary-machine", ["synthetic:intake-smoke"]],
    ["old-smoke-without-prefix", "intake-smoke", undefined],
  ])(
    "acks and skips explicitly synthetic capture %s from %s without opening index or blob",
    async (run_id, machine_id, tags) => {
      const f = fixture();
      await f.post({ run_id, machine_id, tags, agent_runtime: "pi", jsonl: turnLines(1) });
      const row = owedPage(f.store)[0]!;
      const observations: string[] = [];
      const requests: string[] = [];
      const worker = f.appender({
        observe: (_row, observation) => observations.push(observation.observed),
        fetch: (async (url, init) => {
          requests.push(new URL(String(url)).pathname);
          return fetch(url, init);
        }) as typeof fetch,
      });
      expect(await worker.tick()).toMatchObject({ processed: 1, failed: 0 });
      expect(observations).toEqual(["smoke-skipped"]);
      expect(requests).toEqual(["/owed", "/ack"]);
      expect(getRow(f.store, row.id)?.acked_at).not.toBeNull();
      expect(owedPage(f.store)).toEqual([]);
      expect(existsSync(f.sessions)).toBe(false);
      expect(existsSync(join(f.root, "indexed"))).toBe(false);
    },
  );
  test("real smoke-prefixed run and similar machine/tag names are indexed", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post({
      run_id: "smoke-real-run",
      machine_id: "intake-smoke-real",
      agent_runtime: "pi",
      jsonl: turnLines(1),
      tags: ["synthetic:intake-smoke-real"],
    });
    const observations: string[] = [];
    expect(
      await f
        .appender({ observe: (_row, observation) => observations.push(observation.observed) })
        .tick(),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(observations).toEqual(["appended"]);
    expect(runCount(f.sessions)).toBe(1);
    expect(owedPage(f.store)).toEqual([]);
  });
  test("compare-only reports smoke skip but leaves debt and index untouched", async () => {
    const f = fixture();
    await f.post({
      run_id: "smoke-compare",
      machine_id: "intake-smoke",
      agent_runtime: "pi",
      jsonl: turnLines(1),
    });
    const observations: string[] = [];
    expect(
      await f
        .appender({
          compareOnly: true,
          observe: (_row, observation) => observations.push(observation.observed),
        })
        .tick(),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(observations).toEqual(["smoke-skipped"]);
    expect(owedPage(f.store)).toHaveLength(1);
    expect(existsSync(f.sessions)).toBe(false);
    expect(existsSync(join(f.root, "indexed"))).toBe(false);
  });
  test("lost smoke ack remains retryable without appending", async () => {
    const f = fixture();
    await f.post({
      run_id: "smoke-lost-ack",
      machine_id: "intake-smoke",
      agent_runtime: "pi",
      jsonl: turnLines(1),
    });
    let lose = true;
    const observations: string[] = [];
    const worker = f.appender({
      observe: (_row, observation) => observations.push(observation.observed),
      fetch: (async (url, init) => {
        if (String(url).endsWith("/ack") && lose) {
          lose = false;
          throw new Error("lost smoke ack");
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect((await worker.tick()).failed).toBe(1);
    expect(owedPage(f.store)).toHaveLength(1);
    expect(observations).toEqual([]);
    expect((await worker.tick()).failed).toBe(0);
    expect(owedPage(f.store)).toEqual([]);
    expect(observations).toEqual(["smoke-skipped"]);
    expect(existsSync(f.sessions)).toBe(false);
  });
  test("remote rollback settles legacy-owned smoke with its capability and never forwards", async () => {
    const f = fixture();
    await f.post({
      run_id: "smoke-legacy",
      machine_id: "intake-smoke",
      agent_runtime: "pi",
      jsonl: turnLines(1),
    });
    const row = owedPage(f.store)[0]!;
    expect((await transferToLegacy(f.store, row.id, row.metadata.jsonl_sha256)).transferred).toBe(
      true,
    );
    let forwarded = false;
    expect(
      await f
        .appender({
          deliverLegacy: async () => {
            forwarded = true;
          },
        })
        .tick(),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(forwarded).toBe(false);
    expect(owedPage(f.store, 0, 100, true)).toEqual([]);
    expect(existsSync(f.sessions)).toBe(false);
    expect(existsSync(join(f.root, "indexed"))).toBe(false);
  });
  test("lost ack before intake commit re-appends idempotently under the original run ID", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    let lose = true;
    const verdicts: string[] = [];
    const worker = f.appender({
      observe: (_row, observation) => verdicts.push(observation.observed),
      fetch: (async (url, init) => {
        if (String(url).endsWith("/ack") && lose) {
          lose = false;
          throw new Error("planted unreachable ack");
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect((await worker.tick()).failed).toBe(1);
    expect(runCount(f.sessions)).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(1);
    expect((await worker.tick()).failed).toBe(0);
    expect(verdicts).toEqual(["appended", "already_indexed"]);
    expect(runCount(f.sessions)).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(0);
  });
  test("lost ack after intake commit is already settled", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    const worker = f.appender({
      fetch: (async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).endsWith("/ack")) {
          await response.body?.cancel();
          throw new Error("lost ack reply");
        }
        return response;
      }) as typeof fetch,
    });
    expect((await worker.tick()).failed).toBe(1);
    expect((await worker.tick()).processed).toBe(0);
    expect(runCount(f.sessions)).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(0);
  });
  test("compare-only leaves the index bytes and intake debt untouched", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    const before = readFileSync(f.sessions);
    const observations: string[] = [];
    const worker = f.appender({
      compareOnly: true,
      observe: (_row, result) => observations.push(result.observed),
    });
    expect((await worker.tick()).processed).toBe(1);
    expect(readFileSync(f.sessions)).toEqual(before);
    expect(runCount(f.sessions)).toBe(0);
    expect(intakeHealth(f.store).depth).toBe(1);
    expect(observations).toEqual(["appended"]);
  });
  test("a changed blob never reaches the index or an ack", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    const worker = f.appender({
      fetch: (async (url, init) =>
        String(url).includes("/blob/")
          ? new Response("bad bytes")
          : fetch(url, init)) as typeof fetch,
    });
    expect((await worker.tick()).failed).toBe(1);
    expect(runCount(f.sessions)).toBe(0);
    expect(intakeHealth(f.store).depth).toBe(1);
  });
  test("unreachable intake retries indefinitely with capped backoff until cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const waits: number[] = [];
    let attempts = 0;
    const worker = f.appender({
      baseBackoffMs: 10,
      maxBackoffMs: 40,
      random: () => 0,
      fetch: (async () => {
        attempts++;
        throw new Error("intake unavailable");
      }) as unknown as typeof fetch,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 6) controller.abort();
      },
    });
    await worker.run(controller.signal);
    expect(attempts).toBe(6);
    expect(waits).toEqual([5, 10, 20, 20, 20, 20]);
    expect(worker.state()).toBe("stopped");
    expect(appenderBackoff(100, 1000, 300000, () => 1)).toBe(300000);
  });
  test("high-load alarm entry / ten-minute reminder is independent of the row budget", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 3; i++)
      await f.post({ run_id: `trickle-${i}`, agent_runtime: "claude-code", jsonl: turnLines(1) });
    let clock = 0,
      load1 = 16;
    const alarms: Array<Record<string, unknown> | undefined> = [];
    const worker = f.appender({
      load: () => ({ load1, cpus: 16 }),
      now: () => clock,
      loadBudgetMs: 0, // Isolate the alarm clock while retaining the at-least-one-row guarantee.
      telemetry: {
        emit: (action, _detail, extra) => {
          if (action === "capture.intake.appender.load_gated") alarms.push(extra);
        },
      },
    });
    const first = await worker.tick();
    expect(first).toMatchObject({ processed: 1, failed: 0, paused: true, pauseReason: "load" });
    expect(first.after).toBe(1);
    expect(runCount(f.sessions)).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(2);
    expect(alarms).toEqual([{ load: 1, load1: 16, cpus: 16, depth: 3 }]);
    clock = 599999;
    const second = await worker.tick(first.after);
    expect(second.processed).toBe(1);
    expect(second.after).toBe(2);
    expect(alarms).toHaveLength(1);
    clock = 600000;
    const third = await worker.tick(second.after);
    expect(third.processed).toBe(1);
    expect(third.after).toBe(3);
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!.depth).toBe(1);
    expect(runCount(f.sessions)).toBe(3);
    expect(intakeHealth(f.store).depth).toBe(0);
    load1 = 0;
    expect((await worker.tick()).paused).toBe(false);
    load1 = 16;
    await worker.tick();
    expect(alarms).toHaveLength(3);
  });
  test("sustained high-load run yields a fixed two seconds instead of exponential starvation", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 6; i++)
      await f.post({
        run_id: `steady-trickle-${i}`,
        agent_runtime: "claude-code",
        jsonl: turnLines(1),
      });
    const controller = new AbortController();
    const waits: number[] = [];
    let clock = 0;
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      now: () => clock,
      observe: () => {
        clock += 3000;
      },
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 6) controller.abort();
      },
    });
    await worker.run(controller.signal);
    expect(waits).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(runCount(f.sessions)).toBe(6);
    expect(intakeHealth(f.store).depth).toBe(0);
    expect(worker.state()).toBe("stopped");
  });
  test("load becoming high mid-page honors elapsed budget; recovery restores full speed", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 3; i++)
      await f.post({ run_id: `rising-${i}`, agent_runtime: "claude-code", jsonl: turnLines(1) });
    let load1 = 0,
      observed = 0,
      clock = 0;
    const worker = f.appender({
      load: () => ({ load1, cpus: 16 }),
      now: () => clock,
      loadBudgetMs: 3000,
      observe: () => {
        if (++observed === 1) {
          clock += 3000;
          load1 = 16;
        }
      },
    });
    const first = await worker.tick();
    expect(first).toMatchObject({ processed: 1, paused: true, pauseReason: "load", after: 1 });
    load1 = 0;
    expect(await worker.tick(first.after)).toMatchObject({ processed: 2, paused: false });
  });
  test("elapsed time on a failed attempt consumes the high-load budget too", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 3; i++)
      await f.post({
        run_id: `failed-trickle-${i}`,
        agent_runtime: "claude-code",
        jsonl: turnLines(1),
      });
    let blobs = 0,
      clock = 0;
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      now: () => clock,
      fetch: (async (url, init) => {
        if (new URL(String(url)).pathname.startsWith("/blob/")) {
          blobs++;
          clock += 3000;
          return new Response("planted unavailable blob", { status: 503 });
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect(await worker.tick()).toMatchObject({
      processed: 0,
      failed: 1,
      paused: true,
      pauseReason: "load",
      after: 1,
    });
    expect(blobs).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(3);
  });
  test.each([
    { cost: 1000, perTick: 3 },
    { cost: 3500, perTick: 1 },
  ])("high load uses the default 3s tick budget with $cost ms rows", async ({ cost, perTick }) => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 7; i++)
      await f.post({
        run_id: `budget-${cost}-${i}`,
        agent_runtime: "claude-code",
        jsonl: turnLines(1),
      });
    let clock = 0;
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      now: () => clock,
      observe: () => {
        clock += cost;
      },
    });
    const first = await worker.tick();
    expect(first).toMatchObject({
      processed: perTick,
      failed: 0,
      paused: true,
      pauseReason: "load",
      after: perTick,
    });
    expect(clock).toBe(perTick * cost);
    expect(runCount(f.sessions)).toBe(perTick);
    expect(intakeHealth(f.store).depth).toBe(7 - perTick);
    const second = await worker.tick(first.after);
    expect(second).toMatchObject({
      processed: perTick,
      failed: 0,
      paused: true,
      pauseReason: "load",
      after: 2 * perTick,
    });
    expect(runCount(f.sessions)).toBe(2 * perTick);
    expect(intakeHealth(f.store).depth).toBe(7 - 2 * perTick);
    expect(second.completed).not.toEqual(first.completed);
  });
  test("budget starts before page I/O but always attempts one row even if already expired", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 3; i++)
      await f.post({ run_id: `slow-page-${i}`, agent_runtime: "claude-code", jsonl: turnLines(1) });
    let clock = 0;
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      now: () => clock,
      fetch: (async (url, init) => {
        if (new URL(String(url)).pathname === "/owed") clock += 4000;
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect(await worker.tick()).toMatchObject({
      processed: 1,
      failed: 0,
      after: 1,
      paused: true,
      pauseReason: "load",
    });
    expect(runCount(f.sessions)).toBe(1);
    expect(intakeHealth(f.store).depth).toBe(2);
  });
  test("high-load budget is injectable and does not limit normal-load throughput", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    for (let i = 0; i < 6; i++)
      await f.post({
        run_id: `custom-budget-${i}`,
        agent_runtime: "claude-code",
        jsonl: turnLines(1),
      });
    let clock = 0,
      load1 = 16;
    const worker = f.appender({
      load: () => ({ load1, cpus: 16 }),
      now: () => clock,
      loadBudgetMs: 2000,
      observe: () => {
        clock += 1000;
      },
    });
    const first = await worker.tick();
    expect(first).toMatchObject({ processed: 2, after: 2, paused: true, pauseReason: "load" });
    load1 = 0;
    expect(await worker.tick(first.after)).toMatchObject({ processed: 4, after: 6, paused: false });
    expect(intakeHealth(f.store).depth).toBe(0);
  });
  test("load alarm health and observer failures cannot block a trickle", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    let metadata: Record<string, unknown> | undefined;
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      fetch: (async (url, init) => {
        if (new URL(String(url)).pathname === "/health") throw new Error("health unavailable");
        return fetch(url, init);
      }) as typeof fetch,
      telemetry: {
        emit: (action, _detail, extra) => {
          if (action === "capture.intake.appender.load_gated") {
            metadata = extra;
            throw new Error("alarm down");
          }
        },
      },
    });
    expect(await worker.tick()).toMatchObject({ processed: 1, failed: 0, pauseReason: "load" });
    expect(metadata?.depth).toBeNull();
    expect(intakeHealth(f.store).depth).toBe(0);
  });
  test("WAL hard stop takes precedence over high load, without pulling or opening index", async () => {
    const f = fixture();
    let calls = 0;
    writeFileSync(`${f.sessions}-wal`, Buffer.alloc(2));
    const worker = f.appender({
      load: () => ({ load1: 16, cpus: 16 }),
      walStopBytes: 1,
      fetch: (async () => {
        calls++;
        throw new Error("must not pull");
      }) as unknown as typeof fetch,
    });
    expect(await worker.tick()).toMatchObject({ processed: 0, paused: true, pauseReason: "wal" });
    expect(worker.state()).toBe("backoff");
    expect(calls).toBe(0);
    expect(existsSync(f.sessions)).toBe(false);
  });
  test("WAL growing during download prevents index open and acknowledgement", async () => {
    const f = fixture();
    createSessionsDb(f.sessions);
    await f.post(requestBody());
    const before = sessionIndexConnectionStats().opens;
    const worker = f.appender({
      walStopBytes: 1,
      fetch: (async (url, init) => {
        const response = await fetch(url, init);
        if (new URL(String(url)).pathname.startsWith("/blob/"))
          writeFileSync(`${f.sessions}-wal`, Buffer.alloc(2));
        return response;
      }) as typeof fetch,
    });
    expect(await worker.tick()).toMatchObject({ processed: 0, paused: true, pauseReason: "wal" });
    expect(sessionIndexConnectionStats().opens).toBe(before);
    expect(intakeHealth(f.store).depth).toBe(1);
  });
});

describe("drain-to-legacy", () => {
  test("CLI dry-run requires the remote URL and never creates an empty local store", async () => {
    const f = fixture();
    const unused = join(f.root, "must-not-create-local-store");
    await expect(
      intakeMain(["drain-to-legacy", "--dry-run"], { CAPTURE_INTAKE_DIR: unused }),
    ).rejects.toThrow("CAPTURE_INTAKE_URL required");
    expect(existsSync(unused)).toBe(false);
    await f.post(requestBody());
    expect(
      await intakeMain(["drain-to-legacy", "--dry-run", "--json"], {
        CAPTURE_INTAKE_DIR: unused,
        CAPTURE_INTAKE_URL: f.url,
        CAPTURE_INTAKE_PULL_TOKEN: "pull",
      }),
    ).toBe(0);
    expect(existsSync(unused)).toBe(false);
    expect(owedPage(f.store)).toHaveLength(1);
  });
  test.each(["local", "remote"])(
    "%s dry-run and lost-ack round-trip preserve original IDs and yield one index row",
    async (location) => {
      const f = fixture();
      createSessionsDb(f.sessions);
      await f.post({ ...requestBody(), tags: ["captured", "original-tag"] });
      const previous = process.env.MEMORY_RUN_STORE;
      process.env.MEMORY_RUN_STORE = join(f.root, "legacy-blobs");
      cleanups.push(() => {
        if (previous === undefined) delete process.env.MEMORY_RUN_STORE;
        else process.env.MEMORY_RUN_STORE = previous;
      });
      const legacy = new Hono();
      const ids: string[] = [];
      registerRunCaptureRoute(legacy, {
        authenticate: async () => ({ ...principal, machine_id: "legacy-drain-host", did: null }),
        sourceCursorClaimDir: join(f.root, "claims"),
        captureCell: { mode: "off", shadow: async () => {} },
        writeRunBlob,
        sendCaptured: async (event) => {
          ids.push(event.data.run_id);
          indexWithWriter(f.sessions, event.data);
        },
      });
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          expect(((await request.clone().json()) as { machine_id: string }).machine_id).toBe(
            "machine",
          );
          return legacy.fetch(request);
        },
      });
      cleanups.push(() => {
        void server.stop(true);
      });
      const send = createLegacySender({ url: `http://127.0.0.1:${server.port}`, token: "legacy" });
      const drain = (options: Parameters<typeof drainToLegacy>[1]) =>
        location === "local"
          ? drainToLegacy(f.store, options)
          : drainRemoteToLegacy({
              url: f.url,
              token: "pull",
              runDir: join(f.root, "remote-staging"),
              ...options,
            });
      expect((await drain({ dryRun: true })).runs).toEqual(["r1"]);
      expect(existsSync(join(f.root, "remote-staging"))).toBe(false);
      expect(owedPage(f.store)).toHaveLength(1);
      expect(ids).toEqual([]);
      const failed = await drain({
        dryRun: false,
        send: async (m, path) => {
          expect(owedPage(f.store)).toHaveLength(0); // ownership committed before forwarding
          await send(m, path);
          throw new Error("lost legacy acknowledgement");
        },
      });
      expect(failed.failed).toEqual(["r1"]);
      expect(owedPage(f.store)).toHaveLength(0); // ownership handed away before I/O
      expect(owedPage(f.store, 0, 100, true)).toHaveLength(1);
      expect((await drain({ dryRun: false, send })).sent).toEqual(["r1"]);
      expect(runCount(f.sessions)).toBe(1);
      const indexed = new Database(f.sessions, { readonly: true });
      try {
        // Legacy auth intentionally wins over the forwarded sender field.
        const stored = indexed.query("SELECT run_id,machine_id,tags_json FROM runs").get() as {
          run_id: string;
          machine_id: string;
          tags_json: string;
        };
        expect(stored).toMatchObject({ run_id: "r1", machine_id: "legacy-drain-host" });
        expect(JSON.parse(stored.tags_json)).toEqual([
          "captured",
          "original-tag",
          "forwarded-from:machine",
        ]);
      } finally {
        indexed.close(false);
      }
      expect(owedPage(f.store, 0, 100, true)).toEqual([]);
      expect(ids).toEqual(["r1", "r1"]);
      expect((await drain({ dryRun: false, send })).sent).toEqual([]);
    },
  );
  test("forwarding adds provenance once without mutating the intake tags", async () => {
    const f = fixture();
    await f.post({ ...requestBody(), tags: ["existing"] });
    const metadata = owedPage(f.store)[0]!.metadata;
    const first = legacyBodyMetadata(metadata);
    expect(first.tags).toEqual(["existing", "forwarded-from:machine"]);
    expect(metadata.tags).toEqual(["existing"]);
    expect(legacyBodyMetadata({ ...metadata, tags: first.tags }).tags).toEqual(first.tags);
    expect(legacyBodyMetadata({ ...metadata, tags: undefined }).tags).toEqual([
      "forwarded-from:machine",
    ]);
    const nearLimit = { ...metadata, jsonl_bytes: LEGACY_MAX_INLINE_BYTES - 1000 };
    const { user_id: _user, ...withoutProvenance } = nearLimit;
    nearLimit.jsonl_bytes =
      LEGACY_MAX_INLINE_BYTES -
      Buffer.byteLength(JSON.stringify({ ...withoutProvenance, jsonl: "" }));
    // The original wire body fits exactly, but the added provenance must count.
    expect(() => assertLegacyMinimumSize(nearLimit)).toThrow("legacy_inline_too_large");
  });
  test("streamed outgoing body round-trips with escaped content", async () => {
    const f = fixture();
    await f.post(requestBody());
    const row = owedPage(f.store)[0]!;
    const body = (await new Response(
      inlineBody(row.metadata, blobPath(f.store, row.id)),
    ).json()) as { jsonl: string };
    expect(body.jsonl).toBe(requestBody().jsonl);
  });
});

function control(f: ReturnType<typeof fixture>, path: string, value: object) {
  return f.handler(
    new Request(`${f.url}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer pull" },
      body: JSON.stringify(value),
    }),
  );
}

describe("rollback ownership fence", () => {
  test("legacy size contract matches the actual receiver", () => {
    expect(LEGACY_MAX_INLINE_BYTES).toBe(DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES);
  });
  test.each(["local", "remote"])(
    "%s planted appender ack between transfer and forward is refused",
    async (location) => {
      const f = fixture();
      await f.post(requestBody());
      const row = owedPage(f.store)[0]!;
      let ackStatus = 0;
      let ackedDuringForward: number | null | undefined;
      const send = async () => {
        const response = await control(f, "/ack", {
          id: row.id,
          jsonl_sha256: row.metadata.jsonl_sha256,
        });
        ackStatus = response.status;
        ackedDuringForward = getRow(f.store, row.id)?.acked_at;
      };
      const report =
        location === "local"
          ? await drainToLegacy(f.store, { dryRun: false, send })
          : await drainRemoteToLegacy({
              url: f.url,
              token: "pull",
              runDir: join(f.root, "rollback"),
              dryRun: false,
              send,
            });
      // These assertions are outside the sender: a swallowed callback error cannot mask the race.
      expect(ackStatus).toBe(409);
      expect(ackedDuringForward).toBeNull();
      expect(report.sent).toEqual(["r1"]);
      expect(getRow(f.store, row.id)?.acked_at).not.toBeNull();
      expect(
        (getRow(f.store, row.id) as unknown as { transfer_token?: string }).transfer_token,
      ).toBeUndefined();
    },
  );
  test("transfer receipt follows UPDATE changes, not its pre-update snapshot", async () => {
    const f = fixture();
    await f.post(requestBody());
    const row = owedPage(f.store)[0]!;
    f.store.db.exec(`CREATE TRIGGER settle_before_transfer BEFORE UPDATE OF owner ON intake
      WHEN NEW.owner='legacy' BEGIN
        UPDATE intake SET acked_at=123 WHERE id=OLD.id;
        SELECT RAISE(IGNORE);
      END`);
    const response = await control(f, "/transfer", {
      id: row.id,
      jsonl_sha256: row.metadata.jsonl_sha256,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transferred: false });
    expect(getRow(f.store, row.id)?.acked_at).toBe(123);
  });
  test.each(["local", "remote"])(
    "%s drain never forwards a zero-change transfer",
    async (location) => {
      const f = fixture();
      await f.post(requestBody());
      f.store.db.exec(`CREATE TRIGGER settle_before_transfer BEFORE UPDATE OF owner ON intake
      WHEN NEW.owner='legacy' BEGIN
        UPDATE intake SET acked_at=123 WHERE id=OLD.id;
        SELECT RAISE(IGNORE);
      END`);
      let sends = 0;
      const send = async () => {
        sends++;
      };
      const report =
        location === "local"
          ? await drainToLegacy(f.store, { dryRun: false, send })
          : await drainRemoteToLegacy({
              url: f.url,
              token: "pull",
              runDir: join(f.root, "rollback"),
              dryRun: false,
              send,
            });
      expect(sends).toBe(0);
      expect(report.sent).toEqual([]);
      expect(report.failed).toEqual([]);
    },
  );
  test("transfer-back fences stale drain acks and new ownership generations", async () => {
    const f = fixture();
    await f.post(requestBody());
    const row = owedPage(f.store)[0]!;
    const body = { id: row.id, jsonl_sha256: row.metadata.jsonl_sha256 };
    const first = (await (await control(f, "/transfer", body)).json()) as {
      transferred: boolean;
      transfer_token: string;
    };
    expect(first.transferred).toBe(true);
    const repeat = (await (await control(f, "/transfer", body)).json()) as {
      transfer_token: string;
    };
    expect(repeat.transfer_token).toBe(first.transfer_token);
    expect((await control(f, "/ack", body)).status).toBe(409);
    expect((await control(f, "/transfer-back", body)).status).toBe(409);
    expect((await control(f, "/transfer-back", { ...body, transfer_token: "wrong" })).status).toBe(
      409,
    );
    expect(
      (await control(f, "/transfer-back", { ...body, transfer_token: first.transfer_token }))
        .status,
    ).toBe(200);
    expect(owedPage(f.store)).toHaveLength(1);
    expect(
      (await control(f, "/ack", { ...body, transfer_token: first.transfer_token })).status,
    ).toBe(409);
    // A page from the previous ownership epoch cannot reclaim returned work (ABA).
    expect(
      await (await control(f, "/transfer", { ...body, expected_epoch: row.transfer_epoch })).json(),
    ).toEqual({ ok: true, transferred: false });
    // A delayed recovery read cannot re-take appender ownership.
    expect(await (await control(f, "/transfer", { ...body, legacy_only: true })).json()).toEqual({
      ok: true,
      transferred: false,
    });
    const second = (await (await control(f, "/transfer", body)).json()) as {
      transfer_token: string;
    };
    expect(second.transfer_token).not.toBe(first.transfer_token);
    expect(
      (await control(f, "/transfer-back", { ...body, transfer_token: first.transfer_token }))
        .status,
    ).toBe(409);
    expect(
      (await control(f, "/ack", { ...body, transfer_token: first.transfer_token })).status,
    ).toBe(409);
    expect(
      (await control(f, "/ack", { ...body, transfer_token: second.transfer_token })).status,
    ).toBe(200);
    expect(
      (await control(f, "/ack", { ...body, transfer_token: second.transfer_token })).status,
    ).toBe(200);
    expect(owedPage(f.store, 0, 100, true)).toEqual([]);
  });
  test.each(["decoded", "escaped"])(
    "%s oversized inline rows stay discoverable before any transfer",
    async (shape) => {
      const f = fixture();
      const jsonl =
        JSON.stringify({
          text: shape === "decoded" ? "x".repeat(LEGACY_MAX_INLINE_BYTES) : '"'.repeat(2_500_000),
        }) + "\n";
      const data = { agent_runtime: "pi", run_id: "too-large", jsonl };
      expect(Buffer.byteLength(JSON.stringify({ ...data, machine_id: "machine" }))).toBeGreaterThan(
        LEGACY_MAX_INLINE_BYTES,
      );
      if (shape === "escaped")
        expect(Buffer.byteLength(jsonl)).toBeLessThan(LEGACY_MAX_INLINE_BYTES);
      expect((await f.post(data)).status).toBe(202);
      const row = owedPage(f.store)[0]!;
      const rejected = await control(f, "/transfer", {
        id: row.id,
        jsonl_sha256: row.metadata.jsonl_sha256,
      });
      expect(rejected.status).toBe(413);
      expect(await rejected.json()).toMatchObject({ error: { code: "legacy_inline_too_large" } });
      let sends = 0;
      const send = async () => {
        sends++;
      };
      expect((await drainToLegacy(f.store, { dryRun: false, send })).failed).toEqual(["too-large"]);
      expect(
        (
          await drainRemoteToLegacy({
            url: f.url,
            token: "pull",
            runDir: join(f.root, "rollback"),
            dryRun: false,
            send,
          })
        ).failed,
      ).toEqual(["too-large"]);
      expect(sends).toBe(0);
      expect(getRow(f.store, row.id)?.owner).toBe("appender");
      expect(owedPage(f.store)).toHaveLength(1);
      expect(readFileSync(blobPath(f.store, row.id), "utf8")).toBe(jsonl);
    },
  );
  test("remote transfer-back rescues oversized old legacy debt without downloading or opening an index", async () => {
    const f = fixture();
    await f.post({
      agent_runtime: "pi",
      run_id: "old-large",
      jsonl: "x".repeat(LEGACY_MAX_INLINE_BYTES),
    });
    const row = owedPage(f.store)[0]!;
    // This is the state left by the previous protocol, including its missing capability.
    f.store.db.query("UPDATE intake SET owner='legacy',transfer_token=NULL WHERE id=?").run(row.id);
    const options = {
      url: f.url,
      token: "pull",
      fetch: (async (url, init) => {
        if (String(url).includes("/blob/")) throw new Error("recovery must not need a blob");
        return fetch(url, init);
      }) as typeof fetch,
    };
    expect((await transferRemoteBack({ ...options, dryRun: true })).runs).toEqual(["old-large"]);
    expect(owedPage(f.store)).toEqual([]);
    expect((await transferRemoteBack({ ...options, dryRun: false })).returned).toEqual([
      "old-large",
    ]);
    expect(owedPage(f.store)).toHaveLength(1);
    expect((await transferRemoteBack({ ...options, dryRun: false })).returned).toEqual([]);
    expect(existsSync(f.sessions)).toBe(false);
    expect(
      await intakeMain(["transfer-back", "--dry-run", "--json"], {
        CAPTURE_INTAKE_URL: f.url,
        CAPTURE_INTAKE_PULL_TOKEN: "pull",
        CAPTURE_INTAKE_DIR: join(f.root, "unused"),
      }),
    ).toBe(0);
    expect(existsSync(join(f.root, "unused"))).toBe(false);
  });
  test("schema migration adopts old legacy debt but never accepts an unfenced ack", async () => {
    const f = fixture();
    const path = join(f.root, "old.db");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE intake(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE,cursor_key TEXT UNIQUE,metadata TEXT NOT NULL,received_at INTEGER NOT NULL,
      acked_at INTEGER,owner TEXT NOT NULL DEFAULT 'appender',pruned_at INTEGER) STRICT`);
    old.close(false);
    const migrated = openIntake(join(f.root, "old-root"), { dbPath: path });
    try {
      expect(
        (migrated.db.query("PRAGMA table_info(intake)").all() as { name: string }[]).some(
          (c) => c.name === "transfer_token",
        ),
      ).toBe(true);
      await f.post(requestBody());
      const row = owedPage(f.store)[0]!;
      migrated.db
        .query("INSERT INTO intake(id,run_id,metadata,received_at,owner) VALUES(?,?,?,?,?)")
        .run(row.id, row.run_id, JSON.stringify(row.metadata), 1, "legacy");
      expect(acknowledge(migrated, row.id, row.metadata.jsonl_sha256, 2)).toBe(false);
      const receipt = transferToLegacy(migrated, row.id, row.metadata.jsonl_sha256, true);
      expect(receipt.transferred).toBe(true);
      expect(
        transferBackToAppender(
          migrated,
          row.id,
          row.metadata.jsonl_sha256,
          receipt.transfer_token!,
        ),
      ).toBe(true);
      expect(acknowledge(migrated, row.id, row.metadata.jsonl_sha256, 3)).toBe(true);
    } finally {
      migrated.close();
    }
  });
  test("orphan sweep is bounded, age-gated and preserves referenced, active, partial and symlink files", async () => {
    const f = fixture();
    await f.post(requestBody());
    const row = owedPage(f.store)[0]!;
    const now = Date.now();
    const old = new Date(now - ORPHAN_RETENTION_MS - 1000);
    utimesSync(blobPath(f.store, row.id), old, old);
    const orphan = randomUUID(),
      young = randomUUID(),
      active = randomUUID(),
      link = randomUUID();
    for (const id of [orphan, young, active]) {
      writeFileSync(blobPath(f.store, id), "synthetic");
      utimesSync(blobPath(f.store, id), old, old);
    }
    const boundary = new Date(now - ORPHAN_RETENTION_MS);
    utimesSync(blobPath(f.store, young), boundary, boundary);
    f.store.publishing.add(active);
    writeFileSync(join(f.store.blobDir, "keep.part"), "partial");
    writeFileSync(join(f.store.blobDir, "not-a-uuid.jsonl"), "unmanaged");
    symlinkSync(blobPath(f.store, row.id), blobPath(f.store, link));
    const removed: string[] = [];
    for (let i = 0; i < 20; i++) removed.push(...sweepOrphanBlobs(f.store, now, 1, 1));
    expect(removed).toEqual([orphan]);
    for (const id of [row.id, young, active, link])
      expect(existsSync(blobPath(f.store, id))).toBe(true);
    expect(existsSync(join(f.store.blobDir, "keep.part"))).toBe(true);
    expect(existsSync(join(f.store.blobDir, "not-a-uuid.jsonl"))).toBe(true);
    f.store.publishing.delete(active);
    const later: string[] = [];
    for (let i = 0; i < 20; i++) later.push(...sweepOrphanBlobs(f.store, now + 1, 1, 1));
    expect(new Set(later)).toEqual(new Set([active, young]));
    expect(existsSync(blobPath(f.store, row.id))).toBe(true);
  });
});
