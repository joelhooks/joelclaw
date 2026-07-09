import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OtelEventInput } from "../../observability/otel-event";
import type { AgentUsageCaptureConfig } from "./config";
import { scanAgentUsage } from "./scanner";

// Synthesized fixture lines: real field structure, fake content.

function piAssistantLine(seq: number): string {
  return `${JSON.stringify({
    type: "message",
    id: `fake-msg-${seq}`,
    timestamp: "2026-07-09T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `synthetic reply ${seq}` }],
      provider: "fake-provider",
      model: "fake-model-a",
      usage: {
        input: 100 + seq,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120 + seq,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      },
      timestamp: 1783418400000 + seq,
    },
  })}\n`;
}

let workDir: string;
let roots: Record<"pi" | "claude" | "codex" | "cursor", string>;
let emitted: OtelEventInput[];

function makeConfig(overrides: Partial<AgentUsageCaptureConfig> = {}): AgentUsageCaptureConfig {
  return {
    agents: ["pi", "claude", "codex", "cursor"],
    maxFilesPerScan: 400,
    maxEventsPerScan: 5000,
    statePath: join(workDir, "state", "agent-usage-state.json"),
    lookbackHours: 24,
    ...overrides,
  };
}

async function scan(config: AgentUsageCaptureConfig, now?: number) {
  return scanAgentUsage({
    config,
    roots,
    now,
    emit: async (input) => {
      emitted.push(input);
      return { stored: true };
    },
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agent-usage-scanner-"));
  roots = {
    pi: join(workDir, "pi-sessions"),
    claude: join(workDir, "claude-projects"),
    codex: join(workDir, "codex-sessions"),
    cursor: join(workDir, "cursor-sessions"),
  };
  await mkdir(roots.pi, { recursive: true });
  emitted = [];
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("scanner", () => {
  test("offset resume: appended lines only are parsed on re-scan", async () => {
    const config = makeConfig();
    const transcript = join(roots.pi, "2026-07-09T10-00-00-000Z_01900000-0000-7000-8000-0000000000aa.jsonl");
    await writeFile(transcript, piAssistantLine(1), "utf8");

    const first = await scan(config);
    expect(first.emittedEvents).toBe(1);
    expect(emitted).toHaveLength(1);

    await appendFile(transcript, piAssistantLine(2), "utf8");
    const second = await scan(config);
    expect(second.emittedEvents).toBe(1);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.id).not.toBe(emitted[1]?.id);

    const third = await scan(config);
    expect(third.emittedEvents).toBe(0);
  });

  test("first-run lookback filter skips files older than the window", async () => {
    const config = makeConfig({ lookbackHours: 1 });
    const fresh = join(roots.pi, "fresh.jsonl");
    const stale = join(roots.pi, "stale.jsonl");
    await writeFile(fresh, piAssistantLine(1), "utf8");
    await writeFile(stale, piAssistantLine(2), "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    const summary = await scan(config);
    expect(summary.emittedEvents).toBe(1);
    expect(summary.scannedFiles).toBe(1);
  });

  test("state file round-trips offsets and mtimes", async () => {
    const config = makeConfig();
    const transcript = join(roots.pi, "roundtrip.jsonl");
    const line = piAssistantLine(1);
    await writeFile(transcript, line, "utf8");

    await scan(config);
    const state = JSON.parse(await readFile(config.statePath, "utf8")) as {
      files: Record<string, { offset: number; mtimeMs: number }>;
      lastScanMs: number;
    };
    expect(state.lastScanMs).toBeGreaterThan(0);
    expect(state.files[transcript]?.offset).toBe(Buffer.byteLength(line, "utf8"));
    expect(state.files[transcript]?.mtimeMs).toBeGreaterThan(0);

    const rescan = await scan(config);
    expect(rescan.emittedEvents).toBe(0);
  });

  test("maxEventsPerScan caps emission and carries the remainder", async () => {
    const config = makeConfig({ maxEventsPerScan: 2 });
    const transcript = join(roots.pi, "burst.jsonl");
    await writeFile(transcript, piAssistantLine(1) + piAssistantLine(2) + piAssistantLine(3), "utf8");

    const first = await scan(config);
    expect(first.emittedEvents).toBe(2);
    expect(first.parsedEvents).toBe(3);

    const second = await scan(config);
    expect(second.emittedEvents).toBe(1);
    expect(emitted).toHaveLength(3);
    expect(new Set(emitted.map((event) => event.id)).size).toBe(3);
  });

  test("maxFilesPerScan caps files and reports the dropped count", async () => {
    const config = makeConfig({ maxFilesPerScan: 1 });
    await writeFile(join(roots.pi, "one.jsonl"), piAssistantLine(1), "utf8");
    await writeFile(join(roots.pi, "two.jsonl"), piAssistantLine(2), "utf8");

    const summary = await scan(config);
    expect(summary.scannedFiles).toBe(1);
    expect(summary.droppedFiles).toBe(1);
    expect(summary.emittedEvents).toBe(1);
  });

  test("missing roots and unreadable dirs never throw", async () => {
    const config = makeConfig();
    await rm(roots.pi, { recursive: true, force: true });
    const summary = await scan(config);
    expect(summary.scannedFiles).toBe(0);
    expect(summary.emittedEvents).toBe(0);
  });

  test("emitted OTEL inputs follow the agent-usage contract", async () => {
    const config = makeConfig();
    await writeFile(join(roots.pi, "contract.jsonl"), piAssistantLine(1), "utf8");
    await scan(config);

    const input = emitted[0];
    expect(input?.source).toBe("agent-usage");
    expect(input?.component).toBe("agent-usage.pi");
    expect(input?.action).toBe("agent_usage.turn");
    expect(input?.success).toBe(true);
    expect(input?.timestamp).toBe(1783418400001);
    expect((input?.metadata as { runtime?: string })?.runtime).toBe("pi");
    expect((input?.metadata as { transcriptPath?: string })?.transcriptPath).toContain("contract.jsonl");
  });
});
