import { describe, expect, test } from "bun:test";
import * as claude from "./claude";
import * as codex from "./codex";
import * as cursor from "./cursor";
import * as pi from "./pi";

// All fixture lines are synthesized: real field structure, fake content.

const PI_SESSION_LINE = JSON.stringify({
  type: "session",
  version: "3",
  id: "01900000-0000-7000-8000-000000000001",
  timestamp: "2026-07-09T10:00:00.000Z",
  cwd: "/fake/project",
});

function piAssistantLine(overrides: { usage?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    type: "message",
    id: "fake-msg-1",
    parentId: "fake-msg-0",
    timestamp: "2026-07-09T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "synthetic reply" }],
      api: "fake-api",
      provider: "fake-provider",
      model: "fake-model-a",
      usage: overrides.usage ?? {
        input: 120,
        output: 30,
        cacheRead: 400,
        cacheWrite: 12,
        totalTokens: 562,
        cost: { input: 0.0012, output: 0.0034, cacheRead: 0, cacheWrite: 0, total: 0.0046 },
      },
      stopReason: "stop",
      timestamp: 1783418405000,
      responseId: "fake-response-1",
    },
  });
}

function claudeAssistantLine(overrides: { usage?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    parentUuid: "00000000-0000-4000-8000-000000000010",
    isSidechain: false,
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000011",
    timestamp: "2026-07-09T11:00:00.000Z",
    sessionId: "00000000-0000-4000-8000-000000000012",
    requestId: "fake-req-1",
    cwd: "/fake/project",
    version: "9.9.9",
    gitBranch: "main",
    message: {
      model: "fake-claude-model",
      id: "fake-api-msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "synthetic reply" }],
      stop_reason: "end_turn",
      usage: overrides.usage ?? {
        input_tokens: 8,
        cache_creation_input_tokens: 220,
        cache_read_input_tokens: 15000,
        output_tokens: 45,
        service_tier: "standard",
      },
    },
  });
}

const CODEX_SESSION_META_LINE = JSON.stringify({
  timestamp: "2026-07-09T12:00:00.000Z",
  type: "session_meta",
  payload: {
    id: "01900000-0000-7000-8000-000000000002",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/fake/project",
    originator: "fake",
    cli_version: "0.0.0",
    source: "fake",
    model_provider: "fake-provider",
  },
});

const CODEX_TURN_CONTEXT_LINE = JSON.stringify({
  timestamp: "2026-07-09T12:00:01.000Z",
  type: "turn_context",
  payload: { turn_id: "fake-turn-1", cwd: "/fake/project", model: "fake-codex-model", effort: "medium" },
});

function codexTokenCountLine(info: unknown): string {
  return JSON.stringify({
    timestamp: "2026-07-09T12:00:02.000Z",
    type: "event_msg",
    payload: { type: "token_count", info, rate_limits: null },
  });
}

const CODEX_USAGE_INFO = {
  total_token_usage: {
    input_tokens: 900,
    cached_input_tokens: 700,
    output_tokens: 150,
    reasoning_output_tokens: 40,
    total_tokens: 1050,
  },
  last_token_usage: {
    input_tokens: 300,
    cached_input_tokens: 250,
    output_tokens: 60,
    reasoning_output_tokens: 10,
    total_tokens: 360,
  },
  model_context_window: 200000,
};

const MALFORMED_LINES = ["{not json", "", "42", '"just a string"', '{"type":'];

describe("pi parser", () => {
  const ctx = { path: "/fake/home/.pi/agent/sessions/--fake--/2026-07-09T10-00-00-000Z_01900000-0000-7000-8000-0000000000aa.jsonl" };

  test("parses assistant usage with session id, model, provider, cost", () => {
    const events = pi.parseTranscriptLines([PI_SESSION_LINE, piAssistantLine()], ctx);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.runtime).toBe("pi");
    expect(event?.sessionId).toBe("01900000-0000-7000-8000-000000000001");
    expect(event?.model).toBe("fake-model-a");
    expect(event?.provider).toBe("fake-provider");
    expect(event?.timestampMs).toBe(1783418405000);
    expect(event?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 562,
      cacheReadTokens: 400,
      cacheWriteTokens: 12,
      costInput: 0.0012,
      costOutput: 0.0034,
      costTotal: 0.0046,
    });
  });

  test("falls back to filename uuid for session id", () => {
    const events = pi.parseTranscriptLines([piAssistantLine()], ctx);
    expect(events[0]?.sessionId).toBe("01900000-0000-7000-8000-0000000000aa");
  });

  test("skips malformed lines silently", () => {
    expect(pi.parseTranscriptLines(MALFORMED_LINES, ctx)).toHaveLength(0);
  });

  test("skips zero-usage lines", () => {
    const zero = piAssistantLine({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    });
    expect(pi.parseTranscriptLines([zero], ctx)).toHaveLength(0);
  });

  test("same line twice yields the same deterministic id", () => {
    const line = piAssistantLine();
    const [first] = pi.parseTranscriptLines([line], ctx);
    const [second] = pi.parseTranscriptLines([line], ctx);
    expect(first?.id).toBeDefined();
    expect(first?.id).toBe(second?.id as string);
  });
});

describe("claude parser", () => {
  const ctx = { path: "/fake/home/.claude/projects/-fake-project/00000000-0000-4000-8000-000000000012.jsonl" };

  test("parses assistant usage with session id and model", () => {
    const events = claude.parseTranscriptLines([claudeAssistantLine()], ctx);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.runtime).toBe("claude");
    expect(event?.sessionId).toBe("00000000-0000-4000-8000-000000000012");
    expect(event?.model).toBe("fake-claude-model");
    expect(event?.provider).toBe("anthropic");
    expect(event?.timestampMs).toBe(Date.parse("2026-07-09T11:00:00.000Z"));
    expect(event?.usage).toEqual({
      inputTokens: 8,
      outputTokens: 45,
      totalTokens: 8 + 45 + 15000 + 220,
      cacheReadTokens: 15000,
      cacheWriteTokens: 220,
    });
  });

  test("skips malformed lines silently", () => {
    expect(claude.parseTranscriptLines(MALFORMED_LINES, ctx)).toHaveLength(0);
  });

  test("skips zero-usage lines", () => {
    const zero = claudeAssistantLine({
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    expect(claude.parseTranscriptLines([zero], ctx)).toHaveLength(0);
  });

  test("same line twice yields the same deterministic id", () => {
    const line = claudeAssistantLine();
    const [first] = claude.parseTranscriptLines([line], ctx);
    const [second] = claude.parseTranscriptLines([line], ctx);
    expect(first?.id).toBeDefined();
    expect(first?.id).toBe(second?.id as string);
  });
});

describe("codex parser", () => {
  const ctx = { path: "/fake/home/.codex/sessions/2026/07/09/rollout-2026-07-09T12-00-00-01900000-0000-7000-8000-0000000000bb.jsonl" };

  test("parses token_count using last_token_usage with session/model context", () => {
    const events = codex.parseTranscriptLines(
      [CODEX_SESSION_META_LINE, CODEX_TURN_CONTEXT_LINE, codexTokenCountLine(CODEX_USAGE_INFO)],
      ctx
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.runtime).toBe("codex");
    expect(event?.sessionId).toBe("01900000-0000-7000-8000-000000000002");
    expect(event?.model).toBe("fake-codex-model");
    expect(event?.provider).toBe("openai");
    expect(event?.timestampMs).toBe(Date.parse("2026-07-09T12:00:02.000Z"));
    expect(event?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      totalTokens: 360,
      cacheReadTokens: 250,
    });
  });

  test("falls back to filename uuid for session id", () => {
    const events = codex.parseTranscriptLines([codexTokenCountLine(CODEX_USAGE_INFO)], ctx);
    expect(events[0]?.sessionId).toBe("01900000-0000-7000-8000-0000000000bb");
  });

  test("skips token_count lines with null info", () => {
    expect(codex.parseTranscriptLines([codexTokenCountLine(null)], ctx)).toHaveLength(0);
  });

  test("skips malformed lines silently", () => {
    expect(codex.parseTranscriptLines(MALFORMED_LINES, ctx)).toHaveLength(0);
  });

  test("skips zero-usage lines", () => {
    const zero = codexTokenCountLine({
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      model_context_window: 200000,
    });
    expect(codex.parseTranscriptLines([zero], ctx)).toHaveLength(0);
  });

  test("same line twice yields the same deterministic id", () => {
    const line = codexTokenCountLine(CODEX_USAGE_INFO);
    const [first] = codex.parseTranscriptLines([line], ctx);
    const [second] = codex.parseTranscriptLines([line], ctx);
    expect(first?.id).toBeDefined();
    expect(first?.id).toBe(second?.id as string);
  });
});

describe("cursor parser (stub)", () => {
  test("always returns zero events", () => {
    const ctx = { path: "/fake/home/.cursor/sessions/anything.jsonl" };
    expect(cursor.parseTranscriptLines([piAssistantLine(), claudeAssistantLine()], ctx)).toHaveLength(0);
  });

  test("transcript root honors HOME", () => {
    expect(cursor.transcriptRoot().startsWith(process.env.HOME ?? "")).toBe(true);
  });
});
