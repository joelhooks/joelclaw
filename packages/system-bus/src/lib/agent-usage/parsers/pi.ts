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
  sessionIdFromFilename,
  usageEventId,
} from "../types";

// Observed line shape (~/.pi/agent/sessions/**/*.jsonl):
// {"type":"message","id":"...","timestamp":"<ISO>","message":{"role":"assistant",
//   "provider":"...","model":"...","usage":{"input":N,"output":N,"cacheRead":N,
//   "cacheWrite":N,"totalTokens":N,"cost":{"input":F,"output":F,"total":F}},
//   "timestamp":<epoch ms>}}
// First line: {"type":"session","id":"<uuid>", ...}

export function transcriptRoot(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".pi", "agent", "sessions");
}

type PiUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { input?: unknown; output?: unknown; total?: unknown };
};

type PiMessage = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  timestamp?: unknown;
  usage?: PiUsage;
};

export function createState(ctx: ParseContext): AgentUsageParserState {
  return { sessionId: sessionIdFromFilename(ctx.path) };
}

export function parseLine(
  line: string,
  ctx: ParseContext,
  state: AgentUsageParserState,
): AgentUsageEvent[] {
  const parsed = parseJsonLine(line);
  if (!parsed) return [];

  if (parsed.type === "session" && typeof parsed.id === "string" && parsed.id.length > 0) {
    state.sessionId = parsed.id;
    return [];
  }

  if (parsed.type !== "message") return [];
  const message = parsed.message as PiMessage | undefined;
  if (!message || typeof message !== "object" || message.role !== "assistant") return [];
  const rawUsage = message.usage;
  if (!rawUsage || typeof rawUsage !== "object") return [];

  const cost = rawUsage.cost && typeof rawUsage.cost === "object" ? rawUsage.cost : undefined;
  const usage: AgentUsageTokens = {
    inputTokens: finiteNumber(rawUsage.input),
    outputTokens: finiteNumber(rawUsage.output),
    totalTokens: finiteNumber(rawUsage.totalTokens),
    cacheReadTokens: finiteNumber(rawUsage.cacheRead),
    cacheWriteTokens: finiteNumber(rawUsage.cacheWrite),
    costInput: finiteNumber(cost?.input),
    costOutput: finiteNumber(cost?.output),
    costTotal: finiteNumber(cost?.total),
  };
  if (!hasUsageSignal(usage)) return [];

  const timestampMs = parseTimestampMs(message.timestamp) ?? parseTimestampMs(parsed.timestamp);
  if (timestampMs == null) return [];

  return [
    {
      id: usageEventId("pi", ctx.path, line.trim()),
      timestampMs,
      runtime: "pi",
      sessionId: state.sessionId,
      model: typeof message.model === "string" ? message.model : undefined,
      provider: typeof message.provider === "string" ? message.provider : undefined,
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
