import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceIdentity, sha256 } from "./lib/capture-outbox-replay";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

type SeedRun = {
  runId: string;
  agentRuntime: string;
  conversationId: string;
  parentRunId?: string;
  sourceIdentity: string;
  jsonl: string;
};

function seedFixture(seeds: SeedRun[]): { home: string; outbox: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), "capture-replay-fixture-"));
  const outbox = join(fixtureRoot, "outbox");
  mkdirSync(outbox);
  const searchDir = join(fixtureRoot, ".joelclaw", "search");
  mkdirSync(searchDir, { recursive: true });
  const db = new Database(join(searchDir, "sessions.db"));
  db.run(
    `CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      agent_runtime TEXT NOT NULL,
      conversation_id TEXT,
      parent_run_id TEXT,
      source_identity TEXT NOT NULL,
      jsonl_path TEXT NOT NULL,
      jsonl_sha256 TEXT NOT NULL
    )`,
  );
  const runStore = join(fixtureRoot, ".joelclaw", "runs-dev");
  mkdirSync(runStore, { recursive: true });
  for (const seed of seeds) {
    // sessions.db stores run-store-relative jsonl paths.
    writeFileSync(join(runStore, `${seed.runId}.jsonl`), seed.jsonl);
    db.run(
      "INSERT INTO runs (run_id, agent_runtime, conversation_id, parent_run_id, source_identity, jsonl_path, jsonl_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        seed.runId,
        seed.agentRuntime,
        seed.conversationId,
        seed.parentRunId ?? null,
        seed.sourceIdentity,
        `${seed.runId}.jsonl`,
        sha256(seed.jsonl),
      ],
    );
  }
  db.close();
  return { home: fixtureRoot, outbox };
}

function writeOutboxSource(outbox: string, runId: string, identity: string, jsonl: string): void {
  writeFileSync(
    join(outbox, `${runId}.json`),
    JSON.stringify({
      run_id: runId,
      agent_runtime: "pi",
      conversation_id: "conversation",
      started_at: 1_700_000_000_000,
      source_identity: identity,
      from_offset: 0,
      to_offset: Buffer.byteLength(jsonl),
      jsonl_sha256: sha256(jsonl),
      jsonl,
    }),
  );
}

async function planReceipt(home: string, outbox: string): Promise<Record<string, unknown>> {
  const catalog = join(home, "catalog.json");
  const receipt = join(home, "receipt.json");
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/replay-capture-outbox.ts",
      "--outbox",
      outbox,
      "--catalog",
      catalog,
      "--receipt",
      receipt,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        SESSION_INDEX_PATH: join(home, ".joelclaw", "search", "sessions.db"),
        RUN_STORE_PATH: join(home, ".joelclaw", "runs-dev"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  return JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
}

describe("canonical capture replay planner", () => {
  test("marks a source covered by an indexed sibling within the same source identity", async () => {
    const identity = captureSourceIdentity(["pi", "machine", "conversation", "/session.jsonl"]);
    const jsonl = "one\n";
    const { home, outbox } = seedFixture([
      {
        runId: "b".repeat(26),
        agentRuntime: "pi",
        conversationId: "conversation",
        sourceIdentity: identity,
        jsonl,
      },
    ]);
    writeOutboxSource(outbox, "a".repeat(26), identity, jsonl);

    expect(await planReceipt(home, outbox)).toMatchObject({
      ok: true,
      readOnly: true,
      representatives: 1,
      archiveStatus: { covered: 1, suffix: 0, full: 0 },
    });
  });

  test("ignores indexed runs outside the deterministic source identity", async () => {
    const identity = captureSourceIdentity(["pi", "machine", "conversation", "/session.jsonl"]);
    const decoyIdentity = captureSourceIdentity(["pi", "machine", "conversation", "/other.jsonl"]);
    const jsonl = "one\n";
    const { home, outbox } = seedFixture([
      {
        runId: "b".repeat(26),
        agentRuntime: "pi",
        conversationId: "conversation",
        sourceIdentity: decoyIdentity,
        jsonl,
      },
    ]);
    writeOutboxSource(outbox, "a".repeat(26), identity, jsonl);

    expect(await planReceipt(home, outbox)).toMatchObject({
      ok: true,
      readOnly: true,
      representatives: 1,
      archiveStatus: { covered: 0, suffix: 0, full: 1 },
    });
  });
});
