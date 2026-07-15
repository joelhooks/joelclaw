import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { begin, finish, pushDelta, turnEnd } from "./telegram-stream";

const originalFetch = globalThis.fetch;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;
let otelPayloads: Array<Record<string, unknown>> = [];

beforeEach(() => {
  otelPayloads = [];
  process.env.OTEL_EVENTS_ENABLED = "true";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      otelPayloads.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  turnEnd();
  globalThis.fetch = originalFetch;
  if (originalOtelEnabled === undefined) {
    delete process.env.OTEL_EVENTS_ENABLED;
  } else {
    process.env.OTEL_EVENTS_ENABLED = originalOtelEnabled;
  }
});

function fakeBot(options?: { finalEditError?: unknown }): Bot {
  return {
    api: {
      sendChatAction: async () => true,
      sendMessage: async () => ({ message_id: 101 }),
      editMessageText: async () => {
        if (options?.finalEditError) throw options.finalEditError;
        return true;
      },
    },
  } as unknown as Bot;
}

describe("Telegram stream delivery audit", () => {
  test("preserves the inbound flow through Bot API confirmation", async () => {
    begin({
      chatId: 1,
      bot: fakeBot(),
      replyTo: 42,
      audit: {
        flowId: "telegram-inbound:1:42",
        producer: "telegram-user",
        originSystemId: "flagg",
        requestedAtMs: 1_000,
      },
    });
    pushDelta("hello from the gateway");

    expect(await finish("hello from the gateway")).toBe(true);

    const confirmed = otelPayloads.find(payload => payload.action === "telegram.delivery.confirmed");
    expect(confirmed).toBeDefined();
    expect(confirmed?.metadata).toMatchObject({
      flowId: "telegram-inbound:1:42",
      producer: "telegram-user",
      originSystemId: "flagg",
      inReplyToMessageId: 42,
      telegramMessageIds: [101],
      streaming: true,
    });
    expect(JSON.stringify(confirmed?.metadata)).not.toContain("hello from the gateway");
  });

  test("records partial delivery without duplicating the streamed response", async () => {
    const error = Object.assign(new Error("request contained SECRET body"), {
      name: "GrammyError",
      error_code: 400,
      description: "Bad Request: malformed entities",
    });
    begin({
      chatId: 1,
      bot: fakeBot({ finalEditError: error }),
      replyTo: 42,
      audit: {
        flowId: "telegram-inbound:1:42",
        producer: "telegram-user",
      },
    });
    pushDelta("private response body");

    expect(await finish("private response body")).toBe(true);

    const partial = otelPayloads.find(
      payload => payload.action === "telegram.delivery.partial",
    );
    expect(partial).toMatchObject({
      success: false,
      error: "GrammyError:400:Bad Request: malformed entities",
    });
    expect(partial?.metadata).toMatchObject({
      flowId: "telegram-inbound:1:42",
      telegramMessageIds: [101],
    });
    expect(JSON.stringify(partial?.metadata)).not.toContain("SECRET");
    expect(JSON.stringify(partial?.metadata)).not.toContain("private response body");
  });
});
