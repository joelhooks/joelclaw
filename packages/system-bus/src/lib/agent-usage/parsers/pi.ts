import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentUsageEvent,
  type AgentUsageTokens,
  finiteNumber,
  hasUsageSignal,
  type ParseContext,
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

export function parseTranscriptLines(lines: string[], ctx: ParseContext): AgentUsageEvent[] {
  const events: AgentUsageEvent[] = [];
  let sessionId = sessionIdFromFilename(ctx.path);

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;

    if (parsed.type === "session" && typeof parsed.id === "string" && parsed.id.length > 0) {
      sessionId = parsed.id;
      continue;
    }

    if (parsed.type !== "message") continue;
    const message = parsed.message as PiMessage | undefined;
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const rawUsage = message.usage;
    if (!rawUsage || typeof rawUsage !== "object") continue;

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
    if (!hasUsageSignal(usage)) continue;

    const timestampMs = parseTimestampMs(message.timestamp) ?? parseTimestampMs(parsed.timestamp);
    if (timestampMs == null) continue;

    events.push({
      id: usageEventId("pi", ctx.path, line.trim()),
      timestampMs,
      runtime: "pi",
      sessionId,
      model: typeof message.model === "string" ? message.model : undefined,
      provider: typeof message.provider === "string" ? message.provider : undefined,
      usage,
      transcriptPath: ctx.path,
    });
  }

  return events;
}
