import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { __test } from "./backfill-native-sessions";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-backfill-"));
  const sessionId = "session-1";
  const sessionDir = join(root, "%2FUsers%2Fjoel", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const historyPath = join(sessionDir, "chat_history.jsonl");
  await writeFile(
    historyPath,
    `${JSON.stringify({ type: "user", content: "hello" })}\n${JSON.stringify({ type: "assistant", content: "world" })}\n`,
  );
  const indexPath = join(root, "session_search.sqlite");
  const database = new Database(indexPath);
  database.exec("CREATE TABLE sessions (session_id TEXT, path TEXT, updated_at INTEGER);");
  database.query("INSERT INTO sessions VALUES (?, ?, ?)").run(sessionId, sessionDir, Date.now());
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

    const excluded = __test.discover({ ...args, sessionId: "another-session" }, "test-machine", {
      version: 1,
      entries: {},
    });
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
    assert.equal(index.rows[0]?.sourcePath, value.historyPath);

    const discovery = __test.discover(args, "test-machine", { version: 1, entries: {} });
    assert.equal(discovery.sessions.length, 1);
    assert.equal(discovery.warnings.length, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
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

test("summary-only dry runs omit private source paths and session identifiers", () => {
  const summary = {
    ok: true,
    mode: "dry-run",
    runtime: "cursor" as const,
    machine: "private-machine",
    watermark_path: "/private/watermark.json",
    grok_index: {
      status: "missing" as const,
      path: "/private/grok.sqlite",
      detail: "private index detail",
      indexed_rows: 0,
      filesystem_fallback: false,
    },
    warnings: ["private warning path"],
    discovered: 1,
    by_runtime: { cursor: 1, grok: 0 },
    turns: 2,
    chunks: 2,
    jsonl_bytes: 123,
    sessions: [{ session_id: "private-session", source_path: "/private/session.jsonl" }],
  };

  const compact = __test.compactDryRunSummary(summary);
  assert.deepEqual(compact, {
    ok: true,
    mode: "dry-run",
    runtime: "cursor",
    discovered: 1,
    by_runtime: { cursor: 1, grok: 0 },
    turns: 2,
    chunks: 2,
    jsonl_bytes: 123,
    grok_index: { status: "missing", indexed_rows: 0, filesystem_fallback: false },
    warning_count: 1,
  });
  assert.equal(JSON.stringify(compact).includes("private"), false);
});
