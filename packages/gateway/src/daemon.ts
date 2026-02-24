import { mkdirSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type LoadExtensionsResult } from "@mariozechner/pi-coding-agent";
import {
  drain,
  enqueue,
  getQueueDepth,
  getCurrentSource,
  setSession,
  setIdleWaiter,
  onPrompt,
  onError as onQueueError,
  replayUnacked,
  getConsecutiveFailures,
} from "./command-queue";
import { start as startRedisChannel, shutdown as shutdownRedisChannel, isHealthy as isRedisHealthy, getRedisClient } from "./channels/redis";
import { start as startTelegram, shutdown as shutdownTelegram, send as sendTelegram, sendMedia as sendTelegramMedia, parseChatId } from "./channels/telegram";
import { start as startDiscord, shutdown as shutdownDiscord, send as sendDiscord, markError as markDiscordError, parseChannelId as parseDiscordChannelId, getClient as getDiscordClient, fetchChannel as fetchDiscordChannel } from "./channels/discord";
import { start as startIMessage, shutdown as shutdownIMessage, send as sendIMessage } from "./channels/imessage";
import { defaultGatewayConfig, loadGatewayConfig, providerForModel } from "./commands/config";
import { getActiveMcqAdapter, type McqParams } from "./commands/mcq-adapter";
import { getActiveDiscordMcqAdapter, registerDiscordMcqAdapter } from "./commands/discord-mcq-adapter";
import { initializeTelegramCommandHandler, updatePinnedStatus } from "./commands/telegram-handler";
import { TRIPWIRE_PATH, startHeartbeatRunner } from "./heartbeat";
import { init as initMessageStore, trimOld } from "./message-store";
import { ModelFallbackController } from "./model-fallback";
import { emitGatewayOtel } from "./observability";
import { createEnvelope, type OutboundEnvelope } from "./outbound/envelope";
import { registerChannel, routeResponse } from "./outbound/router";

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

  // Use the model's actual provider (supports cross-provider fallback)
  const resolvedProvider = providerForModel(modelId) || process.env.PI_MODEL_PROVIDER;
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
      const source = getCurrentSource();
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
          const answers = await discordAdapter.handleMcqToolCall(params, channelId);
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
  newSession: () => session.newSession().then(() => {}),
});

// ── Model fallback controller (ADR-0091) ───────────────
const primaryProvider = providerForModel(startupGatewayConfig.model);
const fallbackController = new ModelFallbackController(
  startupGatewayConfig,
  primaryProvider,
  startupGatewayConfig.model,
);

// Track prompt dispatch timing for stuck-session detection
let _lastTurnEndAt = Date.now();
let _lastPromptAt = 0;
onPrompt(() => {
  _lastPromptAt = Date.now();
  fallbackController.onPromptDispatched();
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
const channelInfo = {
  redis: true,
  console: true,
  telegram: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
  discord: Boolean(DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID),
  imessage: Boolean(IMESSAGE_ALLOWED_SENDER),
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
      if (!chatId) return;

      try {
        await sendTelegram(chatId, envelope.text, {
          buttons: envelope.buttons,
          silent: envelope.silent,
          replyTo: envelope.replyTo,
        });
      } catch (error) {
        console.error("[gateway] telegram send failed", { error: String(error) });
      }
    },
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
  return {
    sessionId: session.sessionId,
    isStreaming: responseChunks.length > 0,
    model: describeModel(session.model),
    uptimeMs: Date.now() - startedAt,
    pid: process.pid,
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
        await enqueue("tui", text, { via: "ws" });
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
  // Collect text deltas
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    const delta = typeof event.assistantMessageEvent.delta === "string"
      ? event.assistantMessageEvent.delta
      : "";
    if (!delta) return;
    responseChunks.push(delta);
    fallbackController.onFirstToken();
    broadcastWs({ type: "text_delta", delta });
  }

  // On message end, route the full response to the source channel
  if (event.type === "message_end") {
    const fullText = responseChunks.join("");
    responseChunks = [];

    if (!fullText.trim()) return;

    const source = getCurrentSource() ?? "console";
    console.log("[gateway] response ready", { source, length: fullText.length });
    routeResponse(source, fullText);
  }

  if (event.type === "tool_call") {
    broadcastWs({
      type: "tool_call",
      id: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
  }

  if (event.type === "tool_result") {
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
    // Release the idle waiter so the drain loop can process the next entry
    if (_idleResolve) {
      const resolve = _idleResolve;
      _idleResolve = undefined;
      resolve();
    }
    void drain();
  }
});

const enqueueToGateway = async (source: string, prompt: string, metadata?: Record<string, unknown>) => {
  await enqueue(source, prompt, metadata);
  void drain();
};

// ── Redis channel (self-healing — retries on failure, won't crash daemon) ──
await startRedisChannel(enqueueToGateway);

const redisClient = getRedisClient();
if (redisClient) {
  await initMessageStore(redisClient);
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
        console.error("[gateway] discord send: no channel ID in context", { source: context?.source });
        return;
      }
      try {
        await sendDiscord(channelId, envelope.text);
      } catch (error) {
        console.error("[gateway] discord send failed", { error: String(error) });
      }
    },
  });

  try {
    await startDiscord(DISCORD_TOKEN, DISCORD_ALLOWED_USER_ID, enqueueToGateway);

    // ── Discord UI + MCQ adapter (ADR-0122) ──────────────────
    const discordClient = getDiscordClient();
    if (discordClient) {
      try {
        const { initDiscordUI } = await import("@joelclaw/discord-ui");
        initDiscordUI(discordClient);
        registerDiscordMcqAdapter(fetchDiscordChannel, getDiscordClient as () => any);
        console.log("[gateway] discord-ui initialized, MCQ adapter registered");
        void emitGatewayOtel({
          level: "info",
          component: "daemon",
          action: "daemon.discord-ui.initialized",
          success: true,
        });
      } catch (error) {
        console.error("[gateway] discord-ui init failed; interactive components disabled", { error: String(error) });
        void emitGatewayOtel({
          level: "error",
          component: "daemon",
          action: "daemon.discord-ui.init_failed",
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

// ── Init fallback controller (ADR-0091) ──────────────────
// Must happen after Telegram starts so notify can send alerts.
fallbackController.init(
  { setModel: (m) => session.setModel(m as any), get model() { return session.model; } },
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
  channels: ["redis", "console", ...(TELEGRAM_TOKEN ? ["telegram"] : [])],
  pidFile: PID_FILE,
  wsPort: wsServer.port,
  wsPortFile: WS_PORT_FILE,
});
void emitGatewayOtel({
  level: "info",
  component: "daemon",
  action: "daemon.started",
  success: true,
  metadata: {
    pid: process.pid,
    wsPort: wsServer.port,
    telegramEnabled: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
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
