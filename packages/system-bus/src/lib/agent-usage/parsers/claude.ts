import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentUsageEvent,
  type AgentUsageTokens,
  finiteNumber,
  hasUsageSignal,
  type ParseContext,
  type AgentUsageParserState,
  parseJsonLine,
  parseTimestampMs,
  usageEventId,
} from "../types";

// Observed line shape (~/.claude/projects/**/*.jsonl):
// {"type":"assistant","timestamp":"<ISO>","sessionId":"<uuid>","message":{
//   "model":"...","usage":{"input_tokens":N,"output_tokens":N,
//   "cache_read_input_tokens":N,"cache_creation_input_tokens":N, ...}}, ...}

export function transcriptRoot(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude", "projects");
}

type ClaudeUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
};

type ClaudeMessage = {
  id?: unknown;
  model?: unknown;
  usage?: ClaudeUsage;
};

export function createState(_ctx: ParseContext): AgentUsageParserState {
  return { seenMessageIds: new Set() };
}

export function parseLine(
  line: string,
  ctx: ParseContext,
  state: AgentUsageParserState,
): AgentUsageEvent[] {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== "assistant") return [];

  const message = parsed.message as ClaudeMessage | undefined;
  if (!message || typeof message !== "object") return [];
  const rawUsage = message.usage;
  if (!rawUsage || typeof rawUsage !== "object") return [];

  const inputTokens = finiteNumber(rawUsage.input_tokens);
  const outputTokens = finiteNumber(rawUsage.output_tokens);
  const cacheReadTokens = finiteNumber(rawUsage.cache_read_input_tokens);
  const cacheWriteTokens = finiteNumber(rawUsage.cache_creation_input_tokens);
  const usage: AgentUsageTokens = {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens != null ||
      outputTokens != null ||
      cacheReadTokens != null ||
      cacheWriteTokens != null
        ? (inputTokens ?? 0) +
          (outputTokens ?? 0) +
          (cacheReadTokens ?? 0) +
          (cacheWriteTokens ?? 0)
        : undefined,
    cacheReadTokens,
    cacheWriteTokens,
  };
  if (!hasUsageSignal(usage)) return [];

  const timestampMs = parseTimestampMs(parsed.timestamp);
  if (timestampMs == null) return [];

  const messageId = typeof message.id === "string" && message.id.length > 0 ? message.id : null;
  if (messageId) {
    const seenMessageIds = (state.seenMessageIds ??= new Set());
    if (seenMessageIds.has(messageId)) return [];
    seenMessageIds.add(messageId);
  }

  return [
    {
      id: usageEventId("claude", ctx.path, messageId ?? line.trim()),
      timestampMs,
      runtime: "claude",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      model: typeof message.model === "string" ? message.model : undefined,
      provider: "anthropic",
      usage,
      transcriptPath: ctx.path,
    },
  ];
}

export function parseTranscriptLines(lines: string[], ctx: ParseContext): AgentUsageEvent[] {
  const state = createState(ctx);
  const events: AgentUsageEvent[] = [];
  for (const line of lines) events.push(...parseLine(line, ctx, state));
  return events;
}
