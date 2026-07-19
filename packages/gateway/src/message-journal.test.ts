import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import {
  __messageJournalTestUtils,
  journalMessage,
  journalMessageActionRequest,
  rememberTelegramMessageFlow,
  resolveTelegramMessageFlow,
} from "./message-journal";

afterEach(() => {
  __messageJournalTestUtils.clear();
});

describe("gateway message journal fail-open boundary", () => {
  test("never blocks delivery when writer and outbox both fail", async () => {
    __messageJournalTestUtils.setWriteOverride(async () => {
      throw new Error("writer unavailable");
    });
    __messageJournalTestUtils.setOutboxOverride(async () => {
      throw new Error("outbox unavailable");
    });

    await expect(journalMessage({
      messageKey: "telegram:42:1",
      flowId: "flow-fail-open",
      direction: "outbound",
      eventType: "delivery.confirmed",
      producer: "fixture",
      originSystemId: "test",
      telegramChatId: 42,
      telegramMessageId: 1,
      text: "private body",
      transportText: "private body",
      deliveryState: "confirmed",
    })).resolves.toMatchObject({
      persisted: false,
      storage: "failed",
    });
  });

  test("restores callback flow lineage after the memory index is cleared", async () => {
    const persisted = new Map<string, string>();
    __messageJournalTestUtils.setFlowPersistenceOverride({
      set: async (key, flowId) => {
        persisted.set(key, flowId);
      },
      get: async (key) => persisted.get(key),
    });

    await rememberTelegramMessageFlow(42, 99, "flow-99");
    __messageJournalTestUtils.clearMemoryFlowIndex();

    expect(await resolveTelegramMessageFlow(42, 99)).toBe("flow-99");
    expect(await resolveTelegramMessageFlow(7, 99)).toBeUndefined();
  });

  test("swallows journal event construction failures", async () => {
    let writes = 0;
    __messageJournalTestUtils.setWriteOverride(async () => {
      writes += 1;
    });

    await expect(journalMessage({
      messageKey: "invalid",
      flowId: "flow-invalid",
      direction: "outbound",
      eventType: "delivery.confirmed",
      producer: "fixture",
      originSystemId: "test",
      telegramChatId: Number.NaN,
      text: "private body",
    })).resolves.toMatchObject({
      journalEventId: "construction-failed",
      persisted: false,
      storage: "failed",
    });
    expect(writes).toBe(0);
  });

  test("journals a callback request with the callback query id and stable action", async () => {
    const rows: JournalEvent[] = [];
    __messageJournalTestUtils.setWriteOverride(async (row) => {
      rows.push(row);
    });

    await journalMessageActionRequest({
      flowId: "flow_v2_11111111-1111-4111-8111-111111111111",
      correlationId: "campaign-pulse:event-1",
      actionId: "learner-flow.run",
      rawEventId: "callback-query-1",
      platformMessageId: "7718912466:14562",
      conversationId: "7718912466",
      actorId: "7718912466",
      occurredAt: "2026-07-19T15:00:00.000Z",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "interaction",
      event_type: "message.action.requested",
      callback_query_id: "callback-query-1",
      interaction_action: "learner-flow.run",
      interaction_outcome: "requested",
      telegram_chat_id: 7718912466,
      telegram_message_id: 14562,
    });
  });

  test("passes the complete row to the configured writer", async () => {
    const rows: JournalEvent[] = [];
    __messageJournalTestUtils.setWriteOverride(async (row) => {
      rows.push(row);
    });

    await journalMessage({
      messageKey: "telegram:42:2",
      flowId: "flow-complete",
      direction: "outbound",
      eventType: "delivery.suppressed",
      producer: "fixture",
      originSystemId: "test",
      classification: "infra",
      reason: "suppress.routine-machine-noise",
      telegramChatId: 42,
      text: "exact fixture",
      deliveryState: "suppressed",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flow_id: "flow-complete",
      event_type: "delivery.suppressed",
      classification: "infra",
      reason: "suppress.routine-machine-noise",
      text: "exact fixture",
      delivery_state: "suppressed",
    });
  });
});
