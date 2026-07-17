import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import type { Bot } from "grammy";
import { __messageJournalTestUtils } from "./message-journal";
import { telegramConversationReplyExemption } from "./telegram-outbound-policy";
import { __telegramTestUtils } from "./telegram-runtime";

const { isDefinitiveTelegramRejection } = __telegramTestUtils;

const CURATOR_DM = [
  "**The memory layer caught its own blind spot.** 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b)) - then decide!",
  "",
  "- keep the paragraphs",
  "- render the bullets",
  "- escape nasty punctuation: . ! - ( )",
].join("\n");

const CURATOR_NORMALIZED = CURATOR_DM.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

const CURATOR_MARKDOWN_V2 = [
  "*The memory layer caught its own blind spot\\.* 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b\\)) \\- then decide\\!",
  "",
  "• keep the paragraphs",
  "• render the bullets",
  "• escape nasty punctuation: \\. \\! \\- \\( \\)",
].join("\n");

const CURATOR_PLAIN = [
  "The memory layer caught its own blind spot. 🧠",
  "",
  "A smol move: read the receipt - then decide!",
  "",
  "• keep the paragraphs",
  "• render the bullets",
  "• escape nasty punctuation: . ! - ( )",
].join("\n");

function captureJournal(rows: JournalEvent[]): void {
  __messageJournalTestUtils.setWriteOverride(async (row) => {
    rows.push(row);
  });
  __messageJournalTestUtils.setFlowPersistenceOverride({
    set: async () => {},
    get: async () => undefined,
  });
}

afterEach(() => {
  __telegramTestUtils.setBotForTest(undefined);
  __messageJournalTestUtils.clear();
});

describe("Telegram retry safety", () => {
  test("renders a curator-shaped DM as MarkdownV2 with Telegram-safe escaping", async () => {
    const rows: JournalEvent[] = [];
    captureJournal(rows);
    const sends: Array<{ text: string; options: Record<string, unknown> }> = [];
    __telegramTestUtils.setBotForTest({
      api: {
        sendChatAction: async () => true,
        sendMessage: async (_chatId: number, text: string, options: Record<string, unknown>) => {
          sends.push({ text, options });
          return { message_id: 101 };
        },
      },
    } as unknown as Bot);

    const receipt = await __telegramTestUtils.sendTelegramMessage(
      42,
      CURATOR_DM,
      {
        audit: { flowId: "curator-markdown", producer: "fixture" },
        outboundPolicy: { exemption: telegramConversationReplyExemption(42) },
      },
    );

    expect(receipt).toMatchObject({ status: "confirmed", usedFallback: false });
    expect(sends).toEqual([{
      text: CURATOR_MARKDOWN_V2,
      options: { parse_mode: "MarkdownV2" },
    }]);
    expect(sends[0]?.text).toContain("\n\nA smol move");
    expect(sends[0]?.text).toContain("\n\n• keep the paragraphs");
    expect(rows.at(-1)).toMatchObject({
      delivery_state: "confirmed",
      transport_text: sends[0]?.text,
    });
  });

  test("preserves paragraphs and visible bullets for explicit plain sends", async () => {
    const rows: JournalEvent[] = [];
    captureJournal(rows);
    const sends: Array<{ text: string; options: Record<string, unknown> }> = [];
    __telegramTestUtils.setBotForTest({
      api: {
        sendChatAction: async () => true,
        sendMessage: async (_chatId: number, text: string, options: Record<string, unknown>) => {
          sends.push({ text, options });
          return { message_id: 103 };
        },
      },
    } as unknown as Bot);

    await __telegramTestUtils.sendTelegramMessage(
      42,
      { text: CURATOR_DM, format: "plain" },
      {
        audit: { flowId: "curator-plain", producer: "fixture" },
        outboundPolicy: { exemption: telegramConversationReplyExemption(42) },
      },
    );

    expect(sends).toEqual([{ text: CURATOR_NORMALIZED, options: {} }]);
    expect(sends[0]?.text).toContain("\n\n• keep the paragraphs");
  });

  test("falls back to plain text after a definitive MarkdownV2 400", async () => {
    const rows: JournalEvent[] = [];
    captureJournal(rows);
    const sends: Array<{ text: string; options: Record<string, unknown> }> = [];
    __telegramTestUtils.setBotForTest({
      api: {
        sendChatAction: async () => true,
        sendMessage: async (_chatId: number, text: string, options: Record<string, unknown>) => {
          sends.push({ text, options });
          if (sends.length === 1) {
            throw Object.assign(new Error("can't parse entities"), { error_code: 400 });
          }
          return { message_id: 102 };
        },
      },
    } as unknown as Bot);

    const receipt = await __telegramTestUtils.sendTelegramMessage(
      42,
      CURATOR_DM,
      {
        audit: { flowId: "curator-400-fallback", producer: "fixture" },
        outboundPolicy: { exemption: telegramConversationReplyExemption(42) },
      },
    );

    expect(receipt).toMatchObject({ status: "confirmed", usedFallback: true });
    expect(sends[0]).toMatchObject({ options: { parse_mode: "MarkdownV2" } });
    expect(sends[0]?.text).toContain("spot\\.");
    expect(sends[0]?.text).toContain("\\- then decide\\!");
    expect(sends[1]).toEqual({
      text: CURATOR_PLAIN,
      options: {},
    });
    expect(rows.at(-1)).toMatchObject({
      delivery_state: "confirmed",
      attempt: 2,
    });
    expect(JSON.parse(rows.at(-1)?.metadata_json ?? "{}")).toMatchObject({
      fallback: "plain_text",
    });
  });

  test("does not retry a formatted send after an ambiguous transport failure", async () => {
    const rows: JournalEvent[] = [];
    captureJournal(rows);
    let sends = 0;
    __telegramTestUtils.setBotForTest({
      api: {
        sendChatAction: async () => true,
        sendMessage: async () => {
          sends += 1;
          throw Object.assign(new Error("socket closed"), {
            name: "FetchError",
            code: "ECONNRESET",
          });
        },
      },
    } as unknown as Bot);

    await expect(__telegramTestUtils.sendTelegramMessage(
      42,
      CURATOR_DM,
      {
        audit: { flowId: "curator-ambiguous", producer: "fixture" },
        outboundPolicy: { exemption: telegramConversationReplyExemption(42) },
      },
    )).rejects.toThrow("socket closed");

    expect(sends).toBe(1);
    expect(rows.at(-1)).toMatchObject({
      delivery_state: "unknown",
      event_type: "delivery.unknown",
      error_code: "FetchError:ECONNRESET",
    });
  });

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
    captureJournal(rows);
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
