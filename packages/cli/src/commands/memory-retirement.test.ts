import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts");
const MEMORY_REVIEW_COMMAND = "joelclaw memory review --since 48h";
const RECALL_OTEL_COMMAND =
  'joelclaw otel search "memory.recall.completed" --hours 24 --component recall-cli --limit 20';
const RETIRED_COMMAND_PREFIXES = [
  "joelclaw memory write",
  "joelclaw memory search",
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

function runMemory(args: string[]): {
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
    expect(root.usage).toEqual(["joelclaw memory review --since 48h", 'joelclaw recall "<query>"']);
    expect(root.retired).toEqual([
      {
        command: "joelclaw memory write",
        status: "retired",
        replacement: "Curate durable knowledge as a Brain .svx page",
      },
      {
        command: "joelclaw memory search",
        status: "retired",
        replacement: 'joelclaw recall "<query>"',
      },
      {
        command: "joelclaw memory recent",
        status: "retired",
        replacement: MEMORY_REVIEW_COMMAND,
      },
      {
        command: "joelclaw memory scorecard",
        status: "retired",
        replacement: RECALL_OTEL_COMMAND,
      },
    ]);
    expectNoRetiredNextActions(result.envelope);
  });

  test.each([
    { name: "without compatibility flags", args: ["search", "sensitive-query-cycle-07"] },
    {
      name: "with compatibility flags",
      args: ["search", "sensitive-query-cycle-07", "--limit", "10", "--category", "ops", "--raw"],
    },
  ])("memory search retires safely $name", ({ args }) => {
    const result = runMemory(args);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe("MEMORY_SEARCH_RETIRED");
    expect(result.envelope.next_actions.map((action) => action.command)).toEqual([
      'joelclaw recall "<query>"',
      "joelclaw recall --request-file -",
      MEMORY_REVIEW_COMMAND,
    ]);
    expect(result.stdout).not.toContain("sensitive-query-cycle-07");
    expect(result.stdout).not.toContain("NETWORK_CALL_ATTEMPTED");
    expectNoRetiredNextActions(result.envelope);
  });
});
