// Live proof: register a brain memory action, run the brain-reminder
// adapter's snooze through the live gateway Inngest emitter, and let the
// deployed signal/reminder function DM Joel back after a short delay.
// This is exactly what a Snooze button tap drives, minus the Telegram tap.
// Run from packages/gateway with system-bus env sourced (INNGEST_EVENT_KEY).

import {
  makeBrainReminderSourceAdapter,
  makeRedisActionRegistry,
} from "@joelclaw/source-actions";
import { Effect } from "effect";
import Redis from "ioredis";
import { makeGatewayReminderEmitter } from "../src/digest-gateway";

const DELAY_MS = Number(process.env.PROVE_DELAY_MS ?? "90000");
const slug = "telegram-signal-system";
const openUrl = "https://brain.joelclaw.com/projects/telegram-signal-system";

async function main() {
  const redis = new Redis({ host: "127.0.0.1", port: 6379 });
  const registry = makeRedisActionRegistry(redis as never);
  const emitReminder = makeGatewayReminderEmitter();

  const adapter = makeBrainReminderSourceAdapter({
    slug,
    title: "Telegram signal system",
    openUrl,
    emitReminder,
  });

  const record = await Effect.runPromise(
    registry.register({
      sourceRef: { kind: "brain", id: slug, revision: openUrl },
      allowedOperations: ["snooze", "acknowledge"],
    }),
  );

  const item = await Effect.runPromise(
    adapter.inspect({ kind: "brain", id: slug, revision: openUrl }),
  );

  const until = new Date(Date.now() + DELAY_MS);
  const receipt = await Effect.runPromise(
    adapter.snooze(item, until, {
      actionId: record.actionId,
      actor: "joel",
      telegramMessageId: 0,
      requestedAt: new Date().toISOString(),
    }),
  );

  console.log(JSON.stringify({
    actionId: record.actionId,
    sourceRef: record.sourceRef,
    remindAt: until.toISOString(),
    delayMs: DELAY_MS,
    receipt,
  }, null, 2));

  redis.disconnect();
}

main().catch((error) => {
  console.error("prove-snooze failed:", error);
  process.exitCode = 1;
});
