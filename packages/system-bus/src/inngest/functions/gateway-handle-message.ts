import { classifyMessage } from "../../lib/message-types";
import { getRedis } from "../../lib/redis";
import { querySystemKnowledge } from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const SYSTEM_KNOWLEDGE_LIMIT = 3;

type GatewayProcessingEvent = {
  chatId: string;
  messageId: string;
  text: string;
  channel: string;
  isHuman: boolean;
  timestamp: number;
};

export const gatewayHandleMessage = inngest.createFunction(
  {
    id: "gateway-handle-message",
    name: "Gateway: Handle Message",
    concurrency: [
      {
        key: "event.data.chatId",
        limit: 1,
      },
    ],
    cancelOn: [
      {
        event: "gateway/message.processing",
        match: "data.chatId",
        if: "event.data.isHuman == true && async.data.isHuman == true",
      },
    ],
  },
  { event: "gateway/message.processing" },
  async ({ event, step }) => {
    const message = event.data as GatewayProcessingEvent;

    await step.sleep("batch-window", "1.5s");

    const supersededBy = await step.run("check-batch-window-latest-message", async () => {
      const redisKey = `gateway:chat:${message.chatId}:latest_message_id`;
      const redis = getRedis();
      const latestMessageId = await redis.get(redisKey);
      const newerMessageId =
        latestMessageId && latestMessageId !== message.messageId ? latestMessageId : null;

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "gateway-handle-message",
        action: "gateway.message.batch_window",
        success: newerMessageId === null,
        metadata: {
          eventId: event.id ?? null,
          chatId: message.chatId,
          messageId: message.messageId,
          latestMessageId,
          superseded: newerMessageId !== null,
          channel: message.channel,
          redisKey,
        },
      });

      return newerMessageId;
    });

    if (supersededBy) {
      return { status: "superseded", by: supersededBy };
    }

    const triggerMessageType = await step.run("classify-trigger-message-type", async () => {
      const classified = classifyMessage(message.text);
      const isSystemMessage = classified === "system";

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "gateway-handle-message",
        action: "gateway.message.classified",
        success: true,
        metadata: {
          eventId: event.id ?? null,
          chatId: message.chatId,
          messageId: message.messageId,
          channel: message.channel,
          classified,
          eventIsHuman: message.isHuman,
          isSystemMessage,
        },
      });

      return {
        classified,
        isSystemMessage,
      };
    });

    const systemKnowledge = await step.run("query-system-knowledge", async () => {
      const startedAt = Date.now();
      try {
        const context = await querySystemKnowledge(
          `gateway cancel-on-new-message ${message.channel} ${message.chatId}`,
          { types: ["pattern", "lesson"], limit: SYSTEM_KNOWLEDGE_LIMIT },
        );

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "gateway-handle-message",
          action: "system_knowledge.retrieval",
          success: true,
          metadata: {
            eventId: event.id ?? null,
            chatId: message.chatId,
            messageId: message.messageId,
            channel: message.channel,
            hasResults: context.length > 0,
            resultLength: context.length,
            latencyMs: Date.now() - startedAt,
          },
        });

        return context;
      } catch (error) {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "gateway-handle-message",
          action: "system_knowledge.retrieval",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          metadata: {
            eventId: event.id ?? null,
            chatId: message.chatId,
            messageId: message.messageId,
            channel: message.channel,
            latencyMs: Date.now() - startedAt,
          },
        });

        return "";
      }
    });

    if (triggerMessageType.isSystemMessage) {
      await step.run("process-system-message-directly", async () => {
        console.log("[gateway-handle-message] processing system message", {
          chatId: message.chatId,
          messageId: message.messageId,
          channel: message.channel,
          timestamp: message.timestamp,
          text: message.text,
        });

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "gateway-handle-message",
          action: "gateway.message.system_bypass",
          success: true,
          metadata: {
            eventId: event.id ?? null,
            chatId: message.chatId,
            messageId: message.messageId,
            channel: message.channel,
            timestamp: message.timestamp,
            systemKnowledgeLength: systemKnowledge.length,
            classified: triggerMessageType.classified,
          },
        });
      });

      return {
        processed: true,
        messageId: message.messageId,
        mode: "system-bypass",
      };
    }

    const guard = await step.run("guard-human-message", async () => {
      const isHumanByText = triggerMessageType.classified === "human";
      const shouldProcess = message.isHuman && isHumanByText;

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "gateway-handle-message",
        action: "gateway.message.guard",
        success: shouldProcess,
        metadata: {
          eventId: event.id ?? null,
          chatId: message.chatId,
          messageId: message.messageId,
          channel: message.channel,
          classified: triggerMessageType.classified,
          eventIsHuman: message.isHuman,
          isHumanByText,
        },
      });

      return {
        classified: triggerMessageType.classified,
        shouldProcess,
      };
    });

    if (!guard.shouldProcess) {
      return {
        processed: false,
        messageId: message.messageId,
      };
    }

    await step.run("log-message-placeholder", async () => {
      console.log("[gateway-handle-message] processing human message", {
        chatId: message.chatId,
        messageId: message.messageId,
        channel: message.channel,
        timestamp: message.timestamp,
        text: message.text,
      });

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "gateway-handle-message",
        action: "gateway.message.processing",
        success: true,
        metadata: {
          eventId: event.id ?? null,
          chatId: message.chatId,
          messageId: message.messageId,
          channel: message.channel,
          timestamp: message.timestamp,
          systemKnowledgeLength: systemKnowledge.length,
        },
      });
    });

    return { processed: true, messageId: message.messageId };
  },
);
