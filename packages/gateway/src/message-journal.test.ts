import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import {
  __messageJournalTestUtils,
  journalMessage,
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
    })).resolves.toBeUndefined();
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
    })).resolves.toBeUndefined();
    expect(writes).toBe(0);
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
