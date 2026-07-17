import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import { createChannelDeliveryAudit } from "@joelclaw/telemetry";
import type { Bot } from "grammy";
import { __messageJournalTestUtils } from "./message-journal";
import { telegramConversationReplyExemption } from "./telegram-outbound-policy";
import { __telegramTestUtils } from "./telegram-runtime";
import { begin, finish, pushDelta, turnEnd } from "./telegram-stream";

const originalFetch = globalThis.fetch;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;
let otelPayloads: Array<Record<string, unknown>> = [];
let journalRows: JournalEvent[] = [];

beforeEach(() => {
  otelPayloads = [];
  journalRows = [];
  __messageJournalTestUtils.setWriteOverride(async (row) => {
    journalRows.push(row);
  });
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
  __messageJournalTestUtils.clear();
  globalThis.fetch = originalFetch;
  if (originalOtelEnabled === undefined) {
    delete process.env.OTEL_EVENTS_ENABLED;
  } else {
    process.env.OTEL_EVENTS_ENABLED = originalOtelEnabled;
  }
});

function fakeBot(options?: {
  initialSendError?: unknown;
  overflowSendError?: unknown;
  finalEditError?: unknown;
  onSendAttempt?: () => void;
  onChatAction?: () => void;
}): Bot {
  let sendCalls = 0;
  return {
    api: {
      sendChatAction: async () => {
        options?.onChatAction?.();
        return true;
      },
      sendMessage: async () => {
        sendCalls += 1;
        options?.onSendAttempt?.();
        if (sendCalls === 1 && options?.initialSendError) throw options.initialSendError;
        if (sendCalls > 1 && options?.overflowSendError) throw options.overflowSendError;
        return { message_id: 100 + sendCalls };
      },
      editMessageText: async () => {
        if (options?.finalEditError) throw options.finalEditError;
        return true;
      },
    },
  } as unknown as Bot;
}

describe("Telegram stream delivery audit", () => {
  test("records one complete inbound-to-stream lifecycle", async () => {
    const receivedAt = 1_000;
    const audit = createChannelDeliveryAudit("hello", {
      flowId: "telegram-inbound:1:42",
      producer: "telegram-user",
      originSystemId: "flagg",
      requestedAtMs: receivedAt,
      route: "telegram:1",
    }, receivedAt);
    await __telegramTestUtils.journalInboundText({
      text: "hello",
      chatId: 1,
      messageId: 42,
      updateId: 7,
      receivedAt,
      audit,
    });

    begin({
      chatId: 1,
      bot: fakeBot(),
      replyTo: 42,
      audit,
      outboundPolicy: {
        sourceClassification: "immediate",
        sourceReason: "immediate.human-message",
        exemption: telegramConversationReplyExemption(1),
      },
    });
    pushDelta("hello from the gateway");
    expect(await finish("hello from the gateway")).toBe(true);

    expect(journalRows.map((row) => row.event_type)).toEqual([
      "message.received",
      "outbound.requested",
      "delivery.confirmed",
      "delivery.confirmed",
    ]);
    expect(journalRows.every((row) => row.flow_id === "telegram-inbound:1:42")).toBe(true);
    expect(journalRows.at(-1)).toMatchObject({
      telegram_message_id: 101,
      revision: 2,
      delivery_state: "confirmed",
      reason: "deliver.exempt.joel-initiated-conversation-reply",
    });
    expect(JSON.parse(journalRows.at(-1)?.metadata_json ?? "{}")).toMatchObject({
      sourceClassification: "immediate",
      sourceReason: "immediate.human-message",
    });
  });

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
      outboundPolicy: { exemption: telegramConversationReplyExemption(1) },
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

  test("classifies governed streams from the final response before sending", async () => {
    let sendAttempts = 0;
    let chatActions = 0;
    begin({
      chatId: 1,
      bot: fakeBot({
        onSendAttempt: () => { sendAttempts += 1; },
        onChatAction: () => { chatActions += 1; },
      }),
      audit: {
        flowId: "recovery-flow",
        producer: "recovery-worker",
      },
      outboundPolicy: {
        sourceEventType: "service.recovered",
        priority: "urgent",
      },
    });
    pushDelta("starting recovery");

    expect(chatActions).toBe(0);
    expect(sendAttempts).toBe(0);
    expect(await finish("verified health confirmed after recovery")).toBe(true);
    expect(sendAttempts).toBe(1);
  });

  test("records unknown initial delivery without retrying ambiguous network errors", async () => {
    let sendAttempts = 0;
    begin({
      chatId: 1,
      bot: fakeBot({
        initialSendError: Object.assign(new Error("socket closed after write"), {
          name: "FetchError",
          code: "ECONNRESET",
        }),
        onSendAttempt: () => { sendAttempts += 1; },
      }),
      replyTo: 42,
      audit: {
        flowId: "telegram-inbound:1:42",
        producer: "telegram-user",
      },
      outboundPolicy: { exemption: telegramConversationReplyExemption(1) },
    });
    pushDelta("private response body");

    expect(await finish("private response body")).toBe(true);
    expect(sendAttempts).toBe(1);
    expect(otelPayloads.find(payload => payload.action === "telegram.delivery.unknown"))
      .toMatchObject({ success: false, error: "FetchError:ECONNRESET" });
  });

  test("journals a failed overflow chunk before partial finalization", async () => {
    const overflowError = Object.assign(new Error("overflow failed"), {
      name: "FetchError",
      code: "ECONNRESET",
    });
    const finalText = `${"x".repeat(3_000)}\n\n${"y".repeat(3_000)}`;
    begin({
      chatId: 1,
      bot: fakeBot({ overflowSendError: overflowError }),
      replyTo: 42,
      audit: {
        flowId: "telegram-inbound:1:42",
        producer: "telegram-user",
      },
      outboundPolicy: { exemption: telegramConversationReplyExemption(1) },
    });
    pushDelta(finalText);

    expect(await finish(finalText)).toBe(true);

    expect(journalRows.find((row) => row.event_type === "delivery.failed")).toMatchObject({
      chunk_index: 1,
      revision: 2,
      delivery_state: "failed",
      error_code: "FetchError:ECONNRESET",
    });
    expect(journalRows.at(-1)?.event_type).toBe("delivery.partial");
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
      outboundPolicy: { exemption: telegramConversationReplyExemption(1) },
    });
    pushDelta("private response body");

    expect(await finish("private response body")).toBe(true);

    const partial = otelPayloads.find(
      payload => payload.action === "telegram.delivery.partial",
    );
    expect(partial).toMatchObject({
      success: false,
      error: "GrammyError:400",
    });
    expect(partial?.metadata).toMatchObject({
      flowId: "telegram-inbound:1:42",
      telegramMessageIds: [101],
    });
    expect(JSON.stringify(partial?.metadata)).not.toContain("SECRET");
    expect(JSON.stringify(partial?.metadata)).not.toContain("private response body");
  });
});
