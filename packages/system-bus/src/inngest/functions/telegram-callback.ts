import { inngest } from "../client";
import { emitOtelEvent } from "../../observability/emit";
import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";

const SNOOZE_ACTION = "s4h";
const SNOOZE_HOURS = 4;
const DEDUP_KEY_PATTERN = /^[a-f0-9]{64}$/iu;
const MEMORY_CALLBACK_PATTERN = /^memory:(approve|reject):([^:]+)$/iu;

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

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
    const callbackData = rawData ?? `${action}${context ? `:${context}` : ""}`;
    const memoryMatch = MEMORY_CALLBACK_PATTERN.exec(callbackData);

    if (memoryMatch) {
      const memoryAction = memoryMatch[1]?.toLowerCase();
      const proposalId = (memoryMatch[2] ?? "").trim();

      if (!proposalId) {
        return { handled: false, reason: "invalid_proposal_id", action, callbackData };
      }

      const proposalContext = await step.run("read-memory-proposal-context", async () => {
        const redis = getRedis();
        const key = `memory:review:proposal:${proposalId}`;
        const asJson = await redis.get(key);
        if (asJson) {
          try {
            return JSON.parse(asJson) as Record<string, unknown>;
          } catch {
            return { raw: asJson };
          }
        }

        const asHash = await redis.hgetall(key);
        if (Object.keys(asHash).length > 0) {
          return asHash as Record<string, unknown>;
        }

        return null;
      });

      if (memoryAction === "approve") {
        await step.sendEvent("emit-memory-proposal-approved", {
          name: "memory/proposal.approved",
          data: {
            proposalId,
            approvedBy: "telegram-callback",
            proposalContext: {
              proposal: proposalContext,
              callback: {
                action,
                context,
                rawData,
                chatId,
                messageId,
              },
            },
          },
        });

        await step.run("emit-memory-proposal-approved-otel", async () => {
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "memory-review",
            action: "proposal.approved_callback",
            success: true,
            metadata: {
              proposalId,
              callbackData,
              chatId,
              messageId,
              hasProposalContext: Boolean(proposalContext),
            },
          });
        });

        return {
          handled: true,
          action: "memory:approve",
          proposalId,
          hasProposalContext: Boolean(proposalContext),
        };
      }

      await step.sendEvent("emit-memory-proposal-rejected", {
        name: "memory/proposal.rejected",
        data: {
          proposalId,
          reason: "rejected from telegram callback",
          rejectedBy: "telegram-callback",
          proposalContext: {
            proposal: proposalContext,
            callback: {
              action,
              context,
              rawData,
              chatId,
              messageId,
            },
          },
        },
      });

      await step.run("emit-memory-proposal-rejected-otel", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "memory-review",
          action: "proposal.rejected_callback",
          success: true,
          metadata: {
            proposalId,
            callbackData,
            chatId,
            messageId,
            hasProposalContext: Boolean(proposalContext),
          },
        });
      });

      return {
        handled: true,
        action: "memory:reject",
        proposalId,
        hasProposalContext: Boolean(proposalContext),
      };
    }

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
