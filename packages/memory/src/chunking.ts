import type { Role } from "./types";

export interface Turn {
  role: Role;
  text: string;
  started_at: number;
  token_estimate: number;
}

export interface RawJsonlEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  role?: string;
  content?: unknown;
  message?: {
    role?: string;
    content?: string | unknown[];
  };
  toolUseResult?: unknown;
  isMeta?: boolean;
  [key: string]: unknown;
}

export type JsonlFormat = "claude-code" | "pi" | "grok";

const CLAUDE_META_TYPES = new Set([
  "permission-mode",
  "file-history-snapshot",
  "system",
  "attachment",
]);

const PI_META_TYPES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "permission_mode_change",
  "tool_approval",
  "skill_listing",
]);

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractTextFromContent(content: unknown): {
  text: string;
  hasToolUse: boolean;
  hasToolResult: boolean;
} {
  if (typeof content === "string") {
    return { text: content, hasToolUse: false, hasToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasToolUse: false, hasToolResult: false };
  }

  const parts: string[] = [];
  let hasToolUse = false;
  let hasToolResult = false;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    const partType = p.type;

    if (typeof p.text === "string" && partType !== "thinking") {
      parts.push(p.text);
    } else if (partType === "thinking" && typeof p.thinking === "string") {
      parts.push(`[thinking]\n${p.thinking}`);
    } else if (partType === "tool_use" || partType === "toolUse") {
      hasToolUse = true;
      const name = p.name ?? "unknown";
      const input = JSON.stringify(p.input ?? {});
      parts.push(`[tool_use:${name}] ${input}`);
    } else if (partType === "tool_result" || partType === "toolResult") {
      hasToolResult = true;
      const inner = p.content ?? p.text ?? p;
      const text =
        typeof inner === "string" ? inner : JSON.stringify(inner);
      parts.push(`[tool_result] ${text}`);
    }
  }
  return { text: parts.join("\n"), hasToolUse, hasToolResult };
}

export function parseJsonl(content: string): RawJsonlEntry[] {
  const entries: RawJsonlEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // tolerate malformed lines
    }
  }
  return entries;
}

export function detectFormat(entries: RawJsonlEntry[]): JsonlFormat {
  for (const entry of entries.slice(0, 20)) {
    if (entry.type === "session" || entry.type === "model_change") return "pi";
    if (entry.type === "permission-mode" || entry.type === "file-history-snapshot") {
      return "claude-code";
    }
  }
  // pi's "message" shape with role=user|assistant|toolResult vs claude-code's top-level type=user|assistant
  for (const entry of entries.slice(0, 50)) {
    if (entry.type === "message") return "pi";
    if (
      entry.type === "tool_result" ||
      entry.type === "backend_tool_call" ||
      (entry.type === "reasoning" && entry.content !== undefined) ||
      ((entry.type === "user" || entry.type === "assistant") &&
        entry.message?.role === undefined &&
        entry.content !== undefined)
    ) {
      return "grok";
    }
    if (entry.type === "user" || entry.type === "assistant") return "claude-code";
  }
  return "claude-code";
}

function extractTurnsClaudeCode(entries: RawJsonlEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    if (CLAUDE_META_TYPES.has(entry.type)) continue;
    if (entry.isMeta === true) continue;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();

    if (entry.type === "user" && entry.message?.role === "user") {
      const { text, hasToolResult } = extractTextFromContent(
        entry.message.content
      );
      if (!text.trim()) continue;
      const role: Role =
        hasToolResult || entry.toolUseResult !== undefined ? "tool" : "user";
      const clipped = text.slice(0, 32000);
      turns.push({
        role,
        text: clipped,
        started_at: ts,
        token_estimate: estimateTokens(clipped),
      });
    } else if (
      entry.type === "assistant" &&
      entry.message?.role === "assistant"
    ) {
      const { text, hasToolUse } = extractTextFromContent(entry.message.content);
      if (!text.trim()) continue;
      const role: Role = hasToolUse ? "tool" : "assistant";
      const clipped = text.slice(0, 32000);
      turns.push({
        role,
        text: clipped,
        started_at: ts,
        token_estimate: estimateTokens(clipped),
      });
    }
  }
  return turns;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  const record = recordValue(value);
  if (!record) return value == null ? "" : String(value);

  const content = record.content ?? record.text;
  if (content !== undefined) {
    const text = textValue(content);
    if (text) return text;
  }

  const summary = record.summary;
  if (summary !== undefined) {
    const text = textValue(summary);
    if (text) return text;
  }

  return JSON.stringify(record);
}

function timestampValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function extractTurnsGrok(entries: RawJsonlEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const role: Role | undefined =
      entry.type === "user"
        ? "user"
        : entry.type === "assistant" || entry.type === "reasoning"
          ? "assistant"
          : entry.type === "tool_result" || entry.type === "backend_tool_call"
            ? "tool"
            : undefined;
    if (!role) continue;

    const text = textValue(entry.content ?? entry.text ?? entry.message).trim();
    if (!text) continue;
    turns.push({
      role,
      text: text.slice(0, 32000),
      started_at: timestampValue(entry.timestamp),
      token_estimate: estimateTokens(text),
    });
  }
  return turns;
}

function extractTurnsPi(entries: RawJsonlEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    if (PI_META_TYPES.has(entry.type)) continue;
    if (entry.type !== "message") continue;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const msgRole = entry.message?.role;
    const { text } = extractTextFromContent(entry.message?.content);
    if (!text.trim()) continue;

    let role: Role = "assistant";
    if (msgRole === "user") role = "user";
    else if (msgRole === "toolResult" || msgRole === "tool_result") role = "tool";
    else if (msgRole === "assistant") role = "assistant";

    const clipped = text.slice(0, 32000);
    turns.push({
      role,
      text: clipped,
      started_at: ts,
      token_estimate: estimateTokens(clipped),
    });
  }
  return turns;
}

export function extractTurns(
  entries: RawJsonlEntry[],
  format?: JsonlFormat
): Turn[] {
  const fmt = format ?? detectFormat(entries);
  if (fmt === "pi") return extractTurnsPi(entries);
  if (fmt === "grok") return extractTurnsGrok(entries);
  return extractTurnsClaudeCode(entries);
}

export interface ChunkCandidate {
  chunk_idx: number;
  role: Role;
  text: string;
  started_at: number;
  token_count: number;
}

const MAX_CHUNK_TOKENS = 8000;

export function chunkTurns(turns: Turn[]): ChunkCandidate[] {
  const chunks: ChunkCandidate[] = [];

  turns.forEach((turn, idx) => {
    if (turn.token_estimate <= MAX_CHUNK_TOKENS) {
      chunks.push({
        chunk_idx: idx,
        role: turn.role,
        text: turn.text,
        started_at: turn.started_at,
        token_count: turn.token_estimate,
      });
      return;
    }

    const charsPerChunk = MAX_CHUNK_TOKENS * 4;
    const overlapChars = 400;
    let cursor = 0;
    let subIdx = 0;
    while (cursor < turn.text.length) {
      const slice = turn.text.slice(cursor, cursor + charsPerChunk);
      chunks.push({
        chunk_idx: idx * 1000 + subIdx,
        role: turn.role,
        text: slice,
        started_at: turn.started_at,
        token_count: estimateTokens(slice),
      });
      cursor += charsPerChunk - overlapChars;
      subIdx += 1;
    }
  });

  return chunks;
}
