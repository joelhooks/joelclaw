import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSessionCapture, writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import { memoryRunCaptured } from "../inngest/functions/memory/run-captured";
import { registerRunCaptureRoute } from "./run-capture";

const roots = new Set<string>();

afterEach(() => {
  delete process.env.MEMORY_RUN_STORE;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

type CaptureBody = {
  run_id: string;
  agent_runtime: string;
  started_at?: number;
  conversation_id?: string;
  parent_run_id?: string;
  source_identity?: string;
  from_offset?: number;
  to_offset?: number;
  jsonl_sha256?: string;
  jsonl: string;
};

type CapturedEvent = {
  data: {
    run_id: string;
    user_id: string;
    machine_id: string;
    agent_runtime: string;
    jsonl_path: string;
    jsonl_bytes: number;
    jsonl_sha256: string;
    started_at: number;
    parent_run_id?: string;
    conversation_id?: string;
    tags: string[];
    from_offset?: number;
    to_offset?: number;
    source_identity?: string;
  };
};

const line = (content: string) =>
  `${JSON.stringify({ type: "assistant", message: { role: "assistant", content } })}\n`;

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function createSessionIndex(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL, conversation_id TEXT, parent_run_id TEXT,
      source_identity TEXT NOT NULL, prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL, started_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL, jsonl_path TEXT NOT NULL, jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL, turn_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      from_offset INTEGER, to_offset INTEGER, tags_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      chunk_idx INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      started_at INTEGER NOT NULL, token_count INTEGER NOT NULL,
      UNIQUE(run_id, chunk_idx)
    ) STRICT;
    CREATE VIRTUAL TABLE chunk_fts USING fts5(
      text, content='chunks', content_rowid='rowid', tokenize='unicode61'
    );
  `);
  db.close(false);
}

function fixtureRoute(root: string) {
  process.env.MEMORY_RUN_STORE = join(root, "runs");
  const events: CapturedEvent[] = [];
  const app = new Hono();
  registerRunCaptureRoute(app, {
    authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
    writeRunBlob,
    sendCaptured: async (event) => events.push(event as CapturedEvent),
    now: () => Date.UTC(2026, 6, 20),
  });
  return { app, events };
}

async function post(app: Hono, body: CaptureBody): Promise<Response> {
  return app.request("/api/runs", {
    method: "POST",
    headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function body(input: {
  runId: string;
  jsonl: string;
  source?: string;
  from?: number;
  conversation?: string;
}): CaptureBody {
  const from = input.from;
  return {
    run_id: input.runId,
    agent_runtime: "pi",
    started_at: Date.UTC(2026, 6, 20),
    conversation_id: input.conversation,
    ...(input.source === undefined ? {} : { source_identity: input.source }),
    ...(from === undefined
      ? {}
      : {
          from_offset: from,
          to_offset: from + Buffer.byteLength(input.jsonl),
          jsonl_sha256: createHash("sha256").update(input.jsonl).digest("hex"),
        }),
    jsonl: input.jsonl,
  };
}

function appendEvents(databasePath: string, events: CapturedEvent[]) {
  return events.map((event, index) =>
    appendSessionCapture({
      databasePath,
      capturePath: event.data.jsonl_path,
      runId: event.data.run_id,
      userId: event.data.user_id,
      machineId: event.data.machine_id,
      agentRuntime: event.data.agent_runtime,
      conversationId: event.data.conversation_id,
      parentRunId: event.data.parent_run_id,
      sourceIdentity: event.data.source_identity,
      fromOffset: event.data.from_offset,
      toOffset: event.data.to_offset,
      tags: event.data.tags,
      startedAt: event.data.started_at,
      capturedAt: index + 1,
      jsonlPath: event.data.jsonl_path,
      jsonlBytes: event.data.jsonl_bytes,
      jsonlSha256: event.data.jsonl_sha256,
    }),
  );
}

function claudeFixture() {
  const root = tempRoot("keying-client-");
  const configDir = join(root, ".joelclaw");
  mkdirSync(configDir, { recursive: true });
  const authPath = join(configDir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ user_id: "user", machine_id: "machine", token: "fixture-token" }),
  );
  const transcriptPath = join(root, "session.jsonl");
  const contextPath = join(root, "hook.json");
  writeFileSync(
    contextPath,
    JSON.stringify({ session_id: "same-source", transcript_path: transcriptPath }),
  );
  return { root, configDir, authPath, transcriptPath, contextPath };
}

async function runClaudeClient(
  fixture: ReturnType<typeof claudeFixture>,
  centralUrl: string,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(process.cwd(), "scripts/joelclaw-capture-session.ts"),
      "--file",
      fixture.contextPath,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: fixture.root,
        JOELCLAW_AUTH_PATH: fixture.authPath,
        JOELCLAW_CENTRAL_URL: centralUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
}

async function runAckLossChain(losses: Set<number>) {
  const fixture = claudeFixture();
  const route = fixtureRoute(fixture.root);
  const requests: CaptureBody[] = [];
  let requestNumber = 0;
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const requestBody = (await request.json()) as CaptureBody;
      requests.push(requestBody);
      requestNumber += 1;
      const response = await post(route.app, requestBody);
      const payload = await response.text();
      if (losses.has(requestNumber)) {
        return Response.json({ ok: false, error: "ack intentionally lost" }, { status: 503 });
      }
      return new Response(payload, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { fixture, route, requests, proxy };
}

function assertIndexedOnce(root: string, events: CapturedEvent[], expected: string): void {
  const databasePath = join(root, "sessions.db");
  createSessionIndex(databasePath);
  appendEvents(databasePath, events);
  const db = new Database(databasePath, { readonly: true, strict: true });
  const rows = db
    .query("SELECT jsonl_path, from_offset, to_offset, jsonl_bytes FROM runs ORDER BY from_offset")
    .all() as Array<{
    jsonl_path: string;
    from_offset: number;
    to_offset: number;
    jsonl_bytes: number;
  }>;
  const reconstructed = rows.map((row) => readFileSync(row.jsonl_path, "utf8")).join("");
  expect(reconstructed).toBe(expected);
  expect(rows.reduce((sum, row) => sum + row.jsonl_bytes, 0)).toBe(Buffer.byteLength(expected));
  for (let index = 1; index < rows.length; index += 1) {
    expect(rows[index].from_offset).toBe(rows[index - 1].to_offset);
  }
  db.close(false);
}

describe("Typesense reboot recovery source-cursor verification", () => {
  test("lost ack on the first post at offset zero indexes every byte once", async () => {
    const chain = await runAckLossChain(new Set([1]));
    const first = line("first");
    const second = line("second");
    try {
      writeFileSync(chain.fixture.transcriptPath, first);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);
      appendFileSync(chain.fixture.transcriptPath, second);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);

      expect(chain.requests.map((request) => request.from_offset)).toEqual([
        0,
        0,
        Buffer.byteLength(first),
      ]);
      expect(chain.requests[1].run_id).toBe(chain.requests[0].run_id);
      expect(chain.requests[2].jsonl).toBe(second);
      assertIndexedOnce(chain.fixture.root, chain.route.events, first + second);
    } finally {
      chain.proxy.stop(true);
    }
  });

  test("two lost acks resync to the first committed offset then send only the remainder", async () => {
    const chain = await runAckLossChain(new Set([1, 2]));
    const first = line("first");
    const second = line("second");
    const third = line("third");
    try {
      writeFileSync(chain.fixture.transcriptPath, first);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);
      appendFileSync(chain.fixture.transcriptPath, second);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);
      appendFileSync(chain.fixture.transcriptPath, third);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);
      await runClaudeClient(chain.fixture, `http://127.0.0.1:${chain.proxy.port}`);

      expect(chain.requests).toHaveLength(4);
      expect(new Set(chain.requests.slice(0, 3).map((request) => request.run_id)).size).toBe(1);
      expect(chain.requests.slice(0, 3).map((request) => request.from_offset)).toEqual([0, 0, 0]);
      expect(chain.requests[3].from_offset).toBe(Buffer.byteLength(first));
      expect(chain.requests[3].jsonl).toBe(second + third);
      expect(chain.requests[3].parent_run_id).toBe(chain.requests[0].run_id);
      assertIndexedOnce(chain.fixture.root, chain.route.events, first + second + third);
    } finally {
      chain.proxy.stop(true);
    }
  });

  test("distinct explicit and legacy sources may both start at offset zero", async () => {
    const root = tempRoot("keying-sources-");
    const { app, events } = fixtureRoute(root);
    const sourceA = `sha256:${"a".repeat(64)}`;
    const sourceB = `sha256:${"b".repeat(64)}`;

    expect((await post(app, body({ runId: "a".repeat(26), jsonl: line("A"), source: sourceA, from: 0 }))).status).toBe(202);
    expect((await post(app, body({ runId: "b".repeat(26), jsonl: line("B"), source: sourceB, from: 0 }))).status).toBe(202);
    expect((await post(app, body({ runId: "c".repeat(26), jsonl: line("legacy A") }))).status).toBe(202);
    expect((await post(app, body({ runId: "d".repeat(26), jsonl: line("legacy B") }))).status).toBe(202);
    expect(events).toHaveLength(4);

    const databasePath = join(root, "sessions.db");
    createSessionIndex(databasePath);
    expect(appendEvents(databasePath, events).map((result) => result.status)).toEqual([
      "appended",
      "appended",
      "appended",
      "appended",
    ]);
    const db = new Database(databasePath, { readonly: true, strict: true });
    expect(db.query("SELECT source_identity FROM runs ORDER BY run_id").all()).toEqual([
      { source_identity: sourceA },
      { source_identity: sourceB },
      { source_identity: `legacy-run:${"c".repeat(26)}` },
      { source_identity: `legacy-run:${"d".repeat(26)}` },
    ]);
    db.close(false);
  });

  test("concurrent divergent posts at one source cursor have one winner and one truthful conflict", async () => {
    const root = tempRoot("keying-race-");
    const { app, events } = fixtureRoute(root);
    const source = `sha256:${"e".repeat(64)}`;
    const [left, right] = await Promise.all([
      post(app, body({ runId: "e".repeat(26), jsonl: line("left"), source, from: 0 })),
      post(app, body({ runId: "f".repeat(26), jsonl: line("right"), source, from: 0 })),
    ]);
    expect([left.status, right.status].sort()).toEqual([202, 409]);
    const loser = left.status === 409 ? left : right;
    expect(await loser.json()).toMatchObject({
      ok: false,
      error: {
        code: "run_blob_conflict",
        message: "source cursor already exists with different JSONL bytes",
      },
    });
    expect(events).toHaveLength(1);
    expect(readFileSync(events[0].data.jsonl_path, "utf8")).toMatch(/left|right/u);
  });

  test("consumer dedupes same-start prefix overlap under distinct Run IDs", () => {
    const root = tempRoot("keying-consumer-same-start-");
    const databasePath = join(root, "sessions.db");
    createSessionIndex(databasePath);
    const source = `sha256:${"1".repeat(64)}`;
    const first = line("first");
    const wider = first + line("second");
    const firstPath = join(root, "first.jsonl");
    const widerPath = join(root, "wider.jsonl");
    writeFileSync(firstPath, first);
    writeFileSync(widerPath, wider);

    const append = (runId: string, path: string, jsonl: string) =>
      appendSessionCapture({
        databasePath,
        capturePath: path,
        runId,
        userId: "user",
        machineId: "machine",
        agentRuntime: "pi",
        sourceIdentity: source,
        fromOffset: 0,
        toOffset: Buffer.byteLength(jsonl),
        startedAt: 1,
        capturedAt: 1,
        jsonlPath: path,
        jsonlBytes: Buffer.byteLength(jsonl),
        jsonlSha256: createHash("sha256").update(jsonl).digest("hex"),
      });

    expect(append("same-start-a", firstPath, first).status).toBe("appended");
    expect(append("same-start-b", widerPath, wider)).toMatchObject({
      status: "already_indexed",
      run_id: "same-start-a",
    });
    const db = new Database(databasePath, { readonly: true, strict: true });
    expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 1 });
    db.close(false);
  });

  test("rejects direct partial-overlap events at different starts", async () => {
    const root = tempRoot("keying-consumer-partial-");
    const databasePath = join(root, "sessions.db");
    createSessionIndex(databasePath);
    const source = `sha256:${"2".repeat(64)}`;
    const firstLine = line("first");
    const repeatedLine = line("repeated");
    const finalLine = line("final");
    const firstSegment = firstLine + repeatedLine;
    const overlappingSegment = repeatedLine + finalLine;
    const originalFetch = globalThis.fetch;
    const originalIndexPath = process.env.SESSION_INDEX_PATH;
    const originalOtel = process.env.OTEL_EVENTS_ENABLED;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    process.env.SESSION_INDEX_PATH = databasePath;
    process.env.OTEL_EVENTS_ENABLED = "0";

    const emit = async (runId: string, jsonl: string, fromOffset: number) => {
      const step = {
        run: async <T>(_stepId: string, operation: () => T | Promise<T>) => operation(),
        sendEvent: async () => undefined,
      };
      return (memoryRunCaptured as any).fn({
        event: {
          id: `event-${runId}`,
          name: "memory/run.captured",
          data: {
            run_id: runId,
            user_id: "user",
            machine_id: "machine",
            agent_runtime: "pi",
            jsonl_path: join(root, `${runId}.jsonl`),
            jsonl_bytes: Buffer.byteLength(jsonl),
            jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
            started_at: 1,
            source_identity: source,
            from_offset: fromOffset,
            to_offset: fromOffset + Buffer.byteLength(jsonl),
            jsonl_inline: jsonl,
          },
        },
        step,
      });
    };

    try {
      await emit("partial-a", firstSegment, 0);
      await expect(
        emit("partial-b", overlappingSegment, Buffer.byteLength(firstLine)),
      ).rejects.toThrow(/conflict|partial-a/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalIndexPath === undefined) delete process.env.SESSION_INDEX_PATH;
      else process.env.SESSION_INDEX_PATH = originalIndexPath;
      if (originalOtel === undefined) delete process.env.OTEL_EVENTS_ENABLED;
      else process.env.OTEL_EVENTS_ENABLED = originalOtel;
    }

    const db = new Database(databasePath, { readonly: true, strict: true });
    expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 1 });
    expect(
      db.query("SELECT count(*) AS count FROM chunks WHERE text = 'repeated'").get(),
    ).toEqual({ count: 1 });
    db.close(false);
  });
});
