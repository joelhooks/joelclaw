/**
 * Restate Lab — Worker entry point.
 *
 * Serves all lab services/workflows and starts the channel callback listener.
 *
 * Environment:
 *   LAB_PORT          — Worker port (default: 9090)
 *   CHANNEL           — "telegram" or "console" (default: telegram if tokens present)
 *   TELEGRAM_BOT_TOKEN — Telegram bot token
 *   TELEGRAM_USER_ID   — Telegram chat ID for notifications
 *   RESTATE_INGRESS_URL — Restate ingress (default: http://localhost:8080)
 */

import * as restate from "@restatedev/restate-sdk";

// Level 1
import { labService } from "./level1";

// Level 3
import { approvalWorkflow, setChannel } from "./workflows/approval";
import { TelegramChannel } from "./channels/telegram";
import { ConsoleChannel } from "./channels/console";
import { resolveCallback } from "./resolver";
import type { NotificationChannel } from "./channels/types";

// --- Channel setup ---

function createChannel(): NotificationChannel {
  const explicit = process.env.CHANNEL;

  if (explicit === "console") {
    return new ConsoleChannel();
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
setChannel(channel);

// --- Start callback listener ---

const stopListener = await channel.startCallbackListener(resolveCallback);

// Cleanup on exit
process.on("SIGINT", () => {
  stopListener();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopListener();
  process.exit(0);
});

// --- Serve ---

const port = Number(process.env.LAB_PORT ?? 9090);

restate.serve({
  services: [labService, approvalWorkflow],
  port,
});

console.log(`\n🧪 Restate Lab`);
console.log(`   Worker: port ${port}`);
console.log(`   Channel: ${channel.id}`);
console.log(`   Services: labService, approvalWorkflow`);
console.log(`\n   Level 1: bun run send`);
console.log(`   Level 3: bun run send-approval`);
console.log(``);
