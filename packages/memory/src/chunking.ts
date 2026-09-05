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
  payload?: unknown;
  message?: {
    role?: string;
    content?: string | unknown[];
  };
  toolUseResult?: unknown;
  isMeta?: boolean;
  [key: string]: unknown;
}

export type JsonlFormat = "claude-code" | "pi" | "codex" | "grok";

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
    if (
      entry.type === "response_item" ||
      entry.type === "event_msg" ||
      entry.type === "turn_context"
    ) {
      return "codex";
    }
    if (entry.type === "session" || entry.type === "model_change") return "pi";
    if (entry.type === "permission-mode" || entry.type === "file-history-snapshot") {
      return "claude-code";
    }
  }
  // Pi's "message" shape with role=user|assistant|toolResult vs Claude Code's
  // top-level type=user|assistant. Grok stores top-level content without a
  // nested message object and uses tool_result/reasoning event types.
  for (const entry of entries.slice(0, 50)) {
    if (entry.type === "message") return "pi";
    if (
      entry.type === "tool_result" ||
      entry.type === "backend_tool_call" ||
      entry.type === "reasoning" ||
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
    const entryRole = entry.message?.role ?? entry.role;
    const entryContent = entry.message?.content ?? entry.content;

    if (
      entry.type === "user" &&
      (entryRole === "user" || (entryRole === undefined && entryContent !== undefined))
    ) {
      const { text, hasToolResult } = extractTextFromContent(entryContent);
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
      (entryRole === "assistant" || (entryRole === undefined && entryContent !== undefined))
    ) {
      const { text, hasToolUse } = extractTextFromContent(entryContent);
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

function codexPayload(entry: RawJsonlEntry): Record<string, unknown> {
  return recordValue(entry.payload) ?? entry;
}

function codexTurnText(payload: Record<string, unknown>): string {
  const message = recordValue(payload.message);
  const content = message?.content ?? payload.content;
  if (content !== undefined) {
    const text = textValue(content);
    if (text) return text;
  }

  for (const key of ["last_agent_message", "message", "text", "summary"]) {
    const text = textValue(payload[key]);
    if (text) return text;
  }

  if (
    payload.type === "function_call" ||
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call" ||
    payload.type === "custom_tool_call_output" ||
    payload.type === "web_search_call" ||
    payload.type === "tool_search_call" ||
    payload.type === "tool_search_output"
  ) {
    return JSON.stringify(payload);
  }

  return "";
}

function codexResponseMessages(entries: RawJsonlEntry[]): Map<string, number[]> {
  const responseMessages = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.type !== "response_item") return;
    const payload = codexPayload(entry);
    if (payload.type !== "message") return;
    const message = recordValue(payload.message);
    const role =
      (typeof message?.role === "string" ? message.role : undefined) ??
      (typeof payload.role === "string" ? payload.role : undefined);
    if (role !== "user" && role !== "assistant") return;
    const text = codexTurnText(payload).trim();
    if (text) {
      const key = `${role}\u0000${text}`;
      responseMessages.set(key, [...(responseMessages.get(key) ?? []), index]);
    }
  });
  return responseMessages;
}

const hasNearbyCodexResponse = (
  responseMessages: ReadonlyMap<string, readonly number[]>,
  key: string,
  index: number,
) => responseMessages.get(key)?.some((position) => Math.abs(position - index) <= 3) === true;

export function countCodexDuplicateRepresentations(entries: RawJsonlEntry[]): number {
  const responseMessages = codexResponseMessages(entries);
  let duplicates = 0;
  entries.forEach((entry, index) => {
    if (entry.type !== "event_msg") return;
    const payload = codexPayload(entry);
    const type = typeof payload.type === "string" ? payload.type : entry.type;
    const role =
      type === "user_message" || type === "user"
        ? "user"
        : type === "agent_message" || type === "task_complete" || type === "assistant"
          ? "assistant"
          : undefined;
    if (role === undefined) return;
    const text = codexTurnText(payload).trim();
    if (text && hasNearbyCodexResponse(responseMessages, `${role}\u0000${text}`, index)) {
      duplicates += 1;
    }
  });
  return duplicates;
}

function extractTurnsCodex(entries: RawJsonlEntry[]): Turn[] {
  const turns: Turn[] = [];
  // Older Codex sessions repeat visible response_item messages as nearby
  // event_msg rows. Suppress only that local dual representation so a real
  // repeated message elsewhere in the Run remains searchable.
  const responseMessages = codexResponseMessages(entries);

  entries.forEach((entry, index) => {
    const payload = codexPayload(entry);
    const type = typeof payload.type === "string" ? payload.type : entry.type;
    const message = recordValue(payload.message);
    const messageRole =
      (typeof message?.role === "string" ? message.role : undefined) ??
      (typeof payload.role === "string" ? payload.role : undefined);

    let role: Role | undefined;
    if (type === "message") {
      if (messageRole === "user") role = "user";
      else if (messageRole === "assistant") role = "assistant";
    } else if (
      type === "function_call" ||
      type === "function_call_output" ||
      type === "custom_tool_call" ||
      type === "custom_tool_call_output" ||
      type === "web_search_call" ||
      type === "tool_search_call" ||
      type === "tool_search_output"
    ) {
      role = "tool";
    } else if (type === "user_message" || type === "user") {
      role = "user";
    } else if (
      type === "agent_message" ||
      type === "task_complete" ||
      type === "assistant" ||
      type === "reasoning"
    ) {
      role = "assistant";
    }

    if (!role) return;
    const text = codexTurnText(payload).trim();
    if (!text) return;
    if (
      entry.type === "event_msg" &&
      hasNearbyCodexResponse(responseMessages, `${role}\u0000${text}`, index)
    ) {
      return;
    }

    turns.push({
      role,
      text: text.slice(0, 32000),
      started_at: timestampValue(payload.timestamp ?? entry.timestamp),
      token_estimate: estimateTokens(text),
    });
  });
  return turns;
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
  switch (fmt) {
    case "pi":
      return extractTurnsPi(entries);
    case "codex":
      return extractTurnsCodex(entries);
    case "grok":
      return extractTurnsGrok(entries);
    case "claude-code":
      return extractTurnsClaudeCode(entries);
  }
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
  let chunkIndex = 0;

  turns.forEach((turn) => {
    if (turn.token_estimate <= MAX_CHUNK_TOKENS) {
      chunks.push({
        chunk_idx: chunkIndex,
        role: turn.role,
        text: turn.text,
        started_at: turn.started_at,
        token_count: turn.token_estimate,
      });
      chunkIndex += 1;
      return;
    }

    const charsPerChunk = MAX_CHUNK_TOKENS * 4;
    const overlapChars = 400;
    let cursor = 0;
    while (cursor < turn.text.length) {
      const slice = turn.text.slice(cursor, cursor + charsPerChunk);
      chunks.push({
        chunk_idx: chunkIndex,
        role: turn.role,
        text: slice,
        started_at: turn.started_at,
        token_count: estimateTokens(slice),
      });
      cursor += charsPerChunk - overlapChars;
      chunkIndex += 1;
    }
  });

  return chunks;
}
