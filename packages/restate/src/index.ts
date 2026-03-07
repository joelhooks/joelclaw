/**
 * Restate Worker — joelclaw production durable workflows.
 *
 * Serves all Restate services and starts channel callback listeners.
 *
 * Environment:
 *   RESTATE_PORT        — Worker port (default: 9080)
 *   CHANNEL             — "telegram", "console", or "noop" (default: telegram if tokens present)
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token
 *   TELEGRAM_USER_ID    — Telegram chat ID
 *   RESTATE_INGRESS_URL — Restate ingress (default: http://localhost:8080)
 */

import * as restate from "@restatedev/restate-sdk";

import { ConsoleChannel } from "./channels/console";
import { NoopChannel } from "./channels/noop";
import { TelegramChannel } from "./channels/telegram";
import type { NotificationChannel } from "./channels/types";
import { startQueueDrainer } from "./queue-drainer";
import { resolveCallback } from "./resolver";
import { dagOrchestrator, dagWorker } from "./workflows/dag-orchestrator";
import { deployGate, setDeployChannel } from "./workflows/deploy-gate";

// --- Channel setup ---

function createChannel(): NotificationChannel {
  const explicit = process.env.CHANNEL;

  if (explicit === "console") {
    return new ConsoleChannel();
  }

  if (explicit === "noop") {
    return new NoopChannel();
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;

  if (botToken && chatId) {
    return new TelegramChannel({ botToken, chatId });
  }

  console.log(`⚠️  No TELEGRAM_BOT_TOKEN/TELEGRAM_USER_ID — falling back to console channel`);
  return new ConsoleChannel();
}

const channel = createChannel();
setDeployChannel(channel);

// --- Callback listener ---

const stopListener = await channel.startCallbackListener(resolveCallback);
const stopQueueDrainer = await startQueueDrainer();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 Restate worker shutting down (${signal})`);

  await Promise.allSettled([
    Promise.resolve().then(() => stopQueueDrainer()),
    Promise.resolve().then(() => stopListener()),
  ]);

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// --- Serve ---

const port = Number(process.env.RESTATE_PORT ?? 9080);

restate.serve({
  services: [deployGate, dagOrchestrator, dagWorker],
  port,
});

console.log(`\n⚡ Restate Worker — joelclaw`);
console.log(`   Port: ${port}`);
console.log(`   Channel: ${channel.id}`);
console.log(`   Workflows: deployGate, dagOrchestrator`);
console.log(`   Services: dagWorker`);
console.log(`   Queue drainer: ${process.env.QUEUE_DRAINER_ENABLED ?? "enabled"}`);
console.log(``);
