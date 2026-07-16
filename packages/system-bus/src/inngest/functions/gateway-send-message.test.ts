import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import { __gatewaySendMessageTestUtils } from "./gateway-send-message";

afterEach(() => {
  __gatewaySendMessageTestUtils.clear();
});

describe("gateway/send.message journal anchor", () => {
  test("records delivery.queued before Redis handoff", async () => {
    const rows: JournalEvent[] = [];
    __gatewaySendMessageTestUtils.setWriteOverride(async (row) => {
      rows.push(row);
    });

    await __gatewaySendMessageTestUtils.journalQueuedMessage({
      messageKey: "gateway-queue:flow-1",
      flowId: "flow-1",
      direction: "outbound",
      eventType: "delivery.queued",
      producer: "fixture",
      originSystemId: "test",
      sourceEventId: "event-1",
      sourceRef: "gateway/send.message",
      route: "redis-outbound",
      reason: "queued.gateway-send-message",
      telegramChatId: 42,
      revision: __gatewaySendMessageTestUtils.journalRevision("event-1"),
      text: "private queued body",
      deliveryState: "queued",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "delivery.queued",
      flow_id: "flow-1",
      text: "private queued body",
      delivery_state: "queued",
    });
  });

  test("derives a stable distinct revision from each source event", () => {
    const first = __gatewaySendMessageTestUtils.journalRevision("event-1");
    expect(first).toBe(__gatewaySendMessageTestUtils.journalRevision("event-1"));
    expect(first).not.toBe(__gatewaySendMessageTestUtils.journalRevision("event-2"));
  });
});
