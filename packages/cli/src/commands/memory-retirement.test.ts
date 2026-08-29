import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts");
const MEMORY_REVIEW_COMMAND = "joelclaw memory review --since 48h";
const RECALL_OTEL_COMMAND =
  'joelclaw otel search "memory.recall.completed" --hours 24 --component recall-cli --limit 20';
const RETIRED_COMMAND_PREFIXES = [
  "joelclaw memory write",
  "joelclaw memory recent",
  "joelclaw memory scorecard",
];

type MemoryEnvelope = {
  ok: boolean;
  command: string;
  result: unknown;
  error?: { code?: string };
  next_actions: Array<{ command: string; description: string }>;
};

function createCriticalDb(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE documents (
        rowid INTEGER PRIMARY KEY,
        stable_id TEXT NOT NULL UNIQUE,
        collection TEXT NOT NULL,
        document_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        path TEXT,
        run_id TEXT,
        session_id TEXT,
        privacy TEXT NOT NULL,
        created_at INTEGER,
        source_updated_at INTEGER,
        payload_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title, content, source, path,
        content='documents', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      INSERT INTO metadata (key, value) VALUES
        ('schema_version', '2'),
        ('built_at', '2026-08-29T00:00:00.000Z'),
        ('document_count', '1'),
        ('sources_json', '{}'),
        ('coverage_gaps_json', '[]');
      INSERT INTO documents (
        stable_id, collection, document_id, type, title, content, source, source_key,
        path, run_id, session_id, privacy, created_at, source_updated_at, payload_json
      ) VALUES (
        'brain_pages:fixture', 'brain_pages', 'fixture', 'brain_page',
        'Retirement fixture', 'retirement fixture memory result', 'test', 'test',
        NULL, NULL, NULL, 'private', 1787961600, 1787961600, '{}'
      );
      INSERT INTO documents_fts(documents_fts) VALUES('rebuild');
    `);
  } finally {
    db.close();
  }
}

function runMemory(
  args: string[],
  options: { withRecallFixture?: boolean } = {},
): {
  envelope: MemoryEnvelope;
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "joelclaw-memory-retirement-"));
  try {
    const preload = join(sandbox, "block-network.ts");
    writeFileSync(
      preload,
      'globalThis.fetch = (() => { throw new Error("NETWORK_CALL_ATTEMPTED") }) as typeof fetch\n',
    );

    const criticalDb = join(sandbox, "critical.db");
    if (options.withRecallFixture) {
      mkdirSync(join(sandbox, ".joelclaw"), { recursive: true });
      writeFileSync(
        join(sandbox, ".joelclaw", "config.toml"),
        '[capabilities.recall]\nadapter = "typesense-recall"\n',
      );
      createCriticalDb(criticalDb);
    }

    const result = spawnSync(
      "bun",
      [`--preload=${preload}`, "run", CLI_ENTRY, "memory", ...args, "--json"],
      {
        cwd: sandbox,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: sandbox,
          INNGEST_EVENT_KEY: "must-not-be-used",
          INNGEST_BASE_URL: "http://127.0.0.1:1",
          TYPESENSE_URL: "http://127.0.0.1:1",
          JOELCLAW_CRITICAL_DB: criticalDb,
          JOELCLAW_CRITICAL_SEARCH_REPLICAS: "",
          JOELCLAW_RECALL_OTEL: "0",
          JOELCLAW_SESSIONS_DB: join(sandbox, "missing-sessions.db"),
        },
      },
    );

    return {
      envelope: JSON.parse(result.stdout) as MemoryEnvelope,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function expectNoRetiredNextActions(envelope: MemoryEnvelope): void {
  for (const action of envelope.next_actions) {
    expect(RETIRED_COMMAND_PREFIXES.some((prefix) => action.command.startsWith(prefix))).toBe(
      false,
    );
  }
}

describe("retired memory commands", () => {
  test("direct write stays a typed compatibility pointer", () => {
    const result = runMemory(["write", "retirement-fixture"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe("MEMORY_WRITE_RETIRED");
    expect(result.stdout).not.toContain("run_id");
    expect(result.stdout).not.toContain("NETWORK_CALL_ATTEMPTED");
  });

  test.each([
    {
      command: "recent",
      args: ["recent", "--hours", "24", "--count", "10"],
      code: "MEMORY_RECENT_RETIRED",
    },
    {
      command: "scorecard",
      args: ["scorecard", "--hours", "24"],
      code: "MEMORY_SCORECARD_RETIRED",
    },
  ])("$command returns a typed retirement pointer without network access", ({ args, code }) => {
    const result = runMemory(args);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe(code);
    expect(result.envelope.next_actions.map((action) => action.command)).toEqual([
      MEMORY_REVIEW_COMMAND,
      RECALL_OTEL_COMMAND,
    ]);
    expect(result.stdout).not.toContain("NETWORK_CALL_ATTEMPTED");
    expectNoRetiredNextActions(result.envelope);
  });

  test("root memory help separates live operations from retired pointers", () => {
    const result = runMemory([]);
    const root = result.envelope.result as {
      usage: string[];
      retired: Array<{ command: string; status: string }>;
    };

    expect(result.status).toBe(0);
    expect(root.usage).toEqual([
      'joelclaw memory search "<query>"',
      "joelclaw memory review --since 48h",
      'joelclaw recall "<query>"',
    ]);
    expect(root.retired.map(({ command, status }) => ({ command, status }))).toEqual([
      { command: "joelclaw memory write", status: "retired" },
      { command: "joelclaw memory recent", status: "retired" },
      { command: "joelclaw memory scorecard", status: "retired" },
    ]);
    expectNoRetiredNextActions(result.envelope);
  });

  test("memory search recommends only live follow-up commands", () => {
    const result = runMemory(["search", "retirement fixture"], { withRecallFixture: true });

    expect(result.status).toBe(0);
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.next_actions.map((action) => action.command)).toContain(
      MEMORY_REVIEW_COMMAND,
    );
    expect(
      result.envelope.next_actions.some((action) => action.command.startsWith("joelclaw recall")),
    ).toBe(true);
    expectNoRetiredNextActions(result.envelope);
    expect(result.stdout).not.toContain("NETWORK_CALL_ATTEMPTED");
  });
});
