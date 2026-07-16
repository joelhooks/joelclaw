/**
 * gateway/send.message handler
 *
 * Receives outbound message requests from other Inngest functions and pushes
 * them to the Redis queue consumed by the gateway daemon. The queue envelope
 * carries a privacy-safe audit context so one flow ID survives every hop.
 */

import { createHash } from "node:crypto";
import {
  clickHouseClientLayer,
  createJournalEvent,
  type JournalEventInput,
  journalOutboxLayer,
  MessageJournalWriter,
  type MessageJournalWriterService,
  makeJournalOutbox,
  messageJournalTelemetryLive,
  messageJournalWriterLayer,
  resolveMessageJournalConnection,
} from "@joelclaw/message-journal";
// The journal workspace package owns the Effect runtime. Keep this consumer
// dependency-free as required by the gateway deployment contract.
import { Effect, Layer } from "@joelclaw/message-journal/node_modules/effect";
import Redis from "ioredis";
import { buildQueuedGatewayMessage } from "../../lib/channel-delivery-audit";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const OUTBOUND_QUEUE = "joelclaw:outbound:messages";

let writerPromise: Promise<MessageJournalWriterService> | undefined;
let writeOverride: ((row: ReturnType<typeof createJournalEvent>) => Promise<void>) | undefined;

function getRedis(): Redis {
  return new Redis({ host: "localhost", port: getRedisPort() });
}

function journalRevision(sourceEventId: string): number {
  const revision = createHash("sha256").update(sourceEventId).digest().readUInt32BE(0);
  return Math.max(1, revision);
}

async function createWriter(): Promise<MessageJournalWriterService> {
  const connection = await Effect.runPromise(resolveMessageJournalConnection("writer"));
  const dependencies = Layer.mergeAll(
    clickHouseClientLayer(connection),
    journalOutboxLayer(),
    messageJournalTelemetryLive,
  );
  const layer = messageJournalWriterLayer(connection).pipe(Layer.provide(dependencies));
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* MessageJournalWriter;
    }).pipe(Effect.provide(layer)),
  );
}

function getWriter(): Promise<MessageJournalWriterService> {
  writerPromise ??= createWriter();
  return writerPromise;
}

async function journalQueuedMessage(input: JournalEventInput): Promise<void> {
  let row: ReturnType<typeof createJournalEvent> | undefined;
  try {
    row = createJournalEvent(input);
    if (writeOverride) {
      await writeOverride(row);
      return;
    }
    const writer = await getWriter();
    const completed = await Effect.runPromise(
      writer.write(row).pipe(
        Effect.as(true),
        Effect.timeout("2 seconds"),
        Effect.catchAllCause(() => Effect.succeed(false)),
      ),
    );
    if (completed) return;
  } catch {
    // Configuration and construction failures are handled by the fail-open
    // boundary below. Exact message text never enters OTEL.
  }

  if (row) {
    const queued = await Effect.runPromise(
      makeJournalOutbox().enqueue(row).pipe(
        Effect.as(true),
        Effect.catchAllCause(() => Effect.succeed(false)),
      ),
    );
    if (queued) return;
  }

  void emitOtelEvent({
    level: "error",
    source: "worker",
    component: "gateway-send-message",
    action: "message_journal.write.failed",
    success: false,
    error: "MESSAGE_JOURNAL_WRITE_FAILED",
    metadata: {
      journalEventId: row?.journal_event_id ?? "construction-failed",
      flowId: row?.flow_id ?? input.flowId,
      stage: row ? "gateway_send_message_fail_open" : "event_construction",
      errorCode: row ? "WRITER_AND_OUTBOX_FAILED" : "JOURNAL_EVENT_INVALID",
    },
  }).catch(() => undefined);
}

export const __gatewaySendMessageTestUtils = {
  journalQueuedMessage,
  journalRevision,
  setWriteOverride(
    override: ((row: ReturnType<typeof createJournalEvent>) => Promise<void>) | undefined,
  ): void {
    writeOverride = override;
  },
  clear(): void {
    writeOverride = undefined;
    writerPromise = undefined;
  },
};

export const gatewaySendMessage = inngest.createFunction(
  {
    id: "gateway-send-message",
    name: "Gateway: Send Message",
    retries: 3,
  },
  { event: "gateway/send.message" },
  async ({ event, step }) => {
    const queued = await step.run("push-to-outbound-queue", async () => {
      const redis = getRedis();
      const message = buildQueuedGatewayMessage(event.data, {
        eventId: event.id,
        eventTimestampMs: event.ts,
      });
      const sourceEventId = event.id ?? message.audit.eventId ?? message.audit.flowId;
      const revision = journalRevision(sourceEventId);
      const queuedMessage = {
        ...message,
        journal_revision: revision,
      };

      try {
        const content = message.caption ?? message.text ?? "";
        const telegramChatId = /^telegram:-?\d+$/u.test(message.channel)
          ? Number.parseInt(message.channel.slice("telegram:".length), 10)
          : Number.parseInt(process.env.TELEGRAM_USER_ID ?? "0", 10) || 0;
        await journalQueuedMessage({
          messageKey: `gateway-queue:${message.audit.flowId}`,
          flowId: message.audit.flowId,
          channel: message.channel,
          direction: "outbound",
          eventType: "delivery.queued",
          contentKind: message.media_url || message.media_path ? "media" : "text",
          occurredAt: new Date(message.audit.queuedAtMs ?? Date.now()),
          producer: message.audit.producer,
          originSystemId: message.audit.originSystemId,
          sourceEventId: message.audit.eventId,
          sourceRef: "gateway/send.message",
          route: message.audit.route ?? "redis-outbound",
          classification: "unclassified",
          reason: "queued.gateway-send-message",
          telegramChatId,
          telegramMessageId: message.edit_message_id,
          revision,
          text: content,
          transportText: content,
          deliveryState: "queued",
          metadata: {
            channel: message.channel,
            hasKeyboard: Boolean(message.inline_keyboard),
            editMessage: Boolean(message.edit_message_id),
            hasMedia: Boolean(message.media_url || message.media_path),
          },
        });

        const queueDepth = await redis.rpush(OUTBOUND_QUEUE, JSON.stringify(queuedMessage));
        await redis.publish("joelclaw:notify:outbound", "1");

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "gateway-send-message",
          action: "channel.delivery.queued",
          success: true,
          metadata: {
            ...message.audit,
            channel: message.channel,
            queueDepth,
            hasKeyboard: Boolean(message.inline_keyboard),
            editMessage: Boolean(message.edit_message_id),
            hasMedia: Boolean(message.media_url || message.media_path),
          },
        });

        return {
          channel: message.channel,
          flowId: message.audit.flowId,
          queueDepth,
        };
      } finally {
        await redis.quit().catch(() => undefined);
      }
    });

    return { queued: true, ...queued };
  },
);
