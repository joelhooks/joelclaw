import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { drain, enqueue, setSession } from "./command-queue";
import { start as startRedisChannel, shutdown as shutdownRedisChannel } from "./channels/redis";
import { start as startTelegram, shutdown as shutdownTelegram, send as sendTelegram, parseChatId } from "./channels/telegram";
import { startHeartbeatRunner } from "./heartbeat";
import { wireSession, registerChannel } from "./outbound/router";

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
  prompt: (prompt: string) => session.prompt(prompt),
});

await wireSession(session);

// ── Redis channel ──────────────────────────────────────
await startRedisChannel(((source, prompt, metadata) => {
  enqueue(source, prompt, metadata);
  void drain();
}));

// ── Telegram channel ───────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;

if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  // Register Telegram outbound — route replies back to the chat that sent the message
  registerChannel("telegram", {
    send: async (message: string, context?: { source?: string }) => {
      const source = context?.source ?? "";
      const chatId = parseChatId(source) ?? TELEGRAM_USER_ID;
      await sendTelegram(chatId, message);
    },
  });

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

const unsubscribeAgent = session.subscribe((event: { type?: string }) => {
  if (event.type === "agent_end") {
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
  unsubscribeAgent();

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
