import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OtelEventInput } from "../../observability/otel-event";
import type { AgentUsageCaptureConfig } from "./config";
import type { AgentUsageEvent, AgentUsageParser, AgentUsageParserState } from "./types";
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

  test("parses each line once and stops at the first event beyond the budget", async () => {
    const config = makeConfig({ agents: ["pi"], maxEventsPerScan: 1 });
    const transcript = join(roots.pi, "single-pass.jsonl");
    const lines = [...Array.from({ length: 200 }, () => "ignored"), "event-1", "event-2", "after"];
    await writeFile(transcript, `${lines.join("\n")}\n`, "utf8");

    let parseLineCalls = 0;
    const parseLine = (
      line: string,
      ctx: { path: string },
      _state: AgentUsageParserState,
    ): AgentUsageEvent[] => {
      parseLineCalls += 1;
      return line.startsWith("event-")
        ? [
            {
              id: line,
              timestampMs: 1,
              runtime: "pi",
              usage: { totalTokens: 1 },
              transcriptPath: ctx.path,
            },
          ]
        : [];
    };
    const parser: AgentUsageParser = {
      transcriptRoot: () => roots.pi,
      createState: () => ({}),
      parseLine,
      parseTranscriptLines: (input, ctx) => {
        const state: AgentUsageParserState = {};
        return input.flatMap((line) => parseLine(line, ctx, state));
      },
    };

    const first = await scanAgentUsage({
      config,
      roots,
      parsers: { pi: parser },
      emit: async (input) => {
        emitted.push(input);
        return { stored: true };
      },
    });

    expect(first).toMatchObject({ parsedEvents: 2, emittedEvents: 1 });
    expect(parseLineCalls).toBe(202);

    const second = await scanAgentUsage({
      config,
      roots,
      parsers: { pi: parser },
      emit: async (input) => {
        emitted.push(input);
        return { stored: true };
      },
    });
    expect(second.emittedEvents).toBe(1);
    expect(emitted.map((event) => event.id)).toEqual(["event-1", "event-2"]);
  });

  test("reads across bounded chunks and preserves complete-line offsets", async () => {
    const config = makeConfig({ agents: ["pi"] });
    const transcript = join(roots.pi, "chunk-boundary.jsonl");
    const contents = `${JSON.stringify({ type: "ignored", padding: "x".repeat(90) })}\n${piAssistantLine(1)}`;
    await writeFile(transcript, contents, "utf8");

    const summary = await scanAgentUsage({
      config,
      roots,
      limits: { readChunkBytes: 16, maxUnreadBytesPerFile: 512, maxReadBytesPerScan: 512 },
      emit: async (input) => {
        emitted.push(input);
        return { stored: true };
      },
    });

    expect(summary.emittedEvents).toBe(1);
    const state = JSON.parse(await readFile(config.statePath, "utf8")) as {
      files: Record<string, { offset: number }>;
    };
    expect(state.files[transcript]?.offset).toBe(Buffer.byteLength(contents, "utf8"));
  });

  test("caps total bytes read per scan and resumes at the last complete line", async () => {
    const config = makeConfig({ agents: ["pi"] });
    const transcript = join(roots.pi, "read-budget.jsonl");
    const contents = "skip\nevent\nskip\nevent\nskip\nevent\n";
    await writeFile(transcript, contents, "utf8");

    const parseLine = (
      line: string,
      ctx: { path: string },
      _state: AgentUsageParserState,
    ): AgentUsageEvent[] =>
      line === "event"
        ? [{
            id: `${ctx.path}:${line}`,
            timestampMs: 1,
            runtime: "pi",
            usage: { totalTokens: 1 },
            transcriptPath: ctx.path,
          }]
        : [];
    const parser: AgentUsageParser = {
      transcriptRoot: () => roots.pi,
      createState: () => ({}),
      parseLine,
      parseTranscriptLines: (lines, ctx) => {
        const state: AgentUsageParserState = {};
        return lines.flatMap((line) => parseLine(line, ctx, state));
      },
    };
    const limits = { readChunkBytes: 4, maxUnreadBytesPerFile: 128, maxReadBytesPerScan: 20 };
    const options = {
      config,
      roots,
      parsers: { pi: parser },
      limits,
      emit: async (input: OtelEventInput) => {
        emitted.push(input);
        return { stored: true };
      },
    };

    const first = await scanAgentUsage(options);
    const firstState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      files: Record<string, { offset: number }>;
    };
    expect(first.emittedEvents).toBe(1);
    expect(firstState.files[transcript]?.offset).toBe(16);

    const second = await scanAgentUsage(options);
    const secondState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      files: Record<string, { offset: number }>;
    };
    expect(second.emittedEvents).toBe(2);
    expect(emitted).toHaveLength(3);
    expect(firstState.files[transcript]?.offset).toBeLessThan(Buffer.byteLength(contents, "utf8"));
    expect(secondState.files[transcript]?.offset).toBe(Buffer.byteLength(contents, "utf8"));
  });

  test("preserves Codex session and model context while streaming transcript lines", async () => {
    const config = makeConfig({ agents: ["codex"] });
    await mkdir(roots.codex, { recursive: true });
    const transcript = join(roots.codex, "rollout-fixture.jsonl");
    const sessionId = "01900000-0000-7000-8000-000000000002";
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
      JSON.stringify({ type: "turn_context", payload: { model: "fake-codex-model" } }),
      JSON.stringify({
        timestamp: "2026-07-09T12:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
        },
      }),
    ].join("\n") + "\n";
    await writeFile(transcript, contents, "utf8");

    const summary = await scanAgentUsage({
      config,
      roots,
      limits: { readChunkBytes: 16, maxUnreadBytesPerFile: 1024, maxReadBytesPerScan: 2048 },
      emit: async (input) => {
        emitted.push(input);
        return { stored: true };
      },
    });

    expect(summary.emittedEvents).toBe(1);
    expect((emitted[0]?.metadata as { model?: string }).model).toBe("fake-codex-model");
    expect(emitted[0]?.sessionId).toBe(sessionId);
  });

  test("marks an oversized unread remainder and does not retry it every scan", async () => {
    const config = makeConfig({ agents: ["pi"] });
    const transcript = join(roots.pi, "oversized.jsonl");
    const contents = "x\n".repeat(65);
    await writeFile(transcript, contents, "utf8");

    const limits = { readChunkBytes: 16, maxUnreadBytesPerFile: 128, maxReadBytesPerScan: 256 };
    const first = await scanAgentUsage({
      config,
      roots,
      limits,
      emit: async () => ({ stored: true }),
    });
    expect(first.oversizedFiles).toBe(1);
    expect(first.skippedBytes).toBe(Buffer.byteLength(contents, "utf8"));

    const state = JSON.parse(await readFile(config.statePath, "utf8")) as {
      files: Record<string, { offset: number; skipped?: { reason: string; bytes: number } }>;
    };
    expect(state.files[transcript]).toMatchObject({
      offset: Buffer.byteLength(contents, "utf8"),
      skipped: { reason: "unread-remainder-limit", bytes: Buffer.byteLength(contents, "utf8") },
    });

    const second = await scanAgentUsage({
      config,
      roots,
      limits,
      emit: async () => ({ stored: true }),
    });
    expect(second.scannedFiles).toBe(0);
    expect(second.oversizedFiles).toBe(0);

    await appendFile(transcript, piAssistantLine(1), "utf8");
    const later = new Date(Date.now() + 5_000);
    await utimes(transcript, later, later);
    const third = await scanAgentUsage({
      config,
      roots,
      limits: { ...limits, maxUnreadBytesPerFile: 512, maxReadBytesPerScan: 1024 },
      emit: async (input) => {
        emitted.push(input);
        return { stored: true };
      },
    });
    expect(third.emittedEvents).toBe(1);
    expect(emitted).toHaveLength(1);
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
