import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import type { Bot } from "grammy";
import { __messageJournalTestUtils } from "../message-journal";
import { telegramConversationReplyExemption } from "../telegram-outbound-policy";
import { __telegramTestUtils } from "./telegram";

const { isDefinitiveTelegramRejection } = __telegramTestUtils;

afterEach(() => {
  __telegramTestUtils.setBotForTest(undefined);
  __messageJournalTestUtils.clear();
});

describe("Telegram retry safety", () => {
  test("retries only after a definitive Bot API rejection", () => {
    expect(isDefinitiveTelegramRejection({ error_code: 400 })).toBe(true);
    expect(isDefinitiveTelegramRejection({ error_code: "400" })).toBe(true);
  });

  test("does not retry ambiguous transport or rate-limit failures", () => {
    expect(isDefinitiveTelegramRejection({ name: "FetchError", code: "ECONNRESET" })).toBe(false);
    expect(isDefinitiveTelegramRejection({ error_code: 429 })).toBe(false);
    expect(isDefinitiveTelegramRejection(new Error("socket closed"))).toBe(false);
  });

  test("journals requested and failed rows for a normal outbound failure", async () => {
    const rows: JournalEvent[] = [];
    __messageJournalTestUtils.setWriteOverride(async (row) => {
      rows.push(row);
    });
    __messageJournalTestUtils.setFlowPersistenceOverride({
      set: async () => {},
      get: async () => undefined,
    });
    __telegramTestUtils.setBotForTest({
      api: {
        sendChatAction: async () => true,
        sendMessage: async () => {
          throw Object.assign(new Error("send failed"), {
            name: "FetchError",
            code: "ECONNRESET",
          });
        },
      },
    } as unknown as Bot);

    await expect(__telegramTestUtils.sendTelegramMessage(
      42,
      { text: "private outbound body", format: "plain" },
      {
        audit: {
          flowId: "normal-failure",
          producer: "fixture",
          originSystemId: "test",
        },
        outboundPolicy: {
          exemption: telegramConversationReplyExemption(42),
        },
      },
    )).rejects.toThrow("send failed");

    expect(rows.map((row) => row.event_type)).toEqual([
      "outbound.requested",
      "delivery.failed",
    ]);
    expect(rows.at(-1)).toMatchObject({
      flow_id: "normal-failure",
      delivery_state: "failed",
      error_code: "FetchError:ECONNRESET",
    });
  });
});
