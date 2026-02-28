import { mkdirSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { initTracing, getCatalogModel as resolveModelFromCatalog } from "@joelclaw/inference-router";
import { init as initMessageStore, trimOld } from "@joelclaw/message-store";
import { ModelFallbackController, type TelemetryEmitter } from "@joelclaw/model-fallback";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { getModel } from "@mariozechner/pi-ai";
import { calculateContextTokens, createAgentSession, DefaultResourceLoader, getLastAssistantUsage, type LoadExtensionsResult, SessionManager } from "@mariozechner/pi-coding-agent";
import { fetchChannel as fetchDiscordChannel, getClient as getDiscordClient, markError as markDiscordError, parseChannelId as parseDiscordChannelId, send as sendDiscord, shutdown as shutdownDiscord, start as startDiscord } from "./channels/discord";
import { send as sendIMessage, shutdown as shutdownIMessage, start as startIMessage } from "./channels/imessage";
import { getRedisClient, isHealthy as isRedisHealthy, shutdown as shutdownRedisChannel, start as startRedisChannel } from "./channels/redis";
import { isStarted as isSlackStarted, send as sendSlack, shutdown as shutdownSlack, start as startSlack } from "./channels/slack";
import { getBot, parseChatId, send as sendTelegram, sendMedia as sendTelegramMedia, shutdown as shutdownTelegram, start as startTelegram } from "./channels/telegram";
import {
  drain,
  enqueue,
  getActiveSource,
  getConsecutiveFailures,
  getQueueDepth,
  onContextOverflowRecovery,
  onPrompt,
  onError as onQueueError,
  replayUnacked,
  setIdleWaiter,
  setSession,
} from "./command-queue";
import { defaultGatewayConfig, loadGatewayConfig, providerForModel } from "./commands/config";
import { getActiveDiscordMcqAdapter, registerDiscordMcqAdapter } from "./commands/discord-mcq-adapter";
import { getActiveMcqAdapter, type McqParams } from "./commands/mcq-adapter";
import { initializeTelegramCommandHandler, updatePinnedStatus } from "./commands/telegram-handler";
import { injectChannelContext } from "./formatting";
import { startHeartbeatRunner, TRIPWIRE_PATH } from "./heartbeat";
import { createEnvelope, type OutboundEnvelope } from "./outbound/envelope";
import { registerChannel, routeResponse } from "./outbound/router";
import * as telegramStream from "./telegram-stream";

// Initialize Langfuse tracing for inference routing (reads from env vars):
// LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_HOST or LANGFUSE_BASE_URL.
// Optional: JOELCLAW_LLM_OBS_ENABLED, JOELCLAW_ENV, JOELCLAW_RELEASE, GIT_SHA.
initTracing({});

/**
 * Register the gateway's agent identity with agent-mail (non-fatal).
 * Ensures project exists and registers MaroonReef as the gateway agent.
 */
async function registerGatewayAgent(): Promise<void> {
  const AGENT_MAIL_URL = process.env.AGENT_MAIL_URL?.trim() || "http://127.0.0.1:8765";
  const PROJECT_KEY = "/Users/joel/Code/joelhooks/joelclaw";
  const AGENT_NAME = "MaroonReef";

  async function mcpCall(toolName: string, args: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${AGENT_MAIL_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `gw-${Date.now()}`,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    if (!resp.ok) throw new Error(`agent-mail ${toolName}: HTTP ${resp.status}`);
  }

  try {
    await mcpCall("ensure_project", { human_key: PROJECT_KEY });
    await mcpCall("register_agent", {
      project_key: PROJECT_KEY,
      name: AGENT_NAME,
      program: "pi-gateway",
      model: "claude-sonnet-4",
    });
    console.log("[gateway] registered agent identity with agent-mail", { agent: AGENT_NAME });
  } catch (err) {
    console.warn("[gateway] agent-mail registration failed (non-fatal):", err);
  }
}

const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi/agent");
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;
const WS_PORT_FILE = `${PID_DIR}/gateway.ws.port`;
const JOELCLAW_DIR = join(HOME, ".joelclaw");
const SESSION_ID_FILE = join(JOELCLAW_DIR, "gateway.session");
const GATEWAY_SESSION_DIR = join(JOELCLAW_DIR, "sessions", "gateway");
// Gateway-specific working dir — has its own .pi/settings.json with aggressive compaction.
// Project-level settings (cwd/.pi/settings.json) override global (~/.pi/agent/settings.json).
// This keeps gateway compaction isolated from interactive pi sessions.
const GATEWAY_CWD = join(JOELCLAW_DIR, "gateway");
const DEFAULT_WS_PORT = 3018;
const WS_PORT = Number.parseInt(process.env.PI_GATEWAY_WS_PORT ?? String(DEFAULT_WS_PORT), 10) || DEFAULT_WS_PORT;
const startedAt = Date.now();

const startupGatewayConfig = await (async () => {
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
    });

    try {
      await redis.connect();
      return await loadGatewayConfig(redis);
    } finally {
      redis.disconnect();
    }
  } catch {
    return defaultGatewayConfig();
  }
})();

function resolveModel(modelIdOverride: string | undefined) {
  const modelId = modelIdOverride ?? process.env.PI_MODEL ?? process.env.PI_MODEL_ID;
  if (!modelId) return undefined;

  const catalogModel = resolveModelFromCatalog(modelId);
  if (catalogModel) {
    const catalogModelId = catalogModel.id.includes("/") ? catalogModel.id.split("/")[1] : catalogModel.id;
    void emitGatewayOtel({
      level: "info",
      component: "daemon.inference",
      action: "catalog.resolved",
      success: true,
      metadata: {
        modelId,
        catalogModel: catalogModel.id,
        provider: catalogModel.provider,
      },
    });
    const model = getModel(catalogModel.provider as any, catalogModelId as any);
    if (model) return model;
  }

  // Use the model's actual provider (supports cross-provider fallback)
  const resolvedProvider = process.env.PI_MODEL_PROVIDER || providerForModel(modelId);
  if (!resolvedProvider) return undefined;

  const model = getModel(resolvedProvider as any, modelId as any);
  if (!model) {
    console.warn("[gateway] requested model not found; using SDK default", { provider: resolvedProvider, modelId });
    return undefined;
  }

  return model;
}

function describeModel(model: unknown): string {
  if (!model || typeof model !== "object") return "default";
  const value = model as { provider?: string; id?: string; name?: string };
  const provider = value.provider ?? "unknown";
  const id = value.id ?? value.name ?? "unknown";
  return `${provider}/${id}`;
}

function normalizeOutboundMessage(message: OutboundEnvelope | string): OutboundEnvelope {
  return typeof message === "string" ? createEnvelope(message) : message;
}

function shouldForwardToTelegram(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const isHeartbeatOk = trimmed === "HEARTBEAT_OK"
    || (trimmed.includes("HEARTBEAT_OK") && trimmed.length < 300);
  const isTrivial = trimmed.length < 80;
  const isEcho = lower === "echo." || lower === "echo"
    || lower.startsWith("echo.") || lower.startsWith("completion echo");

  return !isHeartbeatOk && !isTrivial && !isEcho;
}

function isMcqQuestion(value: unknown): value is McqParams["questions"][number] {
  if (!value || typeof value !== "object") return false;
  const question = value as Record<string, unknown>;
  return typeof question.id === "string"
    && typeof question.question === "string"
    && Array.isArray(question.options)
    && question.options.every((option) => typeof option === "string");
}

function isMcqParams(value: unknown): value is McqParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return Array.isArray(params.questions) && params.questions.every(isMcqQuestion);
}

function buildMcqToolResult(params: McqParams, answers: Record<string, string>): {
  content: Array<{ type: "text"; text: string }>;
  details: {
    title: string;
    answers: Array<{
      id: string;
      question: string;
      selected: number;
      answer: string;
      isCustom: boolean;
    }>;
    cancelled: false;
  };
} {
  const detailsAnswers = params.questions.map((question) => {
    const answer = answers[question.id] ?? "(no answer)";
    const selectedIndex = question.options.findIndex((option) => option === answer);
    const isCustom = selectedIndex === -1;

    return {
      id: question.id,
      question: question.question,
      selected: isCustom ? question.options.length + 1 : selectedIndex + 1,
      answer,
      isCustom,
    };
  });

  const contentLines = detailsAnswers.map((answer) => {
    if (answer.isCustom) return `${answer.id}: (user wrote) ${answer.answer}`;
    return `${answer.id}: ${answer.selected}. ${answer.answer}`;
  });

  return {
    content: [{ type: "text", text: contentLines.join("\n") }],
    details: {
      title: params.title ?? "Questions",
      answers: detailsAnswers,
      cancelled: false,
    },
  };
}

function withChannelMcqOverride(base: LoadExtensionsResult): LoadExtensionsResult {
  let overridesApplied = 0;

  for (const extension of base.extensions) {
    const registered = extension.tools.get("mcq");
    if (!registered) continue;

    const originalExecute = registered.definition.execute as (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;

    registered.definition.execute = (async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => {
      const source = getActiveSource();
      if (!isMcqParams(params)) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      // ── Discord MCQ (ADR-0122) ────────────────────────────────
      const isDiscordSource = typeof source === "string" && source.startsWith("discord:");
      if (isDiscordSource) {
        const discordAdapter = getActiveDiscordMcqAdapter();
        if (!discordAdapter) {
          console.warn("[gateway:mcq] discord mcq call but adapter not ready; falling back to default", { source });
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }

        const channelId = parseDiscordChannelId(source);
        if (!channelId) {
          console.warn("[gateway:mcq] discord source has no channel ID", { source });
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }

        try {
          const answers = await discordAdapter.handleMcqToolCall(
            { ...params, mode: params.mode ?? "decision" },
            channelId,
          );
          void emitGatewayOtel({
            level: "info",
            component: "daemon.mcq",
            action: "mcq.discord.completed",
            success: true,
            metadata: { source, channelId, questionCount: params.questions.length },
          });
          return buildMcqToolResult(params, answers);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[gateway:mcq] discord adapter failed", { source, error: message });
          void emitGatewayOtel({
            level: "error",
            component: "daemon.mcq",
            action: "mcq.discord.failed",
            success: false,
            error: message,
            metadata: { source, channelId },
          });
          return {
            content: [{ type: "text", text: `MCQ adapter failed: ${message}` }],
            details: { title: params.title ?? "Questions", answers: [], cancelled: true },
          };
        }
      }

      // ── Telegram MCQ ──────────────────────────────────────────
      const isTelegramSource = typeof source === "string" && source.startsWith("telegram:");
      if (!isTelegramSource) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      const adapter = getActiveMcqAdapter();
      if (!adapter) {
        console.warn("[gateway:mcq] telegram mcq call received before adapter initialization; using default tool behavior", {
          source,
        });
        void emitGatewayOtel({
          level: "warn",
          component: "daemon.mcq",
          action: "mcq.adapter_unavailable",
          success: false,
          metadata: {
            source,
            immediateTelegram: true,
          },
        });
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      const sourceChatId = source ? parseChatId(source) : undefined;

      try {
        const answers = await adapter.handleMcqToolCall(
          params,
          sourceChatId ? { chatId: sourceChatId } : undefined,
        );
        void emitGatewayOtel({
          level: "info",
          component: "daemon.mcq",
          action: "mcq.telegram.completed",
          success: true,
          metadata: {
            source,
            chatId: sourceChatId,
            questionCount: params.questions.length,
          },
        });
        return buildMcqToolResult(params, answers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[gateway:mcq] telegram adapter execution failed", { source, error: message });
        void emitGatewayOtel({
          level: "error",
          component: "daemon.mcq",
          action: "mcq.telegram.failed",
          success: false,
          error: message,
          metadata: {
            source,
            chatId: sourceChatId,
          },
        });
        return {
          content: [{ type: "text", text: `MCQ adapter failed: ${message}` }],
          details: {
            title: params.title ?? "Questions",
            answers: [],
            cancelled: true,
          },
        };
      }
    }) as typeof registered.definition.execute;

    overridesApplied += 1;
  }

  if (overridesApplied === 0) {
    console.warn("[gateway:mcq] no mcq tool found in loaded extensions; channel adapter overrides inactive");
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.mcq",
      action: "mcq.override.missing",
      success: false,
    });
  } else {
    console.log("[gateway:mcq] installed channel mcq tool overrides (telegram + discord)", { overridesApplied });
    void emitGatewayOtel({
      level: "info",
      component: "daemon.mcq",
      action: "mcq.override.installed",
      success: true,
      metadata: { overridesApplied },
    });
  }

  return base;
}

mkdirSync(GATEWAY_SESSION_DIR, { recursive: true });

// Always resume the existing session — context continuity is critical.
// Pi's compaction handles what gets sent to the API (reserveTokens/keepRecentTokens).
// The JSONL file grows but that's fine — pi summarizes old turns automatically.
const hasExistingSession = readdirSync(GATEWAY_SESSION_DIR).some(f => f.endsWith(".jsonl"));
const sessionManager = hasExistingSession
  ? SessionManager.continueRecent(HOME, GATEWAY_SESSION_DIR)
  : SessionManager.create(HOME, GATEWAY_SESSION_DIR);
console.log("[gateway] session", {
  mode: hasExistingSession ? "resumed" : "new",
  sessionId: sessionManager.getSessionId(),
  file: sessionManager.getSessionFile(),
  entries: sessionManager.getEntries().length,
});

const resourceLoader = new DefaultResourceLoader({
  cwd: GATEWAY_CWD,
  agentDir: AGENT_DIR,
  extensionsOverride: withChannelMcqOverride,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: GATEWAY_CWD,
  agentDir: AGENT_DIR,
  model: resolveModel(startupGatewayConfig.model),
  thinkingLevel: startupGatewayConfig.thinkingLevel === "none" ? undefined : startupGatewayConfig.thinkingLevel,
  sessionManager,
  resourceLoader,
});
void emitGatewayOtel({
  level: "info",
  component: "daemon",
  action: "daemon.session.started",
  success: true,
  metadata: {
    sessionId: session.sessionId,
    model: describeModel(session.model),
  },
});

setSession({
  prompt: (text: string) => session.prompt(text),
  reload: () => session.reload(),
  compact: (instructions?: string) => session.compact(instructions),
  newSession: async (compressionSummary?: string) => {
    await session.newSession();
    if (compressionSummary) {
      // Inject the summary as the first user message so the agent has context
      console.log("[gateway] injecting compression summary into fresh session", {
        summaryLength: compressionSummary.length,
      });
      await session.prompt(compressionSummary);
    }
  },
});

// ── Context overflow recovery: build compression summary from dying session ──
function buildCompressionSummary(): string {
  const entries = sessionManager.getEntries();
  const recentUserMessages: string[] = [];
  const recentAssistantSnippets: string[] = [];
  let lastSource = "";

  // Walk backwards through entries to grab recent context
  for (let i = entries.length - 1; i >= 0 && recentUserMessages.length < 10; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg?.role || !msg.content) continue;

    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        : String(msg.content);
      if (text.length > 0 && text.length < 2000) {
        recentUserMessages.unshift(text.slice(0, 500));
      }
      // Capture source channel from channel header
      const sourceMatch = text.match(/Channel:\s*(\w+)/);
      if (sourceMatch && !lastSource) lastSource = sourceMatch[1];
    }

    if (msg.role === "assistant" && recentAssistantSnippets.length < 3) {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        : String(msg.content);
      if (text.length > 0) {
        recentAssistantSnippets.unshift(text.slice(0, 800));
      }
    }
  }

  const parts = [
    "# Context Recovery — Previous Session Overflow",
    "",
    "The previous gateway session exceeded the model's context window and was automatically replaced.",
    "Below is a compression summary of recent activity to maintain continuity.",
    "",
  ];

  if (lastSource) {
    parts.push(`**Last active channel**: ${lastSource}`, "");
  }

  if (recentUserMessages.length > 0) {
    parts.push("## Recent inbound messages (newest last)", "");
    for (const msg of recentUserMessages.slice(-5)) {
      parts.push(`- ${msg.replace(/\n/g, " ").slice(0, 300)}`, "");
    }
  }

  if (recentAssistantSnippets.length > 0) {
    parts.push("## Last assistant responses (summaries)", "");
    for (const snippet of recentAssistantSnippets) {
      parts.push(`> ${snippet.replace(/\n/g, "\n> ").slice(0, 500)}`, "");
    }
  }

  parts.push(
    "",
    "Resume normal operation. You are the joelclaw gateway agent. Respond to new inbound messages as they arrive.",
    "If the user's last message was unanswered due to the overflow, it will be replayed next.",
  );

  return parts.join("\n");
}

onContextOverflowRecovery(async () => {
  const summary = buildCompressionSummary();
  const telegramUserId = process.env.TELEGRAM_USER_ID ?? "";

  console.log("[gateway] context overflow recovery triggered", {
    summaryLength: summary.length,
    recentEntries: sessionManager.getEntries().length,
  });

  // Alert Joel via Telegram
  if (telegramUserId) {
    const parsedTelegramUserId = parseChatId(`telegram:${telegramUserId}`);
    if (!parsedTelegramUserId) {
      console.error("[gateway] invalid TELEGRAM_USER_ID in overflow recovery handler", { telegramUserId });
      return summary;
    }
    const alertText = [
      "⚠️ <b>Gateway context overflow — auto-recovery</b>",
      "",
      "Session exceeded model context window. Compaction failed to reduce.",
      "Created fresh session with compression summary of recent activity.",
      "",
      `Previous session: ${sessionManager.getEntries().length} entries.`,
      "The failed message will be replayed into the new session.",
    ].join("\n");
    sendTelegram(parsedTelegramUserId, alertText, { silent: false }).catch((err) => {
      console.error("[gateway] failed to send overflow alert via Telegram", { err });
    });
  }

  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.context_overflow.recovery",
    success: true,
    metadata: {
      summaryLength: summary.length,
      previousEntries: sessionManager.getEntries().length,
    },
  });

  return summary;
});

// ── Model fallback controller (ADR-0091) ───────────────
const primaryProvider = providerForModel(startupGatewayConfig.model);
const fallbackTelemetryAdapter: TelemetryEmitter = {
  emit(action: string, detail: string, extra?: Record<string, unknown>) {
    const metadata = extra ?? {};
    void emitGatewayOtel({
      level: typeof metadata.level === "string" ? (metadata.level as Parameters<typeof emitGatewayOtel>[0]["level"]) : "info",
      component: typeof metadata.component === "string" ? metadata.component : "daemon.fallback",
      action,
      success: typeof metadata.success === "boolean" ? metadata.success : true,
      duration_ms: typeof metadata.duration_ms === "number" ? metadata.duration_ms : undefined,
      error: typeof metadata.error === "string" ? metadata.error : detail,
      metadata: {
        ...metadata,
        detail,
      },
    });
  },
};

const fallbackController = new ModelFallbackController(
  startupGatewayConfig,
  primaryProvider,
  startupGatewayConfig.model,
  fallbackTelemetryAdapter,
);

// Track prompt dispatch timing for stuck-session detection
let _lastTurnEndAt = Date.now();
let _lastPromptAt = 0;
onPrompt(() => {
  _lastPromptAt = Date.now();
  fallbackController.onPromptDispatched();

  // Start Telegram typing indicator + streaming if this prompt came from Telegram
  const source = getActiveSource();
  if (source?.startsWith("telegram:") && TELEGRAM_USER_ID) {
    const chatId = parseChatId(source) ?? TELEGRAM_USER_ID;
    const bot = getBot();
    if (bot && chatId) {
      telegramStream.begin({ chatId, bot });
    }
  }
});
onQueueError((failures) => fallbackController.onPromptError(failures));

// ── Idle waiter: gate drain loop on turn_end ───────────
// session.prompt() resolves when the message is queued, not when the
// full turn finishes. The drain loop needs to wait for turn_end before
// dispatching the next message, otherwise back-to-back prompts race.
let _idleResolve: (() => void) | undefined;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety valve

setIdleWaiter(() => {
  return new Promise<void>((resolve) => {
    _idleResolve = resolve;
    // Safety timeout — if turn_end never fires (e.g. API hang),
    // don't block the drain loop forever. The watchdog handles
    // true stuck sessions separately.
    const timer = setTimeout(() => {
      if (_idleResolve === resolve) {
        console.warn("[gateway] idle waiter timed out — releasing drain lock", {
          timeoutMs: IDLE_TIMEOUT_MS,
        });
        _idleResolve = undefined;
        resolve();
      }
    }, IDLE_TIMEOUT_MS);
    // Don't keep the process alive for the timer
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  });
});

// ── Config ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_ALLOWED_USER_ID = process.env.DISCORD_ALLOWED_USER_ID;
const IMESSAGE_ALLOWED_SENDER = process.env.IMESSAGE_ALLOWED_SENDER;
const SLACK_ALLOWED_USER_ID = process.env.SLACK_ALLOWED_USER_ID;
const SLACK_DEFAULT_CHANNEL_ID = process.env.SLACK_DEFAULT_CHANNEL_ID;
const channelInfo = {
  redis: true,
  console: true,
  telegram: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
  discord: Boolean(DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID),
  imessage: Boolean(IMESSAGE_ALLOWED_SENDER),
  slack: false,
};

registerChannel("console", {
  send: async (message, context) => {
    const envelope = normalizeOutboundMessage(message);
    if (!TELEGRAM_TOKEN || !TELEGRAM_USER_ID) return;
    if (context?.source?.startsWith("telegram:")) return;
    if (!shouldForwardToTelegram(envelope.text)) return;

    try {
      await sendTelegram(TELEGRAM_USER_ID, envelope.text, {
        buttons: envelope.buttons,
        silent: envelope.silent,
        replyTo: envelope.replyTo,
      });
    } catch (error) {
      console.error("[gateway] telegram notification failed", { error: String(error) });
    }
  },
});

if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  registerChannel("telegram", {
    send: async (message, context) => {
      const envelope = normalizeOutboundMessage(message);
      const chatId = context?.source ? parseChatId(context.source) ?? TELEGRAM_USER_ID : TELEGRAM_USER_ID;
      console.log("[gateway:telegram] outbound send", {
        chatId,
        textLength: envelope.text.length,
        source: context?.source,
        hasButtons: !!envelope.buttons,
      });
      if (!chatId) return;

      try {
        await sendTelegram(chatId, envelope.text, {
          buttons: envelope.buttons,
          silent: envelope.silent,
          replyTo: envelope.replyTo,
        });
        console.log("[gateway:telegram] message sent successfully", { chatId });
      } catch (error) {
        console.error("[gateway] telegram send failed", { error: String(error) });
      }
    },
  });
} else {
  console.warn("[gateway] telegram channel NOT registered", {
    hasToken: !!TELEGRAM_TOKEN,
    hasUserId: !!TELEGRAM_USER_ID,
  });
}

type WsServerMessage =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; toolName: string; input: unknown }
  | { type: "tool_result"; id: string; toolName: string; content: unknown; isError?: boolean }
  | { type: "turn_end" }
  | { type: "status"; data: Record<string, unknown> }
  | { type: "error"; message: string };

type WsClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "status" };
// ── Outbound: collect assistant responses and route to source channel ──
let responseChunks: string[] = [];
const wsClients = new Set<Bun.ServerWebSocket<unknown>>();

function getStatusPayload(): Record<string, unknown> {
  const fb = fallbackController.state;
  // Session context health
  const entries = sessionManager.getEntries();
  const lastUsage = getLastAssistantUsage(entries);
  const contextTokens = lastUsage ? calculateContextTokens(lastUsage) : 0;
  const MODEL_CONTEXT_WINDOW = 200_000;
  const contextUsagePercent = contextTokens > 0 ? Math.round((contextTokens / MODEL_CONTEXT_WINDOW) * 100) : 0;

  return {
    sessionId: session.sessionId,
    isStreaming: responseChunks.length > 0,
    model: describeModel(session.model),
    uptimeMs: Date.now() - startedAt,
    pid: process.pid,
    context: {
      entries: entries.length,
      estimatedTokens: contextTokens,
      usagePercent: contextUsagePercent,
      maxTokens: MODEL_CONTEXT_WINDOW,
      health: contextUsagePercent > 85 ? "critical" : contextUsagePercent > 70 ? "elevated" : "ok",
    },
    channelInfo: {
      ...channelInfo,
      redis: isRedisHealthy() ? "ok" : "degraded",
      ws: {
        port: wsServer.port,
        clients: wsClients.size,
      },
    },
    queueDepth: getQueueDepth(),
    fallback: fb.active ? {
      active: true,
      model: `${fb.fallbackProvider}/${fb.fallbackModel}`,
      since: new Date(fb.activeSince).toISOString(),
      activationCount: fb.activationCount,
    } : { active: false },
  };
}

async function getLastHeartbeatAt(): Promise<number | undefined> {
  try {
    const content = await readFile(TRIPWIRE_PATH, "utf8");
    const match = content.match(/lastHeartbeatTs\s*=\s*(\d+)/);
    if (!match?.[1]) return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

async function getGatewayStatusSnapshot(): Promise<{
  modelName: string;
  thinkingLevel: string;
  verbose: boolean;
  uptimeMs: number;
  queueDepth: number;
  lastHeartbeatAt?: number;
}> {
  const runtimeConfig = await loadGatewayConfig(getRedisClient());

  return {
    modelName: runtimeConfig.model,
    thinkingLevel: runtimeConfig.thinkingLevel,
    verbose: runtimeConfig.verbose,
    uptimeMs: Date.now() - startedAt,
    queueDepth: getQueueDepth(),
    lastHeartbeatAt: await getLastHeartbeatAt(),
  };
}

function sendWsMessage(ws: Bun.ServerWebSocket<unknown>, payload: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[gateway] ws send failed", { error });
  }
}

function broadcastWs(payload: WsServerMessage): void {
  for (const client of wsClients) {
    sendWsMessage(client, payload);
  }
}

function parseClientMessage(raw: string | Buffer | Uint8Array): WsClientMessage | undefined {
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const parsed = JSON.parse(text) as WsClientMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

await mkdir(PID_DIR, { recursive: true });

const wsServer = Bun.serve({
  port: WS_PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      sendWsMessage(ws, { type: "status", data: getStatusPayload() });
    },
    async message(ws, message) {
      const data = parseClientMessage(message);
      if (!data) {
        sendWsMessage(ws, { type: "error", message: "Invalid message payload" });
        return;
      }

      if (data.type === "prompt") {
        const text = data.text?.trim();
        if (!text) {
          sendWsMessage(ws, { type: "error", message: "Prompt text is required" });
          return;
        }
        const withChannelContext = injectChannelContext(text, { source: "tui" });
        await enqueue("tui", withChannelContext, { via: "ws" });
        void drain();
        return;
      }

      if (data.type === "abort") {
        try {
          await session.abort();
        } catch (error: any) {
          sendWsMessage(ws, { type: "error", message: `Abort failed: ${error?.message ?? String(error)}` });
        }
        return;
      }

      if (data.type === "status") {
        sendWsMessage(ws, { type: "status", data: getStatusPayload() });
      }
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },
});

await writeFile(WS_PORT_FILE, `${wsServer.port}\n`);

session.subscribe((event: any) => {
  // Any model activity resets the fallback timeout (tool calls take time)
  if (event.type === "message_start" || event.type === "message_update") {
    fallbackController.onActivity();
  }

  // Collect text deltas
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    const delta = typeof event.assistantMessageEvent.delta === "string"
      ? event.assistantMessageEvent.delta
      : "";
    if (!delta) return;
    responseChunks.push(delta);
    fallbackController.onFirstToken();
    broadcastWs({ type: "text_delta", delta });

    // Forward to Telegram streaming
    telegramStream.pushDelta(delta);
  }

  // On message end, route the full response to the source channel
  if (event.type === "message_end") {
    const fullText = responseChunks.join("");
    responseChunks = [];

    // Detect API errors (429, 529, overload) surfaced via errorMessage —
    // pi resolves (doesn't throw), so these bypass the throw-based fallback path.
    const errorMsg: string = event.message?.errorMessage ?? "";
    if (errorMsg) {
      const is429 = errorMsg.includes("rate_limit") || errorMsg.includes("429");
      const isOverload = errorMsg.includes("overloaded") || errorMsg.includes("529");
      if (is429 || isOverload) {
        const reason = is429 ? "Anthropic rate limit (429)" : "Anthropic overloaded (529)";
        console.warn("[gateway:fallback] API error detected via message_end", {
          reason,
          errorMsg: errorMsg.slice(0, 120),
        });
        void emitGatewayOtel({
          level: "error",
          component: "daemon",
          action: "daemon.api_error.detected",
          success: false,
          error: reason,
        });
        // Treat as a prompt failure — let fallback controller decide whether to swap
        void fallbackController.onPromptError(getConsecutiveFailures() + 1);
        // Abort any active Telegram stream on API error
        telegramStream.abort();
        return;
      }
      // Other errors — log but don't route
      console.error("[gateway] message_end with error", { errorMsg: errorMsg.slice(0, 200) });
      telegramStream.abort();
      return;
    }

    if (!fullText.trim()) return;

    const source = getActiveSource() ?? "console";
    console.log("[gateway] response ready", { source, length: fullText.length });

    // If Telegram streaming is active, finalize the current message segment.
    // finish() returns true if it handled delivery. After finishing, the stream
    // resets for the next message segment (tool calls may produce more text).
    if (telegramStream.isActive() && source.startsWith("telegram:")) {
      telegramStream.finish(fullText).then((handled) => {
        if (!handled) {
          // Streaming didn't actually send anything — fall back to normal path
          routeResponse(source, fullText);
        }
      }).catch((err) => {
        console.error("[telegram-stream] finish failed, falling back", { error: String(err) });
        routeResponse(source, fullText);
      });
      return;
    }

    routeResponse(source, fullText);
  }

  if (event.type === "tool_call") {
    fallbackController.onActivity(); // model is alive, restart timeout
    broadcastWs({
      type: "tool_call",
      id: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });

    // Show tool status in Telegram stream
    if (telegramStream.isActive()) {
      telegramStream.onToolCall(event.toolName ?? "tool");
    }
  }

  if (event.type === "tool_result") {
    fallbackController.onActivity(); // model is alive, restart timeout
    broadcastWs({
      type: "tool_result",
      id: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      isError: event.isError,
    });

    if (event.isError) {
      broadcastWs({
        type: "error",
        message: `Tool ${event.toolName} failed (${event.toolCallId})`,
      });
    }
  }

  if (event.type === "turn_end") {
    _lastTurnEndAt = Date.now();
    fallbackController.onTurnEnd();
    broadcastWs({ type: "turn_end" });
    // Clean up Telegram streaming state for this turn
    telegramStream.turnEnd();
    // Release the idle waiter so the drain loop can process the next entry
    if (_idleResolve) {
      const resolve = _idleResolve;
      _idleResolve = undefined;
      resolve();
    }

    // ── Proactive context health check (ADR-0141) ───────────
    // After each turn, estimate context usage. If critical, compact BEFORE
    // releasing the drain loop — compaction must complete before the next prompt.
    const doHealthCheck = async () => {
      try {
        const lastUsage = getLastAssistantUsage(sessionManager.getEntries());
        if (!lastUsage) return;

        const contextTokens = calculateContextTokens(lastUsage);
        // Claude Opus context window is 200k (API rejects at ~180-190k)
        const MODEL_CONTEXT_WINDOW = 200_000;
        const usageRatio = contextTokens / MODEL_CONTEXT_WINDOW;

        if (usageRatio > 0.85 && !session.isCompacting) {
          console.warn("[gateway:health] context usage CRITICAL — compacting before next prompt", {
            contextTokens,
            maxTokens: MODEL_CONTEXT_WINDOW,
            usagePercent: Math.round(usageRatio * 100),
            entries: sessionManager.getEntries().length,
          });
          void emitGatewayOtel({
            level: "warn",
            component: "daemon",
            action: "daemon.context.critical",
            success: true,
            metadata: { contextTokens, usageRatio: Math.round(usageRatio * 100), entries: sessionManager.getEntries().length },
          });
          // Compact synchronously — hold the drain loop until done
          // This prevents the next prompt from racing with compaction
          try {
            console.log("[gateway:health] triggering proactive compaction (blocking drain)");
            fallbackController.pauseTimeoutWatch();
            await session.compact("Context is at " + Math.round(usageRatio * 100) + "% capacity. Aggressively summarize to prevent overflow. Keep only essential recent context.");
            fallbackController.resumeTimeoutWatch();
            console.log("[gateway:health] proactive compaction complete");
          } catch (err) {
            fallbackController.resumeTimeoutWatch();
            console.error("[gateway:health] proactive compaction failed", { err });
          }
        } else if (usageRatio > 0.7) {
          console.log("[gateway:health] context usage elevated", {
            contextTokens,
            usagePercent: Math.round(usageRatio * 100),
          });
          void emitGatewayOtel({
            level: "info",
            component: "daemon",
            action: "daemon.context.elevated",
            success: true,
            metadata: { contextTokens, usageRatio: Math.round(usageRatio * 100) },
          });
        }
      } catch (healthErr) {
        // Non-fatal — don't let monitoring break the drain loop
        console.error("[gateway:health] context check failed", { healthErr });
      }
    };

    void doHealthCheck().then(() => drain());
  }
});

const enqueueToGateway = async (source: string, prompt: string, metadata?: Record<string, unknown>) => {
  const withChannelContext = injectChannelContext(prompt, {
    source,
    threadName: typeof metadata?.discordThreadName === "string" ? metadata.discordThreadName : undefined,
  });
  await enqueue(source, withChannelContext, metadata);
  void drain();
};

// ── Redis channel (self-healing — retries on failure, won't crash daemon) ──
await startRedisChannel(enqueueToGateway);

const redisClient = getRedisClient();
if (redisClient) {
  await initMessageStore(
    redisClient,
    {
      emit: (action: string, detail: string, extra?: Record<string, unknown>) => {
        void emitGatewayOtel({
          level: detail === "error" ? "error" : detail === "warn" ? "warn" : detail === "info" ? "info" : "debug",
          component: "message-store",
          action,
          success: true,
          metadata: {
            ...extra,
            source: "gateway",
            message_store_detail: detail,
          },
        });
      },
    },
  );
  await trimOld();
} else {
  console.warn("[gateway:store] redis command client unavailable; durable replay skipped");
}

// ── Discord channel ────────────────────────────────────
if (DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID) {
  registerChannel("discord", {
    send: async (message, context) => {
      const envelope = normalizeOutboundMessage(message);
      const channelId = context?.source
        ? parseDiscordChannelId(context.source) ?? undefined
        : undefined;
      if (!channelId) {
        console.error("[gateway:discord] send: no channel ID in context", { source: context?.source });
        return;
      }
      try {
        await sendDiscord(channelId, envelope.text);
      } catch (error) {
        console.error("[gateway:discord] send failed", { channelId, error: String(error) });
      }
    },
  });

  try {
    await startDiscord(DISCORD_TOKEN, DISCORD_ALLOWED_USER_ID, enqueueToGateway, {
      redis: redisClient,
      abortCurrentTurn: async () => {
        await session.abort();
      },
    });

    // ── Discord MCQ adapter (ADR-0122) ────────────────────────
    const discordClient = getDiscordClient();
    if (discordClient) {
      try {
        registerDiscordMcqAdapter(fetchDiscordChannel, getDiscordClient as () => any);
        console.log("[gateway] discord MCQ adapter registered");
        void emitGatewayOtel({
          level: "info",
          component: "daemon",
          action: "daemon.discord.mcq_adapter_registered",
          success: true,
        });
      } catch (error) {
        console.error("[gateway] discord MCQ adapter registration failed", { error: String(error) });
        void emitGatewayOtel({
          level: "error",
          component: "daemon",
          action: "daemon.discord.mcq_adapter_failed",
          success: false,
          error: String(error),
        });
      }
    }
  } catch (error) {
    console.error("[gateway] discord failed to start; discord channel disabled", { error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "daemon",
      action: "daemon.discord.start_failed",
      success: false,
      error: String(error),
    });
  }
} else {
  console.warn("[gateway] discord disabled — set DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_ID env vars");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.discord.disabled",
    success: false,
  });
}

// ── iMessage channel ───────────────────────────────────
if (IMESSAGE_ALLOWED_SENDER) {
  registerChannel("imessage", {
    send: async (message) => {
      const envelope = normalizeOutboundMessage(message);
      try {
        await sendIMessage(IMESSAGE_ALLOWED_SENDER, envelope.text);
      } catch (error) {
        console.error("[gateway] imessage send failed", { error: String(error) });
      }
    },
  });

  await startIMessage(IMESSAGE_ALLOWED_SENDER, enqueueToGateway);
} else {
  console.warn("[gateway] imessage disabled — set IMESSAGE_ALLOWED_SENDER env var");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.imessage.disabled",
    success: false,
  });
}

// ── Telegram channel ───────────────────────────────────
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  await startTelegram(TELEGRAM_TOKEN, TELEGRAM_USER_ID, enqueueToGateway, {
    configureBot: async (bot) => {
      await initializeTelegramCommandHandler({
        bot,
        enqueue: enqueueToGateway,
        redis: redisClient,
        chatId: TELEGRAM_USER_ID,
        getStatusSnapshot: getGatewayStatusSnapshot,
      });
    },
  });

  try {
    await updatePinnedStatus();
  } catch (error) {
    console.warn("[gateway] pinned status update failed after telegram startup; continuing", error);
  }
} else {
  console.warn("[gateway] telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID env vars");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.telegram.disabled",
    success: false,
  });
}

// ── Slack channel ──────────────────────────────────────
registerChannel("slack", {
  send: async (message, context) => {
    // ADR-0131: suppress replies to passive intel messages
    if (context?.source?.startsWith("slack-intel:")) return;

    const envelope = normalizeOutboundMessage(message);
    const sourceTarget = context?.source?.startsWith("slack:")
      ? context.source
      : undefined;
    const target = sourceTarget ?? SLACK_DEFAULT_CHANNEL_ID;
    if (!target) {
      console.error("[gateway:slack] send: no slack target in context/source/default", {
        source: context?.source,
      });
      return;
    }

    try {
      await sendSlack(target, envelope.text);
    } catch (error) {
      console.error("[gateway:slack] send failed", { target, error: String(error) });
    }
  },
});

try {
  await startSlack(enqueueToGateway, {
    allowedUserId: SLACK_ALLOWED_USER_ID,
  });
  channelInfo.slack = isSlackStarted();
} catch (error) {
  channelInfo.slack = false;
  console.error("[gateway] slack failed to start; slack channel disabled", { error: String(error) });
  void emitGatewayOtel({
    level: "error",
    component: "daemon",
    action: "daemon.slack.start_failed",
    success: false,
    error: String(error),
  });
}

// ── Init fallback controller (ADR-0091) ──────────────────
// Must happen after Telegram starts so notify can send alerts.
fallbackController.init(
  {
    setModel: async (m) => {
      // Resolve the full pi model object (with api, baseUrl, cost, etc.)
      // The fallback controller passes { provider, id } from the joelclaw catalog,
      // but pi's stream() needs model.api to resolve the API provider.
      const ref = m as { provider: string; id: string };
      const fullModel = getModel(ref.provider as any, ref.id as any);
      if (!fullModel) {
        throw new Error(`[gateway:fallback] pi model not found: ${ref.provider}/${ref.id}`);
      }
      return session.setModel(fullModel as any);
    },
    get model() { return session.model; },
  },
  (text: string) => {
    console.log("[gateway:fallback]", text);
    if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
      sendTelegram(TELEGRAM_USER_ID, text, { silent: false }).catch(() => {});
    }
  },
);

if (redisClient) {
  // Replay after channels initialize so telegram-originated turns can use command/callback adapters.
  await replayUnacked();
}

// ── Media outbound: satellite sessions push files, we deliver ──────
// Self-healing: retries connection independently, errors don't propagate
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  const startMediaOutbound = async () => {
    const Redis = (await import("ioredis")).default;
    const mediaSub = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    const mediaCmd = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    mediaSub.on("error", () => {});
    mediaCmd.on("error", () => {});
    await mediaSub.connect();
    await mediaCmd.connect();
    await mediaSub.subscribe("joelclaw:notify:media-outbound");

    const drainMediaOutbound = async () => {
      try {
        const raw = await mediaCmd.lrange("joelclaw:media:outbound", 0, -1);
        if (raw.length === 0) return;
        await mediaCmd.del("joelclaw:media:outbound");

        for (const item of raw) {
          try {
            const evt = JSON.parse(item) as {
              payload: { filePath: string; caption?: string; chatId?: number };
            };
            const chatId = evt.payload.chatId ?? TELEGRAM_USER_ID;
            if (!chatId) continue;
            console.log("[gateway] media outbound →", { chatId, filePath: evt.payload.filePath });
            await sendTelegramMedia(chatId, evt.payload.filePath, {
              caption: evt.payload.caption,
            });
          } catch (err) {
            console.error("[gateway] media outbound failed", { error: err });
          }
        }
      } catch (err) {
        console.error("[gateway] media outbound drain failed", { error: err });
      }
    };

    mediaSub.on("message", () => { void drainMediaOutbound(); });
    await drainMediaOutbound();
    console.log("[gateway] media outbound listener started");
  };

  // Don't let media outbound failure crash daemon startup
  startMediaOutbound().catch((error) => {
    console.error("[gateway] media outbound initial connect failed — ioredis will retry", { error: String(error) });
  });
}

const heartbeatRunner = startHeartbeatRunner();
const queueDrainTimer = setInterval(() => {
  void drain();
}, 1000);

// ── Self-healing watchdog ──────────────────────────────
// Monitors subsystem health every 30s. Logs degraded state.
// Detects stuck sessions (no turn_end for 10min after a prompt).
// _lastTurnEndAt and _lastPromptAt declared near session init (line ~85) to avoid TDZ
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const watchdogTimer = setInterval(() => {
  const now = Date.now();
  const uptimeMs = now - startedAt;
  const redisOk = isRedisHealthy();
  const telegramOk = channelInfo.telegram; // grammy self-heals via long-polling retry
  const stuckMs = _lastPromptAt > _lastTurnEndAt ? now - _lastPromptAt : 0;
  const isStuck = stuckMs > STUCK_THRESHOLD_MS;
  const failures = getConsecutiveFailures();
  const isDead = failures >= 3;

  if (!redisOk || isStuck || isDead) {
    console.warn("[gateway:watchdog] health check", {
      redis: redisOk ? "ok" : "DEGRADED",
      telegram: telegramOk ? "ok" : "disabled",
      ws: { port: wsServer.port, clients: wsClients.size },
      queueDepth: getQueueDepth(),
      uptimeMs,
      consecutiveFailures: failures,
      ...(isStuck ? { stuckForMs: stuckMs, lastPromptAt: new Date(_lastPromptAt).toISOString() } : {}),
    });

    if (isStuck) {
      console.error("[gateway:watchdog] session appears stuck — attempting abort");
      void emitGatewayOtel({
        level: "error",
        component: "daemon.watchdog",
        action: "watchdog.session_stuck",
        success: false,
        metadata: {
          stuckForMs: stuckMs,
          queueDepth: getQueueDepth(),
        },
      });
      session.abort().catch((e: any) =>
        console.error("[gateway:watchdog] abort failed", { error: e?.message })
      );
      // Reset so we don't spam abort
      _lastPromptAt = 0;
    }

    if (isDead) {
      console.error("[gateway:watchdog] session appears dead — too many consecutive prompt failures", {
        consecutiveFailures: failures,
      });
      void emitGatewayOtel({
        level: "fatal",
        component: "daemon.watchdog",
        action: "watchdog.session_dead",
        success: false,
        error: "session_recovery_restart",
        metadata: {
          consecutiveFailures: failures,
          queueDepth: getQueueDepth(),
          immediateTelegram: true,
        },
      });
      // Self-restart: the launchd service will bring us back
      // Messages are persisted in Redis Stream, so they'll replay on restart
      console.error("[gateway:watchdog] initiating self-restart for session recovery");
      void gracefulShutdown("watchdog:dead-session");
    }
  }
}, 30_000);

// Expose health for CLI / external checks
function getHealthStatus(): { healthy: boolean; components: Record<string, string | number> } {
  const redisOk = isRedisHealthy();
  const stuckMs = _lastPromptAt > _lastTurnEndAt ? Date.now() - _lastPromptAt : 0;
  const failures = getConsecutiveFailures();
  const isDead = failures >= 3;
  return {
    healthy: redisOk && stuckMs < STUCK_THRESHOLD_MS && !isDead,
    components: {
      redis: redisOk ? "ok" : "degraded",
      telegram: channelInfo.telegram ? "ok" : "disabled",
      ws: `ok (${wsClients.size} clients)`,
      session: isDead
        ? `dead (${failures} consecutive failures)`
        : stuckMs > STUCK_THRESHOLD_MS
          ? `stuck (${Math.round(stuckMs / 1000)}s)`
          : "ok",
      consecutivePromptFailures: failures,
    },
  };
}

await writeFile(PID_FILE, `${process.pid}\n`);
await writeFile(SESSION_ID_FILE, `${session.sessionId}\n`);

console.log("[gateway] daemon started", {
  pid: process.pid,
  sessionId: session.sessionId,
  model: describeModel(session.model),
  cwd: HOME,
  agentDir: AGENT_DIR,
  channels: [
    "redis",
    "console",
    ...(channelInfo.telegram ? ["telegram"] : []),
    ...(channelInfo.discord ? ["discord"] : []),
    ...(channelInfo.imessage ? ["imessage"] : []),
    ...(channelInfo.slack ? ["slack"] : []),
  ],
  pidFile: PID_FILE,
  wsPort: wsServer.port,
  wsPortFile: WS_PORT_FILE,
});

// Register gateway agent with agent-mail (non-blocking, non-fatal)
void registerGatewayAgent();

void emitGatewayOtel({
  level: "info",
  component: "daemon",
  action: "daemon.started",
  success: true,
  metadata: {
    pid: process.pid,
    wsPort: wsServer.port,
    telegramEnabled: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
    discordEnabled: Boolean(DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID),
    imessageEnabled: Boolean(IMESSAGE_ALLOWED_SENDER),
    slackEnabled: channelInfo.slack,
  },
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[gateway] shutting down", { signal });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.shutdown.started",
    success: true,
    metadata: { signal },
  });

  clearInterval(queueDrainTimer);
  clearInterval(watchdogTimer);

  try {
    wsServer.stop(true);
  } catch (error) {
    console.error("[gateway] ws server shutdown failed", { error });
  }

  try {
    await heartbeatRunner.shutdown();
  } catch (error) {
    console.error("[gateway] heartbeat shutdown failed", { error });
  }

  try {
    await shutdownDiscord();
  } catch (error) {
    console.error("[gateway] discord shutdown failed", { error });
  }

  try {
    await shutdownIMessage();
  } catch (error) {
    console.error("[gateway] imessage shutdown failed", { error });
  }

  try {
    await shutdownSlack();
  } catch (error) {
    console.error("[gateway] slack shutdown failed", { error });
  }

  try {
    await shutdownTelegram();
  } catch (error) {
    console.error("[gateway] telegram shutdown failed", { error });
  }

  try {
    await shutdownRedisChannel();
  } catch (error) {
    console.error("[gateway] redis shutdown failed", { error });
  }

  try {
    fallbackController.dispose();
  } catch { /* swallow */ }

  try {
    session.dispose();
  } catch (error) {
    console.error("[gateway] session disposal failed", { error });
  }

  try {
    await rm(PID_FILE, { force: true });
  } catch (error) {
    console.error("[gateway] failed removing PID file", { error });
  }

  try {
    await rm(WS_PORT_FILE, { force: true });
  } catch (error) {
    console.error("[gateway] failed removing WS port file", { error });
  }

  try {
    await rm(SESSION_ID_FILE, { force: true });
  } catch (error) {
    console.error("[gateway] failed removing session ID file", { error });
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

// Keep the event loop alive — Bun may exit after session.prompt() resolves
// even with bot.start() polling and setInterval timers active
setInterval(() => {}, 30_000);

process.on("uncaughtException", (error) => {
  console.error("[gateway] uncaught exception", { error: error.message, stack: error.stack });
  void emitGatewayOtel({
    level: "fatal",
    component: "daemon",
    action: "daemon.uncaught_exception",
    success: false,
    error: error.message,
    metadata: { stack: error.stack, immediateTelegram: true },
  });
  broadcastWs({ type: "error", message: error.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandled rejection", { reason });
  void emitGatewayOtel({
    level: "error",
    component: "daemon",
    action: "daemon.unhandled_rejection",
    success: false,
    error: String(reason),
  });
  broadcastWs({ type: "error", message: `Unhandled rejection: ${String(reason)}` });
});
