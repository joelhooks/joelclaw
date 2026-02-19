import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { drain, enqueue, getQueueDepth, getCurrentSource, setSession } from "./command-queue";
import { start as startRedisChannel, shutdown as shutdownRedisChannel } from "./channels/redis";
import { start as startTelegram, shutdown as shutdownTelegram, send as sendTelegram, sendMedia as sendTelegramMedia, parseChatId } from "./channels/telegram";
import { startHeartbeatRunner } from "./heartbeat";

const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi/agent");
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;
const WS_PORT_FILE = `${PID_DIR}/gateway.ws.port`;
const JOELCLAW_DIR = join(HOME, ".joelclaw");
const SESSION_ID_FILE = join(JOELCLAW_DIR, "gateway.session");
// Gateway uses a fixed, well-known session file — deterministic, not "most recent".
// Pattern borrowed from OpenClaw: named session keys → fixed file paths.
const GATEWAY_SESSION_DIR = join(JOELCLAW_DIR, "sessions", "gateway");
const GATEWAY_SESSION_FILE = join(GATEWAY_SESSION_DIR, "gateway.jsonl");
const DEFAULT_WS_PORT = 3018;
const WS_PORT = Number.parseInt(process.env.PI_GATEWAY_WS_PORT ?? `${DEFAULT_WS_PORT}`, 10) || DEFAULT_WS_PORT;
const startedAt = Date.now();

function resolveModel() {
  const provider = process.env.PI_MODEL_PROVIDER;
  const modelId = process.env.PI_MODEL ?? process.env.PI_MODEL_ID;

  if (!provider || !modelId) return undefined;

  const model = getModel(provider as any, modelId as any);
  if (!model) {
    console.warn("[gateway] requested model not found; using SDK default", { provider, modelId });
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

// Resume the most recent session in the gateway session dir, or create a new one.
// SessionManager.continueRecent() finds the latest .jsonl by mtime — no hardcoded filename.
// Restarts always resume context; survives launchd restarts.
import { mkdirSync, readdirSync } from "node:fs";
mkdirSync(GATEWAY_SESSION_DIR, { recursive: true });
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

const { session } = await createAgentSession({
  cwd: HOME,
  agentDir: AGENT_DIR,
  model: resolveModel(),
  sessionManager,
});

setSession({
  prompt: (text: string) => session.prompt(text),
});

// ── Config ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;
const channelInfo = {
  redis: true,
  console: true,
  telegram: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
};

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
  return {
    sessionId: session.sessionId,
    isStreaming: responseChunks.length > 0,
    model: describeModel(session.model),
    uptimeMs: Date.now() - startedAt,
    pid: process.pid,
    channelInfo: {
      ...channelInfo,
      ws: {
        port: wsServer.port,
        clients: wsClients.size,
      },
    },
    queueDepth: getQueueDepth(),
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
        enqueue("tui", text, { via: "ws" });
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
    broadcastWs({ type: "text_delta", delta });
  }

  // On message end, route the full response to the source channel
  if (event.type === "message_end") {
    const fullText = responseChunks.join("");
    responseChunks = [];

    if (!fullText.trim()) return;

    const source = getCurrentSource() ?? "console";
    console.log("[gateway] response ready", { source, length: fullText.length });

    // Route to Telegram if source is telegram:*
    if (source.startsWith("telegram:") && TELEGRAM_TOKEN) {
      const chatId = parseChatId(source) ?? TELEGRAM_USER_ID;
      if (chatId) {
        sendTelegram(chatId, fullText).catch((e: any) =>
          console.error("[gateway] telegram send failed", { error: e.message })
        );
      }
    } else {
      // Console channel — just log
      console.log("[gateway] assistant:", fullText.slice(0, 200));
    }
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
    broadcastWs({ type: "turn_end" });
    void drain();
  }
});

// ── Redis channel ──────────────────────────────────────
await startRedisChannel(((source, prompt, metadata) => {
  enqueue(source, prompt, metadata);
  void drain();
}));

// ── Telegram channel ───────────────────────────────────
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  await startTelegram(TELEGRAM_TOKEN, TELEGRAM_USER_ID, (source, prompt, metadata) => {
    enqueue(source, prompt, metadata);
    void drain();
  });
} else {
  console.warn("[gateway] telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID env vars");
}

// ── Media outbound: satellite sessions push files, we deliver ──────
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
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
  // Also drain on startup in case anything queued while daemon was down
  await drainMediaOutbound();
  console.log("[gateway] media outbound listener started");
}

const heartbeatRunner = startHeartbeatRunner();
const queueDrainTimer = setInterval(() => {
  void drain();
}, 1000);
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

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[gateway] shutting down", { signal });

  clearInterval(queueDrainTimer);

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
  broadcastWs({ type: "error", message: error.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandled rejection", { reason });
  broadcastWs({ type: "error", message: `Unhandled rejection: ${String(reason)}` });
});
