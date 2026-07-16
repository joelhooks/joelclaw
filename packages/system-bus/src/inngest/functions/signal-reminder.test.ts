import { describe, expect, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import {
  createSignalReminderFunction,
  inspectBrainSource,
  parseSignalReminderActionRecord,
  parseSignalReminderScheduledData,
  type SignalReminderDependencies,
  type SignalReminderOutcome,
} from "./signal-reminder";

const actionId = "act:00000000-0000-4000-8000-000000000001";
const remindAt = "2020-07-16T15:00:00.000Z";

function reminderEvent() {
  return {
    name: "signal/reminder.scheduled",
    data: {
      actionId,
      remindAt,
      delivery: {
        text: "Check the source again",
        channel: "telegram",
        inline_keyboard: [[{ text: "Open source", callback_data: "act:open" }]],
      },
    },
  } as any;
}

async function executeReminder(state: "open" | "resolved") {
  const outcomes: SignalReminderOutcome[] = [];
  const inspections: string[] = [];
  const sleepUntilCalls: unknown[][] = [];
  const sendEventCalls: unknown[][] = [];
  const dependencies: SignalReminderDependencies = {
    loadAction: async (requestedActionId) => ({
      actionId: requestedActionId,
      sourceRef: { kind: "fixture", id: "fixture:item" },
    }),
    inspectSource: async (ref) => {
      inspections.push(`${ref.kind}:${ref.id}`);
      return {
        ref,
        state,
        title: "Fixture item",
        revision: state === "resolved" ? "rev-resolved" : "rev-open",
      };
    },
    journalOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
  };

  const engine = new InngestTestEngine({
    function: createSignalReminderFunction(dependencies) as any,
    events: [reminderEvent()],
    transformCtx: (ctx: any) => {
      ctx.step.sleepUntil = async (...args: unknown[]) => {
        sleepUntilCalls.push(args);
      };
      ctx.step.sendEvent = async (...args: unknown[]) => {
        sendEventCalls.push(args);
        return { ids: ["mock-event-id"] };
      };
      ctx.step.sendEvent.mock = { calls: sendEventCalls };
      return ctx;
    },
  });

  const execution = await engine.execute();
  return { execution, inspections, outcomes, sleepUntilCalls, sendEventCalls };
}

describe("signal reminder", () => {
  test("suppresses a reminder resolved at the source before the timer fires", async () => {
    const { execution, inspections, outcomes, sleepUntilCalls, sendEventCalls } =
      await executeReminder("resolved");

    expect(execution.result).toMatchObject({
      actionId,
      outcome: "suppressed-resolved",
      sourceRevision: "rev-resolved",
    });
    expect(sleepUntilCalls.length).toBeGreaterThan(0);
    expect(
      sleepUntilCalls.every(
        (call) =>
          call[0] === "sleep-until-reminder-due" &&
          (call[1] as Date).toISOString() === remindAt,
      ),
    ).toBe(true);
    expect(inspections).toEqual(["fixture:fixture:item"]);
    expect(sendEventCalls).toHaveLength(0);
    expect(outcomes).toEqual([
      expect.objectContaining({ actionId, outcome: "suppressed-resolved" }),
    ]);
  });

  test("re-delivers an unresolved reminder and journals the receipt", async () => {
    const { execution, outcomes, sendEventCalls } = await executeReminder("open");

    expect(execution.result).toMatchObject({
      actionId,
      outcome: "redelivered",
      sourceRevision: "rev-open",
    });
    const redelivery = sendEventCalls.find((call) => call[0] === "redeliver-reminder");
    expect(redelivery?.[1]).toMatchObject({
      name: "gateway/send.message",
      data: {
        channel: "telegram",
        text: "Check the source again",
        audit: {
          flowId: `signal-reminder:${actionId}`,
          producer: "signal/reminder",
        },
      },
    });
    expect((redelivery?.[1] as any)?.data.inline_keyboard).toBeUndefined();
    expect(outcomes).toEqual([expect.objectContaining({ actionId, outcome: "redelivered" })]);
  });

  test("keeps curated Brain memories open without a network call", () => {
    const openUrl = "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system";

    expect(inspectBrainSource({
      kind: "brain",
      id: "telegram-signal-system",
      revision: openUrl,
    })).toEqual({
      ref: {
        kind: "brain",
        id: "telegram-signal-system",
        revision: openUrl,
      },
      state: "open",
      title: "Telegram Signal System",
      revision: openUrl,
      openUrl,
    });
  });

  test("reads the canonical source-actions registry wire record", () => {
    const record = parseSignalReminderActionRecord(
      JSON.stringify({
        actionId,
        sourceRef: { kind: "front", id: "cnv_123", revision: "rev-1" },
        allowedOperations: ["snooze", "open-url"],
        state: "applied",
        createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:01:00.000Z",
        receipt: {
          outcome: "applied",
          sourceId: "cnv_123",
          detail: "snoozed locally",
        },
      }),
      actionId,
    );

    expect(record).toEqual({
      actionId,
      sourceRef: { kind: "front", id: "cnv_123", revision: "rev-1" },
    });
  });

  test("registers action-scoped idempotency and cancellation", () => {
    const fn = createSignalReminderFunction({
      loadAction: async () => {
        throw new Error("not called");
      },
      inspectSource: async () => {
        throw new Error("not called");
      },
      journalOutcome: async () => undefined,
    });
    const opts = (fn as any).opts;

    expect(opts.idempotency).toBe("event.data.actionId");
    expect(opts.cancelOn).toEqual([
      { event: "signal/reminder.cancelled", match: "data.actionId" },
    ]);
  });

  test("rejects malformed schedules before sleeping", () => {
    expect(() =>
      parseSignalReminderScheduledData({
        actionId: "not-opaque",
        remindAt: "never",
        delivery: { text: "Reminder" },
      }),
    ).toThrow("act: prefix");
  });
});
