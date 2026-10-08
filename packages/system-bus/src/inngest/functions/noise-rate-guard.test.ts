import { describe, expect, spyOn, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import { createJournalEvent, type JournalEvent } from "@joelclaw/message-journal";
import { NonRetriableError } from "inngest";
import {
  buildNoiseRateDigestItem,
  computeNoiseRate,
  createMissingJournalConfigReporter,
  createNoiseRateGuardFunction,
  getMissingMessageJournalReaderVariables,
  enqueueNoiseRateDigestItemWithRedis,
  type NoiseRateDigestItem,
  type NoiseRateDigestRedis,
  type NoiseRateGuardDependencies,
  type NoiseRateGuardReport,
  TELEGRAM_SIGNAL_CONTENT_KINDS,
} from "./noise-rate-guard";

const FIVE_KINDS = [
  "memory",
  "action",
  "reminder",
  "escalation",
  "recovery-receipt",
] as const;

function delivery(
  id: number,
  classification: string,
  overrides: Partial<{
    flowId: string;
    reason: string;
    revision: number;
    attempt: number;
    producer: string;
    sourceRef: string;
    eventType: string;
  }> = {},
): JournalEvent {
  return createJournalEvent(
    {
      messageKey: `telegram:42:${id}`,
      flowId: overrides.flowId ?? `flow-${id}`,
      channel: "telegram",
      direction: "outbound",
      eventType: overrides.eventType ?? "delivery.confirmed",
      producer: overrides.producer ?? "fixture",
      originSystemId: "test",
      sourceRef: overrides.sourceRef,
      reason: overrides.reason,
      classification,
      telegramChatId: 42,
      telegramMessageId: id,
      revision: overrides.revision,
      attempt: overrides.attempt,
      text: `message ${id}`,
      deliveryState: "confirmed",
    },
    () => new Date("2026-07-16T12:00:00.000Z"),
  );
}

describe("Telegram noise-rate content contract", () => {
  test("pins the five allowed outbound signal kinds", () => {
    expect(TELEGRAM_SIGNAL_CONTENT_KINDS).toEqual(FIVE_KINDS);
    expect(new Set(TELEGRAM_SIGNAL_CONTENT_KINDS).size).toBe(5);
  });

  test.each([...FIVE_KINDS])("treats %s as contract-compliant", (kind) => {
    const report = computeNoiseRate([delivery(1, kind)]);
    expect(report).toMatchObject({
      denominator: 1,
      nonActionable: 0,
      nonActionableRate: 0,
      breached: false,
    });
  });
});

describe("Telegram noise-rate measurement", () => {
  test("excludes canaries and Joel-initiated replies from the denominator", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => delivery(index + 1, "action")),
      delivery(10, "noise"),
      delivery(11, "noise", { flowId: "canary:gateway-send:fixture" }),
      delivery(12, "action", {
        reason: "deliver.exempt.joel-initiated-conversation-reply",
      }),
    ];

    const report = computeNoiseRate(rows);

    expect(report).toMatchObject({
      denominator: 10,
      nonActionable: 1,
      nonActionableRate: 0.1,
      breached: true,
      excludedCanaries: 1,
      excludedConversationReplies: 1,
    });
  });

  test("deduplicates lifecycle revisions by physical Telegram message", () => {
    const report = computeNoiseRate([
      delivery(1, "noise", { revision: 1, attempt: 2 }),
      delivery(1, "action", { revision: 2, attempt: 1 }),
      delivery(2, "unclassified"),
      delivery(3, "noise", { eventType: "delivery.failed" }),
    ]);

    expect(report).toMatchObject({
      denominator: 2,
      nonActionable: 1,
      duplicateLifecycleRows: 1,
      classificationCounts: { action: 1, other: 1 },
    });
  });

  test("does not breach an empty window", () => {
    expect(computeNoiseRate([])).toMatchObject({
      denominator: 0,
      nonActionableRate: 0,
      breached: false,
    });
  });

  test("refuses to breach from a capped sample", () => {
    expect(
      computeNoiseRate([delivery(1, "noise"), delivery(2, "noise")], {
        queryLimit: 2,
      }),
    ).toMatchObject({
      denominator: 2,
      nonActionableRate: 1,
      queryLimitReached: true,
      measurementComplete: false,
      breached: false,
    });
  });

  test("collapses unknown classifications before persistence", () => {
    const report = computeNoiseRate([delivery(1, "private exact classification")]);
    expect(report.classificationCounts).toEqual({ other: 1 });
    expect(JSON.stringify(report)).not.toContain("private exact classification");
  });
});

describe("missing message-journal configuration", () => {
  test("reports required names without reading configured secrets", async () => {
    expect(await getMissingMessageJournalReaderVariables({}, {})).toEqual([
      "MESSAGE_JOURNAL_READER_USER",
      "MESSAGE_JOURNAL_READER_PASSWORD",
    ]);
  });

  test("returns a non-retriable failure and logs only missing variable names once per hour", () => {
    const logs: string[] = [];
    const reportMissing = createMissingJournalConfigReporter((message) => logs.push(message));
    const missing = ["MESSAGE_JOURNAL_READER_USER", "MESSAGE_JOURNAL_READER_PASSWORD"];

    const first = reportMissing(missing, 1_000);
    const withinHour = reportMissing(missing, 3_600_999);
    const nextHour = reportMissing(missing, 3_601_000);

    expect(first).toBeInstanceOf(NonRetriableError);
    expect(withinHour).toBeInstanceOf(NonRetriableError);
    expect(nextHour).toBeInstanceOf(NonRetriableError);
    const missingNames = [...missing].sort().join(", ");
    expect(first.message).toContain(missingNames);
    expect(first.message).not.toContain("fixture-secret");
    expect(logs).toHaveLength(2);
    expect(logs.every((message) => message.includes(missingNames))).toBe(true);
    expect(logs.join(" ")).not.toContain("fixture-secret");
  });
});

describe("Telegram noise-rate guard function", () => {
  test("skips missing message-journal configuration without retrying or logging values", async () => {
    const missing = [
      "MESSAGE_JOURNAL_READER_USER",
      "MESSAGE_JOURNAL_READER_PASSWORD",
    ];
    const logs: string[] = [];
    let measureCalls = 0;
    const warn = spyOn(console, "warn").mockImplementation((message) => {
      logs.push(String(message));
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const dependencies = {
      measureNoiseRate: async () => {
        measureCalls += 1;
        return computeNoiseRate([]);
      },
      enqueueDigestItem: async () => ({ queued: false }),
      emitReport: async () => undefined,
      now: () => new Date("2026-07-16T13:00:00.000Z"),
      missingJournalReaderVariables: async () => missing,
    } satisfies NoiseRateGuardDependencies & {
      missingJournalReaderVariables: () => Promise<ReadonlyArray<string>>;
    };
    const engine = new InngestTestEngine({
      function: createNoiseRateGuardFunction(dependencies) as any,
      events: [{ name: "cron", data: { cron: "23 * * * *" } } as any],
    });

    try {
      const execution = await engine.execute();
      const error = execution.error as { message?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : "";
      const missingNames = [...missing].sort().join(", ");

      expect(message).toContain(missingNames);
      expect(message).not.toContain("fixture-secret");
      expect(measureCalls).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(missingNames);
      expect(logs[0]).not.toContain("fixture-secret");
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
  test("queues a digest-owned agent investigation on breach", async () => {
    const queued: NoiseRateDigestItem[] = [];
    const emitted: NoiseRateGuardReport[] = [];
    const fixtureRows = [
      ...Array.from({ length: 8 }, (_, index) => delivery(index + 1, "action")),
      delivery(9, "noise"),
      delivery(10, "unclassified"),
    ];
    const dependencies: NoiseRateGuardDependencies = {
      measureNoiseRate: async () => computeNoiseRate(fixtureRows),
      enqueueDigestItem: async (item) => {
        queued.push(item);
        return { queued: true };
      },
      emitReport: async (report) => {
        emitted.push(report);
      },
      now: () => new Date("2026-07-16T13:00:00.000Z"),
    };
    const engine = new InngestTestEngine({
      function: createNoiseRateGuardFunction(dependencies) as any,
      events: [{ name: "cron", data: { cron: "23 * * * *" } } as any],
    });

    const execution = await engine.execute();

    expect(execution.result).toMatchObject({
      denominator: 10,
      nonActionable: 2,
      nonActionableRate: 0.2,
      breached: true,
      digestQueued: true,
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      owner: "agent",
      kind: "investigation",
      decision: {
        disposition: "digest",
        reason: "digest.agent-owned-noise-rate-investigation",
      },
      queuedAt: "2026-07-16T13:00:00.000Z",
    });
    expect(emitted).toHaveLength(1);
  });

  test("builds a body-free investigation receipt", () => {
    const report = computeNoiseRate([delivery(1, "noise")]);
    const item = buildNoiseRateDigestItem(
      report,
      new Date("2026-07-16T13:00:00.000Z"),
    );

    expect(item.candidate.content).toContain("1/1");
    expect(JSON.stringify(item)).not.toContain("message 1");
  });

  test("atomically queues once across retry attempts", async () => {
    const report = computeNoiseRate([delivery(1, "noise")]);
    const item = buildNoiseRateDigestItem(
      report,
      new Date("2026-07-16T13:00:00.000Z"),
    );
    const queued: string[] = [];
    let cooldownClaimed = false;
    const scripts: string[] = [];
    const redis: NoiseRateDigestRedis = {
      eval: async (script, keyCount, ...args) => {
        scripts.push(script);
        expect(keyCount).toBe(2);
        if (cooldownClaimed) return 0;
        queued.push(args[2] ?? "");
        cooldownClaimed = true;
        return 1;
      },
    };

    expect(await enqueueNoiseRateDigestItemWithRedis(redis, item)).toEqual({
      queued: true,
    });
    expect(await enqueueNoiseRateDigestItemWithRedis(redis, item)).toEqual({
      queued: false,
    });
    expect(scripts).toHaveLength(2);
    expect(queued).toEqual([JSON.stringify(item)]);
  });
});
