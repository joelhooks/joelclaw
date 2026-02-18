import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { drain, enqueue, setSession } from "./command-queue";
import { start as startRedisChannel, shutdown as shutdownRedisChannel } from "./channels/redis";
import { start as startTelegram, shutdown as shutdownTelegram, send as sendTelegram, parseChatId } from "./channels/telegram";
import { startHeartbeatRunner } from "./heartbeat";
import { getCurrentSource } from "./command-queue";

const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi/agent");
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;

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

const { session } = await createAgentSession({
  cwd: HOME,
  agentDir: AGENT_DIR,
  model: resolveModel(),
});

setSession({
  prompt: (text: string) => session.prompt(text),
});

// ── Config ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;

// ── Outbound: collect assistant responses and route to source channel ──
let responseChunks: string[] = [];

session.subscribe((event: any) => {
  // Collect text deltas
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    responseChunks.push(event.assistantMessageEvent.delta);
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

const heartbeatRunner = startHeartbeatRunner();
const queueDrainTimer = setInterval(() => {
  void drain();
}, 1000);

// Drain queue when agent finishes a turn
session.subscribe((event: any) => {
  if (event.type === "turn_end") {
    void drain();
  }
});

await mkdir(PID_DIR, { recursive: true });
await writeFile(PID_FILE, `${process.pid}\n`);

console.log("[gateway] daemon started", {
  pid: process.pid,
  sessionId: session.sessionId,
  model: describeModel(session.model),
  cwd: HOME,
  agentDir: AGENT_DIR,
  channels: ["redis", "console", ...(TELEGRAM_TOKEN ? ["telegram"] : [])],
  pidFile: PID_FILE,
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[gateway] shutting down", { signal });

  clearInterval(queueDrainTimer);

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
});

process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandled rejection", { reason });
});
