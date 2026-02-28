import Langfuse from "langfuse";
import type { LangfuseTraceClient, LangfuseSpanClient } from "langfuse";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UsageLike = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type SessionType = "gateway" | "interactive" | "codex" | "central";

const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const SESSION_TYPE = getSessionType(CHANNEL);
const TRACE_TAGS = ["joelclaw", "pi-session"];
const FLUSH_INTERVAL_MS = 30_000;
let sessionId: string | null = null;
let lastTracedMessageId: string | null = null;

function getSessionType(channel: string): SessionType {
  const normalized = channel.toLowerCase();
  if (normalized === "gateway" || normalized === "central" || normalized === "codex" || normalized === "interactive") {
    return normalized;
  }
  return "interactive";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asUsage(candidate: unknown): UsageLike | null {
  if (!candidate || typeof candidate !== "object") return null;

  const usage = candidate as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
  };

  if (!isNumber(usage.input) || !isNumber(usage.output) || !isNumber(usage.totalTokens)) {
    return null;
  }

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: isNumber(usage.cacheRead) ? usage.cacheRead : 0,
    cacheWrite: isNumber(usage.cacheWrite) ? usage.cacheWrite : 0,
    totalTokens: usage.totalTokens,
  };
}

function getTraceTags(model?: { provider?: unknown; id?: unknown }): string[] {
  const tags: Array<string | undefined> = [
    ...TRACE_TAGS,
    `channel:${CHANNEL}`,
    `session:${SESSION_TYPE}`,
    typeof model?.provider === "string" ? `provider:${model.provider}` : undefined,
    typeof model?.id === "string" ? `model:${model.id}` : undefined,
  ];

  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

function extractText(content: unknown, maxLen = 2000): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content.slice(0, maxLen);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n");
  return text ? text.slice(0, maxLen) : undefined;
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "tool_use" && typeof b?.name === "string")
    .map((b: any) => b.name as string);
}

function extractToolResultSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content.filter(
    (b: any) => b?.type === "tool_result" && typeof b?.tool_use_id === "string",
  ).length;
  return results > 0 ? `[${results} tool result(s)]` : undefined;
}

/** Known single-line header keys we care about */
const HEADER_KEYS = new Set(["channel", "date", "platform_capabilities"]);

/** Strip ---\nChannel:...\n--- header from input, return clean text + parsed metadata */
function stripChannelHeader(text: string): { clean: string; headerMeta?: Record<string, string> } {
  const headerMatch = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!headerMatch) return { clean: text };

  const headerBlock = headerMatch[1];
  const meta: Record<string, string> = {};

  for (const line of headerBlock.split("\n")) {
    if (/^\s*-/.test(line)) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "_");
      const value = line.slice(colonIdx + 1).trim();
      if (key && value && HEADER_KEYS.has(key)) meta[key] = value;
    }
  }

  const clean = text.slice(headerMatch[0].length).trim();
  return { clean, headerMeta: Object.keys(meta).length > 0 ? meta : undefined };
}


const GLOBAL_KEY = "__langfuse_cost_loaded__";

export default function (pi: ExtensionAPI) {
  if ((globalThis as any)[GLOBAL_KEY]) {
    console.warn("langfuse-cost: skipping duplicate instance (already loaded)");
    return;
  }
  (globalThis as any)[GLOBAL_KEY] = true;
  let langfuse: Langfuse | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // --- Span hierarchy state ---
  // Session trace: one per pi session lifetime
  let sessionTrace: LangfuseTraceClient | null = null;
  let sessionSpan: LangfuseSpanClient | null = null;
  let sessionStartTime: Date | null = null;
  let sessionTurnCount = 0;

  // Message span: one per user→assistant exchange
  let messageSpan: LangfuseSpanClient | null = null;
  let messageStartTime: Date | null = null;
  let lastUserInput: string | undefined;
  let lastInputHeaderMeta: Record<string, string> | undefined;
  let lastAssistantStartTime: number | undefined;

  // Tool spans: one per tool_call→tool_result
  let pendingToolNames: string[] = [];
  let activeToolSpans: Map<string, LangfuseSpanClient> = new Map();

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    console.warn(
      "langfuse-cost: LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY missing; telemetry disabled.",
    );
  } else {
    try {
      langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
        environment: "production",
      });

      flushTimer = setInterval(() => {
        try {
          langfuse?.flush()?.catch?.(() => {}); // Swallow async flush failures silently
        } catch {
          // Swallow sync flush failures silently
        }
      }, FLUSH_INTERVAL_MS);
    } catch (error) {
      console.error("langfuse-cost: Failed to initialize Langfuse; telemetry disabled.", error);
      langfuse = null;
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
    }
  }

  // ─── SESSION SPAN ───────────────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? null;
      if (!langfuse || !sessionId) return;

      sessionStartTime = new Date();
      sessionTurnCount = 0;

      sessionTrace = langfuse.trace({
        name: "joelclaw.session",
        userId: "joel",
        sessionId,
        tags: getTraceTags(ctx.model),
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          model: ctx.model?.id,
          provider: ctx.model?.provider,
        },
      });

      sessionSpan = sessionTrace.span({
        name: "session",
        startTime: sessionStartTime,
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
        },
      });
    } catch {
      // ignore
    }
  });

  // ─── MESSAGE SPAN ──────────────────────────────────────────────
  pi.on("message_start", (event, _ctx) => {
    try {
      const message = event.message;
      if (!message || typeof message !== "object") return;

      const role = (message as { role?: unknown }).role;

      if (role === "assistant") {
        lastAssistantStartTime = Date.now();
        return;
      }

      if (role !== "user") return;

      // Start a new message span for this user→assistant exchange
      messageStartTime = new Date();
      const parentSpan = sessionSpan || sessionTrace;

      const content = (message as { content?: unknown }).content;
      const extracted = extractText(content);
      if (extracted !== undefined) {
        const { clean, headerMeta } = stripChannelHeader(extracted);
        lastUserInput = clean || extracted;
        lastInputHeaderMeta = headerMeta;
      } else {
        const toolSummary = extractToolResultSummary(content);
        if (toolSummary !== undefined) {
          lastUserInput = toolSummary;
        }
      }

      if (parentSpan && langfuse) {
        // End previous message span if still open (shouldn't happen, but safety)
        if (messageSpan) {
          try { messageSpan.end(); } catch { /* ignore */ }
        }

        sessionTurnCount++;
        messageSpan = parentSpan.span({
          name: `turn-${sessionTurnCount}`,
          startTime: messageStartTime,
          input: lastUserInput,
          metadata: {
            turnIndex: sessionTurnCount,
            ...(lastInputHeaderMeta ? { sourceChannel: lastInputHeaderMeta } : {}),
          },
        });
      }
    } catch {
      // ignore
    }
  });

  // ─── TOOL SPANS ────────────────────────────────────────────────
  pi.on("tool_call", (event, _ctx) => {
    try {
      const toolName = (event as any)?.toolName;
      const toolCallId = (event as any)?.toolCallId;
      if (typeof toolName === "string" && toolName) {
        pendingToolNames.push(toolName);

        // Create a child span under the current message span
        const parent = messageSpan || sessionSpan || sessionTrace;
        if (parent && typeof toolCallId === "string") {
          const toolSpan = parent.span({
            name: `tool:${toolName}`,
            startTime: new Date(),
            input: (event as any)?.input,
            metadata: { toolName, toolCallId },
          });
          activeToolSpans.set(toolCallId, toolSpan);
        }
      }
    } catch {
      // ignore
    }
  });

  pi.on("tool_result" as any, (event: any, _ctx: any) => {
    try {
      const toolCallId = event?.toolCallId ?? event?.toolUseId;
      if (typeof toolCallId === "string" && activeToolSpans.has(toolCallId)) {
        const toolSpan = activeToolSpans.get(toolCallId)!;
        const output = extractText(event?.result ?? event?.content) ?? event?.output;
        toolSpan.end({
          output: typeof output === "string" ? output.slice(0, 500) : undefined,
        });
        activeToolSpans.delete(toolCallId);
      }
    } catch {
      // ignore
    }
  });

  // ─── GENERATION (LLM CALL) ────────────────────────────────────
  pi.on("message_end", (event, ctx) => {
    if (!langfuse) return;

    try {
      if (!sessionId) {
        try {
          sessionId = ctx.sessionManager.getSessionId() ?? null;
        } catch { /* ignore */ }
      }

      const message = event.message;
      if (!message || typeof message !== "object") return;
      if ((message as { role?: unknown }).role !== "assistant") return;

      const usage = asUsage((message as { usage?: unknown }).usage);
      if (!usage) return;

      // Dedup guard
      const u = asUsage((message as { usage?: unknown }).usage);
      const dedupKey = u ? `${u.input}-${u.output}-${u.totalTokens}-${u.cacheRead}` : null;
      if (dedupKey && dedupKey === lastTracedMessageId) return;
      if (dedupKey) lastTracedMessageId = dedupKey;

      const stopReason = (message as { stopReason?: unknown }).stopReason;
      const content = (message as { content?: unknown }).content;
      const toolNames = pendingToolNames.length > 0 ? [...pendingToolNames] : extractToolNames(content);
      pendingToolNames = [];

      const outputText = extractText(content);
      const output =
        outputText ||
        (toolNames.length > 0 ? `[${toolNames.join(", ")}]` : undefined) ||
        (typeof stopReason === "string" ? `[${stopReason}]` : undefined);
      const input = lastUserInput ?? (stopReason === "toolUse" ? "[tool continuation]" : undefined);
      const completionStartTime = lastAssistantStartTime
        ? new Date(lastAssistantStartTime)
        : undefined;

      // If no session trace exists (session_start missed), create a standalone trace
      if (!sessionTrace) {
        sessionTrace = langfuse.trace({
          name: "joelclaw.session",
          userId: "joel",
          sessionId: sessionId ?? undefined,
          tags: getTraceTags(ctx.model),
          metadata: {
            channel: CHANNEL,
            sessionType: SESSION_TYPE,
            component: "pi-session",
            model: ctx.model?.id,
            provider: ctx.model?.provider,
          },
        });
      }

      // Generation is a child of the message span (or session span)
      const parent = messageSpan || sessionSpan || sessionTrace;

      const generation = parent.generation({
        name: "llm.call",
        model: ctx.model?.id,
        input,
        output,
        completionStartTime,
        endTime: new Date(),
        usageDetails: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cache_read_input_tokens: usage.cacheRead,
          cache_write_input_tokens: usage.cacheWrite,
        },
        metadata: {
          provider: ctx.model?.provider,
          stopReason,
          ...(toolNames.length > 0 ? { tools: toolNames } : {}),
        },
      });
      generation.end();

      // Update message span output when we get a text response (end of turn)
      if (messageSpan && outputText && stopReason !== "toolUse") {
        messageSpan.end({
          output: outputText,
        });
        messageSpan = null;
      }

      // Update session trace with latest state
      sessionTrace.update({
        output: `${sessionTurnCount} turns`,
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          turnCount: sessionTurnCount,
        },
      });

      lastAssistantStartTime = undefined;
      lastInputHeaderMeta = undefined;
    } catch (error) {
      console.error("langfuse-cost: Failed to process message_end", error);
    }
  });

  // ─── SESSION SHUTDOWN ──────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (!langfuse) return;

    try {
      // End any open tool spans
      activeToolSpans.forEach((span) => {
        try { span.end(); } catch { /* ignore */ }
      });
      activeToolSpans.clear();

      // End message span if open
      if (messageSpan) {
        try { messageSpan.end(); } catch { /* ignore */ }
        messageSpan = null;
      }

      // End session span
      if (sessionSpan) {
        try {
          sessionSpan.end({
            output: `${sessionTurnCount} turns`,
            metadata: { turnCount: sessionTurnCount },
          });
        } catch { /* ignore */ }
        sessionSpan = null;
      }

      // Final trace update
      if (sessionTrace) {
        try {
          sessionTrace.update({
            output: `Session ended after ${sessionTurnCount} turns`,
          });
        } catch { /* ignore */ }
        sessionTrace = null;
      }

      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      await langfuse.shutdownAsync();
    } catch (error) {
      console.error("langfuse-cost: Failed to shutdown Langfuse", error);
    }
  });
}
