import { describe, expect, test } from "bun:test";
import {
  runJson,
  verifyJournalRow,
} from "../../../../../scripts/messaging-visible-delivery-canary";

const cutoverConfirmedRow = {
  journal_event_id:
    "25eff36286779c049c3b6b38c06996d114573843f5a1ba64b49d301d48c1ce54",
  flow_id: "flow_v2_19d41a3f-97df-4507-8940-ac90ebe9b0ca",
  event_type: "message.outbound.confirmed",
  producer: "chat-sdk-outbound-v1",
  origin_system_id: "fbb72620-2af7-467a-ad3d-2d8f8df81aa7",
  delivery_state: "confirmed",
  telegram_chat_id: 7_718_912_466,
  telegram_message_id: 14_545,
  metadata_json:
    '{"contractVersion":2,"platform":"telegram","platformMessageId":"7718912466:14545","threadId":"telegram:7718912466"}',
};

const hotDogHistoricalRow = {
  journal_event_id:
    "71d3e7361221a27ceacac4fa6f898cf3b5098158517df2fc1afb011944da07f1",
  flow_id: "flow_v2_b8fd1334-d486-4c48-b9c6-ba064afee7ad",
  event_type: "message.outbound.digest",
  producer: "chat-sdk-outbound-v1",
  origin_system_id: "2e5537da-17a1-4b49-ae31-1fb2b9c1b1d0",
  delivery_state: "suppressed",
  telegram_chat_id: 0,
  telegram_message_id: null,
  metadata_json:
    '{"contractVersion":2,"platform":"telegram","platformMessageId":null,"threadId":null}',
};

describe("visible-delivery canary journal gate", () => {
  test("kills a hung subprocess instead of hanging the flip", async () => {
    await expect(
      runJson(
        ["bun", "-e", "await Bun.sleep(500); console.log('{}')"],
        20,
      ),
    ).rejects.toThrow("timed out after 20ms");
  });

  test("accepts the real cutover row only when journal and platform ids match", () => {
    expect(
      verifyJournalRow(
        cutoverConfirmedRow,
        "fbb72620-2af7-467a-ad3d-2d8f8df81aa7",
        "outbox",
      ),
    ).toEqual({
      eventId: "fbb72620-2af7-467a-ad3d-2d8f8df81aa7",
      flowId: "flow_v2_19d41a3f-97df-4507-8940-ac90ebe9b0ca",
      platformMessageId: "7718912466:14545",
      telegramChatId: 7_718_912_466,
      telegramMessageId: 14_545,
      journalEventId:
        "25eff36286779c049c3b6b38c06996d114573843f5a1ba64b49d301d48c1ce54",
      journalSource: "outbox",
    });

    expect(
      verifyJournalRow(
        {
          ...cutoverConfirmedRow,
          metadata_json:
            '{"platform":"telegram","platformMessageId":"7718912466:99999"}',
        },
        "fbb72620-2af7-467a-ad3d-2d8f8df81aa7",
        "outbox",
      ),
    ).toBeUndefined();
  });

  test("rejects the real hot-dog digest row as visible delivery", () => {
    expect(
      verifyJournalRow(
        hotDogHistoricalRow,
        "2e5537da-17a1-4b49-ae31-1fb2b9c1b1d0",
        "outbox",
      ),
    ).toBeUndefined();
  });
});
