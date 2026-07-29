import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import type { MessageEventDocument } from "@joelclaw/message-event-log";
import { validatePaneSchedule } from "../../lib/pane-schedule";
import {
  appendExternalCanaryReceipt,
  buildExternalDeliveryCanaryReceipt,
  buildOperatorActionSchedule,
  createGatewayExternalDeliveryCanary,
  EXTERNAL_DELIVERY_CANARY_ALERT_BRIEF,
  EXTERNAL_DELIVERY_CANARY_SLO_MS,
  type ExternalCanaryDependencies,
  type ExternalDeliveryCanaryReceipt,
  evaluateImmediateCanaryPath,
  evaluateQuietAggregateCanaryPath,
  inspectExternalCanaryStreamHealth,
  resolveExternalCanaryMode,
  shouldRunExternalCanary,
} from "./gateway-external-delivery-canary";

const temporaryDirectories: string[] = [];
const STARTED_AT = Date.parse("2026-07-29T20:00:00.000Z");
const DEADLINE_AT = STARTED_AT + EXTERNAL_DELIVERY_CANARY_SLO_MS;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function messageEvent(
  id: string,
  kind: MessageEventDocument["kind"],
  overrides: Partial<MessageEventDocument> = {},
): MessageEventDocument {
  return {
    _id: id,
    _creationTime: STARTED_AT,
    schemaVersion: 1,
    sequence: 1,
    semanticKey: `fixture:${id}`,
    kind,
    source: "fixture",
    payload: {},
    occurredAt: STARTED_AT,
    recordedAt: STARTED_AT,
    ...overrides,
  };
}

describe("gateway external delivery canary terminal matching", () => {
  test("stays inert unless the scheduled or approved manual gate is explicit", () => {
    expect(resolveExternalCanaryMode(undefined)).toBe("off");
    expect(
      shouldRunExternalCanary({
        mode: "off",
        eventName: "inngest/scheduled.timer",
      }),
    ).toEqual({
      run: false,
      reason: "GATEWAY_EXTERNAL_CANARY_MODE=off",
    });
    expect(
      shouldRunExternalCanary({
        mode: "manual",
        eventName: "gateway/external-canary.requested",
      }).run,
    ).toBe(false);
    expect(
      shouldRunExternalCanary({
        mode: "manual",
        eventName: "gateway/external-canary.requested",
        liveApproved: true,
      }).run,
    ).toBe(true);
  });

  test("detects an SLO timeout without accepting a non-terminal decision", () => {
    const result = evaluateImmediateCanaryPath({
      events: [
        messageEvent("decision-drop", "gateway.decision.recorded", {
          payload: {
            inputEventIds: ["input-immediate"],
            decision: { verb: "drop" },
          },
        }),
      ],
      flowId: "canary:run-1:immediate",
      inputEventId: "input-immediate",
      requestedAt: STARTED_AT,
      observedAt: DEADLINE_AT + 1,
      deadlineAt: DEADLINE_AT,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("gateway decision drop");

    const timeout = evaluateImmediateCanaryPath({
      events: [],
      flowId: "canary:run-1:immediate",
      inputEventId: "input-immediate",
      requestedAt: STARTED_AT,
      observedAt: DEADLINE_AT,
      deadlineAt: DEADLINE_AT,
    });
    expect(timeout.status).toBe("failed");
    expect(timeout.failure).toContain("delivery SLO");
  });

  test("matches one immediate confirmation and one deadline-closed digest", () => {
    const immediate = evaluateImmediateCanaryPath({
      events: [
        messageEvent("confirmed-immediate", "delivery.confirmed", {
          flowId: "canary:run-1:immediate",
          occurredAt: STARTED_AT + 4_000,
        }),
      ],
      flowId: "canary:run-1:immediate",
      inputEventId: "input-immediate",
      requestedAt: STARTED_AT,
      observedAt: STARTED_AT + 5_000,
      deadlineAt: DEADLINE_AT,
    });
    expect(immediate).toMatchObject({
      status: "passed",
      terminalState: "confirmed",
      terminalEventId: "confirmed-immediate",
      latencyMs: 4_000,
    });

    const holdUntil = STARTED_AT + 60_000;
    const quietEvents = [
      messageEvent("open", "gateway.decision.recorded", {
        sequence: 1,
        flowId: "canary:run-1:quiet-aggregate",
        payload: {
          inputEventIds: ["input-quiet"],
          decision: {
            verb: "aggregate",
            action: "open",
            aggregateId: "canary-aggregate-1",
            memberEventIds: ["input-quiet"],
            holdUntil,
          },
        },
      }),
      messageEvent("deadline", "aggregate.deadline.reached", {
        sequence: 2,
        occurredAt: holdUntil,
        payload: {
          aggregateId: "canary-aggregate-1",
          memberEventIds: ["input-quiet"],
          holdUntil,
        },
      }),
      messageEvent("close", "gateway.decision.recorded", {
        sequence: 3,
        occurredAt: holdUntil + 1_000,
        payload: {
          inputEventIds: ["deadline"],
          decision: {
            verb: "aggregate",
            action: "close-deliver",
            aggregateId: "canary-aggregate-1",
            memberEventIds: ["input-quiet", "deadline"],
          },
        },
      }),
      messageEvent("confirmed-digest", "delivery.confirmed", {
        sequence: 4,
        flowId: "decision:close",
        occurredAt: holdUntil + 2_000,
      }),
    ];
    const quiet = evaluateQuietAggregateCanaryPath({
      events: quietEvents,
      flowId: "canary:run-1:quiet-aggregate",
      inputEventId: "input-quiet",
      requestedAt: STARTED_AT,
      observedAt: holdUntil + 3_000,
      deadlineAt: DEADLINE_AT,
    });
    expect(quiet).toMatchObject({
      status: "passed",
      terminalState: "digested",
      terminalEventId: "close",
      deliveryConfirmationEventId: "confirmed-digest",
      aggregateId: "canary-aggregate-1",
      openDecisionEventId: "open",
      aggregateDeadlineEventId: "deadline",
      closeDecisionEventId: "close",
      digestCount: 1,
    });

    const earlyConfirmation = evaluateQuietAggregateCanaryPath({
      events: [
        quietEvents[0]!,
        messageEvent("confirmed-too-soon", "delivery.confirmed", {
          sequence: 2,
          flowId: "canary:run-1:quiet-aggregate",
          occurredAt: STARTED_AT + 1_000,
        }),
        { ...quietEvents[1]!, sequence: 3 },
        {
          ...quietEvents[2]!,
          sequence: 4,
          flowId: "canary:run-1:quiet-aggregate",
        },
      ],
      flowId: "canary:run-1:quiet-aggregate",
      inputEventId: "input-quiet",
      requestedAt: STARTED_AT,
      observedAt: holdUntil + 3_000,
      deadlineAt: DEADLINE_AT,
    });
    expect(earlyConfirmation).toMatchObject({
      status: "failed",
      failure: "quiet path confirmed delivery before the aggregate closed",
    });
  });
});

describe("gateway external delivery canary receipt", () => {
  test("writes one mode-0600 JSONL receipt with both path and stream checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-canary-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "canary.jsonl");
    const immediate = evaluateImmediateCanaryPath({
      events: [
        messageEvent("confirmed-immediate", "delivery.confirmed", {
          flowId: "canary:run-1:immediate",
        }),
      ],
      flowId: "canary:run-1:immediate",
      inputEventId: "input-immediate",
      requestedAt: STARTED_AT,
      observedAt: STARTED_AT + 1,
      deadlineAt: DEADLINE_AT,
    });
    const quietAggregate = {
      path: "quiet-aggregate" as const,
      status: "passed" as const,
      flowId: "canary:run-1:quiet-aggregate",
      inputEventId: "input-quiet",
      requestedAt: STARTED_AT,
      observedAt: STARTED_AT + 2,
      deadlineAt: DEADLINE_AT,
      terminalState: "digested" as const,
      terminalEventId: "confirmed-digest",
      aggregateId: "aggregate-1",
      digestCount: 1,
    };
    const streamHealth = inspectExternalCanaryStreamHealth({
      events: [],
      pending: [],
      now: STARTED_AT + 2,
    });
    const receipt = buildExternalDeliveryCanaryReceipt({
      runId: "run-1",
      startedAt: STARTED_AT,
      completedAt: STARTED_AT + 2,
      receiptPath,
      immediate,
      quietAggregate,
      streamHealth,
    });

    await appendExternalCanaryReceipt(receipt, receiptPath);
    const stored = JSON.parse((await readFile(receiptPath, "utf8")).trim());
    const mode = (await stat(receiptPath)).mode & 0o777;

    expect(mode).toBe(0o600);
    expect(stored).toEqual(receipt);
    expect(stored).toMatchObject({
      schemaVersion: 1,
      kind: "gateway-external-delivery-canary",
      runId: "run-1",
      status: "passed",
      paths: {
        immediate: { status: "passed" },
        quietAggregate: { status: "passed", digestCount: 1 },
      },
      streamHealth: {
        pendingExternalCount: 0,
        openAggregateCount: 0,
      },
      operatorAction: {
        requested: false,
        channel: "observer-telemetry-watch",
      },
    });
  });

  test("a failed receipt requests the independent mechanical spawn alarm", () => {
    const failedPath = {
      path: "immediate" as const,
      status: "failed" as const,
      flowId: "canary:run-2:immediate",
      requestedAt: STARTED_AT,
      observedAt: DEADLINE_AT,
      deadlineAt: DEADLINE_AT,
      failure: "forced timeout",
    };
    const receipt = buildExternalDeliveryCanaryReceipt({
      runId: "run-2",
      startedAt: STARTED_AT,
      completedAt: DEADLINE_AT,
      immediate: failedPath,
      quietAggregate: {
        ...failedPath,
        path: "quiet-aggregate",
        flowId: "canary:run-2:quiet-aggregate",
      },
      streamHealth: inspectExternalCanaryStreamHealth({
        events: [],
        pending: [],
        now: DEADLINE_AT,
      }),
    });
    const schedule = buildOperatorActionSchedule({
      runId: receipt.runId,
      completedAt: receipt.completedAt,
      receiptPath: receipt.receiptPath,
    });

    expect(receipt.status).toBe("failed");
    expect(receipt.operatorAction).toMatchObject({
      requested: true,
      channel: "observer-telemetry-watch",
      schedule: {
        event: "pane/schedule.requested",
        verb: "spawn",
        scheduleId: "gateway-external-canary-alert-run-2",
        briefPath: EXTERNAL_DELIVERY_CANARY_ALERT_BRIEF,
      },
    });
    expect(validatePaneSchedule(schedule)).toMatchObject({
      verb: "spawn",
      requestedBy: "gateway-external-canary",
    });
  });

  test("a forced handler failure fires the independent pane schedule", async () => {
    const appendedFlows: string[] = [];
    const receipts: ExternalDeliveryCanaryReceipt[] = [];
    const emitted: ExternalDeliveryCanaryReceipt[] = [];
    const sendEventCalls: unknown[][] = [];
    const dependencies: ExternalCanaryDependencies = {
      append: async (input) => {
        appendedFlows.push(input.flowId ?? "");
        const eventId =
          input.flowId?.endsWith(":quiet-aggregate") === true
            ? "input-quiet-aggregate"
            : "input-immediate";
        return {
          eventId,
          semanticKey: input.semanticKey,
          deduplicated: false,
          schemaVersion: 1,
        };
      },
      readEvents: async () => [
        messageEvent("drop-immediate", "gateway.decision.recorded", {
          sequence: 10,
          payload: {
            inputEventIds: ["input-immediate"],
            decision: { verb: "drop" },
          },
        }),
        ...(appendedFlows.length < 2
          ? []
          : [
              messageEvent("deliver-quiet", "gateway.decision.recorded", {
                sequence: 11,
                payload: {
                  inputEventIds: ["input-quiet-aggregate"],
                  decision: { verb: "deliver" },
                },
              }),
            ]),
      ],
      pendingExternalInputs: async () => [],
      writeReceipt: async (receipt) => {
        receipts.push(receipt);
        return receipt.receiptPath;
      },
      emitReceipt: async (receipt) => {
        emitted.push(receipt);
      },
      now: () => STARTED_AT,
      newRunId: () => "forced-handler-failure",
      machineId: () => "fixture-machine",
      mode: () => "manual",
    };
    const engine = new InngestTestEngine({
      function: createGatewayExternalDeliveryCanary(dependencies) as any,
      events: [
        {
          name: "gateway/external-canary.requested",
          data: { liveApproved: true, reason: "forced failure test" },
        },
      ],
      transformCtx: (rawCtx: any) => {
        const ctx = mockCtx(rawCtx);
        ctx.step.sendEvent = async (...args: unknown[]) => {
          sendEventCalls.push(args);
          return { ids: ["fixture-pane-schedule"] };
        };
        (ctx.step.sendEvent as any).mock = { calls: sendEventCalls };
        return ctx;
      },
    });

    const execution = await engine.execute();

    expect(execution.result).toMatchObject({
      runId: "forced-handler-failure",
      status: "failed",
      operatorAction: { requested: true },
    });
    expect(appendedFlows).toEqual([
      "canary:forced-handler-failure:immediate",
      "canary:forced-handler-failure:quiet-aggregate",
    ]);
    expect(receipts).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(sendEventCalls.length).toBeGreaterThan(0);
    expect(sendEventCalls[0]?.[1]).toMatchObject({
      name: "pane/schedule.requested",
      data: {
        verb: "spawn",
        scheduleId: "gateway-external-canary-alert-forced-handler-failure",
      },
    });
    expect(
      new Set(
        sendEventCalls.map(
          (call) => (call[1] as { data?: { scheduleId?: string } })?.data?.scheduleId,
        ),
      ),
    ).toEqual(new Set(["gateway-external-canary-alert-forced-handler-failure"]));
  });
});
