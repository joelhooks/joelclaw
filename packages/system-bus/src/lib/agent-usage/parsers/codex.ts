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

// Observed line shapes (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl):
// {"timestamp":"<ISO>","type":"event_msg","payload":{"type":"token_count","info":{
//   "total_token_usage":{...},"last_token_usage":{"input_tokens":N,
//   "cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N,
//   "total_tokens":N},"model_context_window":N},"rate_limits":{...}}}
// info may be null — those lines carry no usage.
// {"type":"session_meta","payload":{"id":"<uuid>", ...}}
// {"type":"turn_context","payload":{"model":"...", ...}}

export function transcriptRoot(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".codex", "sessions");
}

type CodexTokenUsage = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
};

type CodexPayload = {
  type?: unknown;
  id?: unknown;
  model?: unknown;
  info?: {
    total_token_usage?: CodexTokenUsage;
    last_token_usage?: CodexTokenUsage;
  } | null;
};

export function parseTranscriptLines(lines: string[], ctx: ParseContext): AgentUsageEvent[] {
  const events: AgentUsageEvent[] = [];
  let sessionId = sessionIdFromFilename(ctx.path);
  let model: string | undefined;

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    const payload = parsed.payload as CodexPayload | undefined;
    if (!payload || typeof payload !== "object") continue;

    if (parsed.type === "session_meta" && typeof payload.id === "string" && payload.id.length > 0) {
      sessionId = payload.id;
      continue;
    }
    if (parsed.type === "turn_context" && typeof payload.model === "string" && payload.model.length > 0) {
      model = payload.model;
      continue;
    }

    if (parsed.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!info || typeof info !== "object") continue;
    const turnUsage = info.last_token_usage;
    if (!turnUsage || typeof turnUsage !== "object") continue;

    const usage: AgentUsageTokens = {
      inputTokens: finiteNumber(turnUsage.input_tokens),
      outputTokens: finiteNumber(turnUsage.output_tokens),
      totalTokens: finiteNumber(turnUsage.total_tokens),
      cacheReadTokens: finiteNumber(turnUsage.cached_input_tokens),
    };
    if (!hasUsageSignal(usage)) continue;

    const timestampMs = parseTimestampMs(parsed.timestamp);
    if (timestampMs == null) continue;

    events.push({
      id: usageEventId("codex", ctx.path, line.trim()),
      timestampMs,
      runtime: "codex",
      sessionId,
      model,
      provider: "openai",
      usage,
      transcriptPath: ctx.path,
    });
  }

  return events;
}
