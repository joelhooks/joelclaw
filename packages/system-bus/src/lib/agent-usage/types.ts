import { createHash } from "node:crypto";
import type { AgentRuntimeName } from "./config";

export type AgentUsageTokens = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput?: number;
  costOutput?: number;
  costTotal?: number;
};

export type AgentUsageEvent = {
  /** Deterministic: sha256 of `${runtime}:${transcriptPath}:${lineAnchor}` — re-scans must not duplicate. */
  id: string;
  /** From the transcript line, not scan time. */
  timestampMs: number;
  runtime: AgentRuntimeName;
  sessionId?: string;
  model?: string;
  provider?: string;
  usage: AgentUsageTokens;
  transcriptPath: string;
};

export type ParseContext = {
  path: string;
};

export type AgentUsageParser = {
  transcriptRoot(): string;
  parseTranscriptLines(lines: string[], ctx: ParseContext): AgentUsageEvent[];
};

export function usageEventId(runtime: AgentRuntimeName, transcriptPath: string, lineAnchor: string): string {
  return createHash("sha256").update(`${runtime}:${transcriptPath}:${lineAnchor}`).digest("hex");
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function hasUsageSignal(usage: AgentUsageTokens): boolean {
  return Object.values(usage).some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const FILENAME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export function sessionIdFromFilename(path: string): string | undefined {
  return FILENAME_UUID.exec(path)?.[1];
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed line — caller skips silently
  }
  return undefined;
}
