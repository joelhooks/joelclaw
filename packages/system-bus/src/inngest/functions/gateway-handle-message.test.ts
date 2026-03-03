import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";

const otelEvents: Array<Record<string, unknown>> = [];
const redisGetCalls: string[] = [];
const systemKnowledgeQueries: Array<{ query: string; options: Record<string, unknown> }> = [];

let latestMessageId: string | null = null;
let systemKnowledgeResponse = "context";

mock.module("../../lib/redis", () => ({
  getRedisPort: () => 6379,
  getRedisClient: () => ({
    get: async (key: string) => {
      redisGetCalls.push(key);
      return latestMessageId;
    },
  }),
  getRedis: () => ({
    get: async (key: string) => {
      redisGetCalls.push(key);
      return latestMessageId;
    },
  }),
}));

mock.module("../../lib/typesense", () => ({
  querySystemKnowledge: async (query: string, options: Record<string, unknown>) => {
    systemKnowledgeQueries.push({ query, options });
    return systemKnowledgeResponse;
  },
}));

mock.module("../../observability/emit", () => ({
  emitOtelEvent: async (event: Record<string, unknown>) => {
    otelEvents.push(event);
    return { stored: false };
  },
}));

describe("gatewayHandleMessage system-event bypass", () => {
  beforeEach(() => {
    otelEvents.length = 0;
    redisGetCalls.length = 0;
    systemKnowledgeQueries.length = 0;
    latestMessageId = null;
    systemKnowledgeResponse = "context";
  });

  test("keeps cancelOn scoped to human-triggered runs", async () => {
    const { gatewayHandleMessage } = await import("./gateway-handle-message");

    const cancelOn = ((gatewayHandleMessage as any).opts?.cancelOn ?? [])[0] as
      | { if?: string; event?: string; match?: string }
      | undefined;

    expect(cancelOn).toMatchObject({
      event: "gateway/message.processing",
      match: "data.chatId",
      if: "event.data.isHuman == true && async.data.isHuman == true",
    });
  });

  test(
    "processes system messages directly without entering human cancel flow",
    async () => {
      const { gatewayHandleMessage } = await import("./gateway-handle-message");

      latestMessageId = "msg-system-1";

      const engine = new InngestTestEngine({
        function: gatewayHandleMessage as any,
        events: [
          {
            name: "gateway/message.processing",
            data: {
              chatId: "chat-system",
              messageId: "msg-system-1",
              text: "🔔 gateway heartbeat",
              channel: "telegram",
              isHuman: false,
              timestamp: Date.now(),
            },
          } as any,
        ],
        transformCtx: (ctx: any) => {
          ctx.step.sleep = async () => undefined;
          return ctx;
        },
      });

      await engine.execute();

      expect(redisGetCalls).toEqual(["gateway:chat:chat-system:latest_message_id"]);
      expect(systemKnowledgeQueries).toHaveLength(1);
      expect(systemKnowledgeQueries[0]?.query).toContain(
        "gateway cancel-on-new-message telegram chat-system",
      );

      expect(otelEvents.some((event) => event.action === "gateway.message.classified")).toBe(true);
      expect(otelEvents.some((event) => event.action === "gateway.message.system_bypass")).toBe(
        true,
      );
      expect(otelEvents.some((event) => event.action === "gateway.message.guard")).toBe(false);
      expect(otelEvents.some((event) => event.action === "gateway.message.processing")).toBe(
        false,
      );
    },
    15_000,
  );
});
