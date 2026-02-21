import { inngest } from "../client";
import { emitOtelEvent } from "../../observability/emit";

const SNOOZE_ACTION = "s4h";
const SNOOZE_HOURS = 4;
const DEDUP_KEY_PATTERN = /^[a-f0-9]{64}$/iu;

function decodeSnoozeContext(context: string): string | null {
  const trimmed = context.trim();
  if (!trimmed) return null;

  if (DEDUP_KEY_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  try {
    const decoded = Buffer.from(trimmed, "base64url").toString("hex");
    if (DEDUP_KEY_PATTERN.test(decoded)) {
      return decoded.toLowerCase();
    }
  } catch {
    return null;
  }

  return null;
}

export const telegramCallbackReceived = inngest.createFunction(
  { id: "telegram-callback-received", name: "Telegram Callback: Received" },
  { event: "telegram/callback.received" },
  async ({ event, step }) => {
    const action = typeof event.data.action === "string" ? event.data.action : "";
    const context = typeof event.data.context === "string" ? event.data.context : "";
    const rawData = typeof event.data.rawData === "string" ? event.data.rawData : null;
    const chatId = typeof event.data.chatId === "number" ? event.data.chatId : null;
    const messageId = typeof event.data.messageId === "number" ? event.data.messageId : null;

    if (action !== SNOOZE_ACTION) {
      return { handled: false, reason: "unsupported_action", action };
    }

    const dedupKey = decodeSnoozeContext(context);
    if (!dedupKey) {
      await step.run("emit-invalid-snooze-callback", async () => {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "o11y-triage",
          action: "triage.snooze_invalid",
          success: false,
          error: "invalid_snooze_context",
          metadata: {
            action,
            context,
            rawData,
            chatId,
            messageId,
          },
        });
      });

      return { handled: false, reason: "invalid_context", action };
    }

    const snoozeUntilMs = Date.now() + SNOOZE_HOURS * 60 * 60 * 1000;
    await step.run("emit-tier3-snoozed", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "o11y-triage",
        action: "triage.snoozed",
        success: true,
        metadata: {
          action,
          dedupKey,
          snoozeHours: SNOOZE_HOURS,
          snoozeUntilMs,
          rawData,
          chatId,
          messageId,
        },
      });
    });

    return {
      handled: true,
      action,
      dedupKey,
      snoozeHours: SNOOZE_HOURS,
      snoozeUntilMs,
    };
  }
);
