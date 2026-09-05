import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "./backfill-native-sessions";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-backfill-"));
  const sessionId = "session-1";
  const sessionDir = join(root, "%2Fworkspace%2Fproject", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const historyPath = join(sessionDir, "chat_history.jsonl");
  await writeFile(
    historyPath,
    `${JSON.stringify({ type: "user", content: "hello" })}\n${JSON.stringify({ type: "assistant", content: "world" })}\n`,
  );
  const indexPath = join(root, "session_search.sqlite");
  const database = new Database(indexPath);
  database.exec(
    "CREATE TABLE sessions (session_id TEXT, path TEXT, updated_at INTEGER);",
  );
  database
    .query("INSERT INTO sessions VALUES (?, ?, ?)")
    .run(sessionId, sessionDir, Date.now());
  database.close();
  return { root, sessionId, historyPath, indexPath };
}

test("Cursor Agent discovery reads native project JSONL and supports exact session bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-backfill-"));
  const sessionId = "cursor-session-1";
  const sessionDir = join(root, "project", "agent-transcripts", sessionId);
  const historyPath = join(sessionDir, `${sessionId}.jsonl`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    historyPath,
    `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } })}\n${JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "world" }] } })}\n`,
  );

  try {
    const args = __test.parseArgs([
      "--runtime",
      "cursor",
      "--cursor-root",
      join(root, "missing-acp"),
      "--cursor-cli-root",
      root,
      "--session-id",
      sessionId,
    ]);
    const discovery = __test.discover(args, "test-machine", { version: 1, entries: {} });
    assert.equal(discovery.sessions.length, 1);
    assert.equal(discovery.sessions[0]?.sessionId, sessionId);
    assert.equal(discovery.sessions[0]?.sourcePath, historyPath);
    assert.match(discovery.sessions[0]?.jsonl ?? "", /"type":"message"/u);

    const excluded = __test.discover(
      { ...args, sessionId: "another-session" },
      "test-machine",
      { version: 1, entries: {} },
    );
    assert.equal(excluded.sessions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok discovery uses the native index path and watermark columns", async () => {
  const value = await fixture();
  try {
    const args = __test.parseArgs([
      "--runtime",
      "grok",
      "--grok-root",
      value.root,
      "--grok-index",
      value.indexPath,
    ]);
    const index = __test.readGrokIndex(args);
    assert.equal(index.status, "ready");
    assert.equal(index.rows.length, 1);
    assert.equal(index.rows[0]?.sessionId, value.sessionId);
    assert.equal(index.rows[0]?.sourcePath, await realpath(value.historyPath));

    const discovery = __test.discover(args, "test-machine", { version: 1, entries: {} });
    assert.equal(discovery.sessions.length, 1);
    assert.equal(discovery.warnings.length, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Grok index skips an empty recognized table and uses a later populated candidate", async () => {
  const value = await fixture();
  const database = new Database(value.indexPath);
  try {
    database.exec("DELETE FROM sessions;");
    database.exec("CREATE TABLE history (session_id TEXT, path TEXT, updated_at INTEGER);");
    database
      .query("INSERT INTO history VALUES (?, ?, ?)")
      .run(value.sessionId, value.historyPath, Date.now());
  } finally {
    database.close();
  }
  try {
    const index = __test.readGrokIndex(
      __test.parseArgs([
        "--runtime",
        "grok",
        "--grok-root",
        value.root,
        "--grok-index",
        value.indexPath,
      ]),
    );
    assert.equal(index.status, "ready");
    assert.equal(index.table, "history");
    assert.equal(index.rows.length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Grok index and exact-history discovery reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-root-"));
  const outside = await mkdtemp(join(tmpdir(), "grok-outside-"));
  const outsideSession = join(outside, "session-escape");
  await mkdir(outsideSession, { recursive: true });
  await writeFile(
    join(outsideSession, "chat_history.jsonl"),
    `${JSON.stringify({ type: "user", content: "private" })}\n`,
  );
  await symlink(outsideSession, join(root, "escape"));
  const indexPath = join(root, "session_search.sqlite");
  const database = new Database(indexPath);
  database.exec("CREATE TABLE sessions (session_id TEXT, path TEXT, updated_at INTEGER);");
  database.query("INSERT INTO sessions VALUES (?, ?, ?)").run("escape", join(root, "escape"), 1);
  database.close();
  try {
    const indexedArgs = __test.parseArgs([
      "--runtime",
      "grok",
      "--grok-root",
      root,
      "--grok-index",
      indexPath,
    ]);
    assert.equal(__test.readGrokIndex(indexedArgs).status, "empty");

    const exact = __test.discover(
      __test.parseArgs([
        "--runtime",
        "grok",
        "--grok-root",
        root,
        "--grok-history",
        join(root, "escape", "chat_history.jsonl"),
      ]),
      "test-machine",
      { version: 1, entries: {} },
    );
    assert.equal(exact.sessions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("exact in-root Grok history outside sessions derives the containing directory id", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-exact-root-"));
  const sessionDir = join(root, "direct-session");
  const historyPath = join(sessionDir, "chat_history.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(historyPath, `${JSON.stringify({ type: "user", content: "hello" })}\n`);
  try {
    const discovery = __test.discover(
      __test.parseArgs([
        "--runtime",
        "grok",
        "--grok-root",
        root,
        "--grok-history",
        historyPath,
      ]),
      "test-machine",
      { version: 1, entries: {} },
    );
    assert.equal(discovery.sessions[0]?.sessionId, "direct-session");
    assert.equal(discovery.sessions[0]?.cwd, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok filesystem scraping is blocked unless explicitly enabled", async () => {
  const value = await fixture();
  try {
    const blockedArgs = __test.parseArgs([
      "--runtime",
      "grok",
      "--grok-root",
      value.root,
      "--grok-index",
      join(value.root, "missing.sqlite"),
    ]);
    const blocked = __test.discover(blockedArgs, "test-machine", { version: 1, entries: {} });
    assert.equal(blocked.sessions.length, 0);
    assert.match(blocked.warnings[0] ?? "", /blocked/iu);

    const fallbackArgs = __test.parseArgs([
      "--runtime",
      "grok",
      "--grok-root",
      value.root,
      "--grok-index",
      join(value.root, "missing.sqlite"),
      "--allow-grok-filesystem-fallback",
    ]);
    const fallback = __test.discover(fallbackArgs, "test-machine", { version: 1, entries: {} });
    assert.equal(fallback.sessions.length, 1);
    assert.match(fallback.warnings[0] ?? "", /filesystem fallback/iu);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("runtime all captures Cursor before reporting Grok as a path-free partial failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-all-isolation-"));
  const sessionId = "cursor-session";
  const sessionDir = join(root, "cursor", "project", "agent-transcripts", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", message: { content: "hello" } })}\n`,
  );
  const authPath = join(root, "auth.json");
  const watermarkPath = join(root, "watermark.json");
  await writeFile(
    authPath,
    JSON.stringify({ token: "fixture-token", machine_id: "machine", user_id: "user" }),
  );
  let requests = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests += 1;
      const capture = JSON.parse(body) as { run_id: string; to_offset: number };
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          run_id: capture.run_id,
          status: "accepted",
          to_offset: capture.to_offset,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "backfill-native-sessions.ts"),
        "--runtime",
        "all",
        "--apply",
        "--summary-only",
        "--auth-path",
        authPath,
        "--watermark-path",
        watermarkPath,
        "--cursor-root",
        join(root, "missing-acp"),
        "--cursor-cli-root",
        join(root, "cursor"),
        "--grok-root",
        join(root, "missing-grok"),
        "--grok-index",
        join(root, "missing-grok.sqlite"),
        "--central-url",
        `http://127.0.0.1:${address.port}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exitCode, 1);
    assert.equal(requests, 1);
    assert.match(stderr, /runtime-partially-unavailable/u);
    assert.equal(`${stdout}${stderr}`.includes(root), false);
    assert.ok(JSON.parse(await readFile(watermarkPath, "utf8")).entries);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted_prefix advances only to Central's accepted offset and preserves the suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-prefix-receipt-"));
  const sourcePath = join(root, "fixture.jsonl");
  const first = `${JSON.stringify({ type: "user", content: "one" })}\n`;
  const second = `${JSON.stringify({ type: "assistant", content: "two" })}\n`;
  await writeFile(sourcePath, first + second);
  const args = __test.parseArgs([
    "--runtime",
    "cursor",
    "--central-url",
    "https://capture.invalid",
  ]);
  const session = {
    runtime: "cursor" as const,
    sessionId: "fixture-session",
    sourcePath,
    startedAt: 1,
    updatedAt: 2,
    jsonl: first + second,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        status: "accepted_prefix",
        run_id: "accepted-prefix-run",
        to_offset: Buffer.byteLength(first),
      },
      { status: 202 },
    )) as unknown as typeof fetch;
  try {
    const receipt = await __test.postSession(session, args, {
      machine_id: "fixture-machine",
      token: "fixture-token",
      user_id: "fixture-user",
    });
    assert.equal(receipt.watermark.jsonlBytes, Buffer.byteLength(first));
    const suffix = __test.preparePayload(
      session,
      "fixture-machine",
      receipt.watermark,
    );
    assert.equal(suffix.fromOffset, Buffer.byteLength(first));
    assert.equal(suffix.bodyJsonl, second);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("successful POST without a bounded to_offset does not advance the watermark", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-invalid-receipt-"));
  const sourcePath = join(root, "fixture.jsonl");
  const jsonl = `${JSON.stringify({ type: "user", content: "one" })}\n`;
  await writeFile(sourcePath, jsonl);
  const args = __test.parseArgs([
    "--runtime",
    "cursor",
    "--central-url",
    "https://capture.invalid",
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ status: "accepted", run_id: "fixture-run" }, { status: 202 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      __test.postSession(
        {
          runtime: "cursor",
          sessionId: "fixture-session",
          sourcePath,
          startedAt: 1,
          updatedAt: 2,
          jsonl,
        },
        args,
        {
          machine_id: "fixture-machine",
          token: "fixture-token",
          user_id: "fixture-user",
        },
      ),
      /invalid-receipt/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("a hung native POST is bounded by the configured timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-timeout-"));
  const sourcePath = join(root, "fixture.jsonl");
  const jsonl = `${JSON.stringify({ type: "user", content: "one" })}\n`;
  await writeFile(sourcePath, jsonl);
  const args = __test.parseArgs([
    "--runtime",
    "cursor",
    "--central-url",
    "https://capture.invalid",
    "--http-timeout-ms",
    "10",
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      __test.postSession(
        {
          runtime: "cursor",
          sessionId: "fixture-session",
          sourcePath,
          startedAt: 1,
          updatedAt: 2,
          jsonl,
        },
        args,
        {
          machine_id: "fixture-machine",
          token: "fixture-token",
          user_id: "fixture-user",
        },
      ),
      /native capture POST failed: network/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
