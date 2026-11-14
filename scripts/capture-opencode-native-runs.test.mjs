import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  captureSnapshots,
  planSessionCapture,
  readOpenCodeSnapshots,
} from "./capture-opencode-native-runs.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-raw-capture-"));
  const databasePath = path.join(root, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)")
    .run("session-1", null, "1.0.0", 1_787_500_000_000, 1_787_500_000_000);
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-1",
      "session-1",
      1_787_500_001_000,
      1_787_500_001_000,
      JSON.stringify({ id: "message-1", role: "user", tokens: { input: 7 } }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-1",
      "message-1",
      "session-1",
      1_787_500_001_000,
      1_787_500_001_000,
      JSON.stringify({ id: "part-1", type: "text", text: "safe fixture text" }),
    );
  database.close();
  return { root, databasePath };
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("reads OpenCode messages and retains original message/part JSON in a valid JSONL Run", (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const [snapshot] = readOpenCodeSnapshots(value.databasePath);
  assert.equal(snapshot.sessionId, "session-1");
  const records = snapshot.bytes.toString("utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records[0].type, "opencode_session");
  assert.equal(records[1].type, "user");
  assert.deepEqual(records[1].message.content, [{ type: "text", text: "safe fixture text" }]);
  assert.match(records[1].opencode_raw.message_json, /"input":7/u);
  assert.match(records[1].opencode_raw.parts[0].data, /safe fixture text/u);
});

test("uses byte-aligned deltas for append and rebases if an earlier native record changes", (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const [first] = readOpenCodeSnapshots(value.databasePath);
  const initial = planSessionCapture(first, undefined, "test-machine");
  assert.equal(initial._tag, "capture");
  assert.equal(initial.fromOffset, 0);

  const prior = {
    source_identity: initial.sourceIdentity,
    last_byte_offset: first.bytes.byteLength,
    prefix_sha256: hash(first.bytes),
    last_run_id: "a".repeat(26),
  };
  assert.equal(planSessionCapture(first, prior, "test-machine")._tag, "unchanged");

  const database = new DatabaseSync(value.databasePath);
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-2",
      "session-1",
      1_787_500_002_000,
      1_787_500_002_000,
      JSON.stringify({ id: "message-2", role: "assistant", tokens: { output: 4 } }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-2",
      "message-2",
      "session-1",
      1_787_500_002_000,
      1_787_500_002_000,
      JSON.stringify({ id: "part-2", type: "text", text: "second fixture" }),
    );
  database.close();
  const [appended] = readOpenCodeSnapshots(value.databasePath);
  const delta = planSessionCapture(appended, prior, "test-machine");
  assert.equal(delta.fromOffset, first.bytes.byteLength);
  assert.equal(delta.sourceIdentity, initial.sourceIdentity);
  assert.equal(appended.bytes.subarray(delta.fromOffset).at(-1), 0x0a);

  const mutate = new DatabaseSync(value.databasePath);
  mutate
    .prepare("UPDATE message SET data = ? WHERE id = ?")
    .run(JSON.stringify({ id: "message-1", role: "user", tokens: { input: 8 } }), "message-1");
  mutate.close();
  const [changedPrefix] = readOpenCodeSnapshots(value.databasePath);
  const rebase = planSessionCapture(changedPrefix, prior, "test-machine");
  assert.equal(rebase.fromOffset, 0);
  assert.equal(rebase.rebased, true);
  assert.notEqual(rebase.sourceIdentity, initial.sourceIdentity);
});

test("posts a snapshot and advances local state only after an accepted receiver receipt", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const [snapshot] = readOpenCodeSnapshots(value.databasePath);
  const statePath = path.join(value.root, "state.json");
  let posts = 0;
  const fetch = async (_url, init) => {
    posts += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.agent_runtime, "opencode");
    assert.equal(body.to_offset, snapshot.bytes.byteLength);
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    return new Response(
      JSON.stringify({
        ok: true,
        run_id: body.run_id,
        status: "accepted",
        to_offset: body.to_offset,
      }),
      { status: 202 },
    );
  };
  const options = {
    auth: { machineId: "test-machine", userId: "test-user", token: "fixture-token" },
    centralUrl: "http://127.0.0.1:3111",
    fetch,
    statePath,
  };
  const first = await captureSnapshots([snapshot], options);
  assert.deepEqual(first, {
    accepted: 1,
    duplicate: 0,
    failed: 0,
    failure_codes: {},
    rebased: 0,
    unchanged: 0,
  });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.entries["session-1"].last_byte_offset, snapshot.bytes.byteLength);
  const second = await captureSnapshots([snapshot], options);
  assert.equal(second.unchanged, 1);
  assert.equal(posts, 1);
});
