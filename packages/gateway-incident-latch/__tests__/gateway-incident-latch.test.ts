import { describe, expect, test } from "bun:test";
import type { GatewayIncidentObservation, MessageEventDocument } from "@joelclaw/message-event-log";
import {
  createGatewayIncidentStore,
  type GatewayIncidentStore,
  parseGatewayIncidentObservation,
  reconcileGatewayIncident,
  reconstructGatewayIncidentStore,
} from "../src";

const SOURCE = "campaign-pulse";
const ANOMALY = "welcome-email-backlog";
const BASE = "2026-07-27T16:00:00.000Z";

function observation(
  state: GatewayIncidentObservation["state"],
  observedAt: string,
  evidence: unknown = { failureMode: "backlog", stuck: 3 },
  anomalyId = ANOMALY,
  severity = "warning",
): GatewayIncidentObservation {
  return {
    source: SOURCE,
    anomalyId,
    state,
    severity,
    observedAt,
    evidence,
  };
}

function fold(events: MessageEventDocument[], item: GatewayIncidentObservation, index: number) {
  const store = reconstructGatewayIncidentStore(events);
  const result = reconcileGatewayIncident({
    store,
    observation: item,
    inputEventId: `input-${index}`,
  });
  const event = {
    _id: `decision-${index}`,
    kind: "gateway.decision.recorded",
    source: "joelclaw-gateway",
    semanticKey: `gateway:input-${index}:1`,
    payload: {
      inputEventIds: [`input-${index}`],
      reason: result.reason,
      promptRevision: "test",
      decisionSeq: 1,
      decision: result.decision,
      incident: result.receipt,
    },
    flowId: `flow-${index}`,
    sequence: index,
    recordedAt: Date.parse(item.observedAt),
    occurredAt: Date.parse(item.observedAt),
    schemaVersion: 1,
    _creationTime: Date.parse(item.observedAt),
  } as MessageEventDocument;
  events.push(event);
  return result;
}

describe("gateway incident producer contract", () => {
  test("reads the source from the event and the five incident facts from evidence", () => {
    const parsed = parseGatewayIncidentObservation({
      kind: "message.requested",
      source: SOURCE,
      payload: {
        evidence: {
          anomalyId: ANOMALY,
          state: "open",
          severity: "warning",
          observedAt: BASE,
          evidence: { stuck: 3 },
        },
      },
    });
    expect(parsed).toEqual(observation("open", BASE, { stuck: 3 }));
  });

  test("ignores ordinary producer evidence", () => {
    expect(
      parseGatewayIncidentObservation({
        kind: "message.requested",
        source: SOURCE,
        payload: { evidence: { runId: "run-1" } },
      }),
    ).toBeNull();
  });

  test("rejects an incident-shaped envelope that can bypass the latch", () => {
    expect(() =>
      parseGatewayIncidentObservation({
        kind: "message.requested",
        source: SOURCE,
        payload: {
          evidence: {
            source: "different-producer",
            anomalyId: ANOMALY,
            state: "open",
            severity: "critical",
            observedAt: BASE,
          },
        },
      }),
    ).toThrow("Invalid gateway incident producer contract");
  });
});

describe("gateway incident transition table", () => {
  test("opens, joins repeats, extends one material change, and resolves once", () => {
    const events: MessageEventDocument[] = [];
    const opened = fold(events, observation("open", BASE), 1);
    expect(opened.decision).toMatchObject({
      verb: "aggregate",
      action: "open",
      anomalyId: ANOMALY,
      delivery: "immediate",
    });
    expect(opened.receipt.after).toMatchObject({
      state: "open",
      firstObservedAt: BASE,
      lastObservedAt: BASE,
      lastDeliveredAt: BASE,
      repeatCount: 0,
    });
    expect(opened.receipt.after.platformAnchor).toBeUndefined();
    expect(opened.receipt.after.resolutionDeliveredAt).toBeUndefined();
    expect(opened.receipt.after.lastEvidenceHash).toHaveLength(64);

    const repeatedAt = "2026-07-27T17:00:00.000Z";
    const repeated = fold(events, observation("open", repeatedAt), 2);
    expect(repeated.decision).toMatchObject({
      verb: "aggregate",
      action: "join",
    });
    expect(repeated.decision).not.toHaveProperty("delivery");
    expect(repeated.receipt).toMatchObject({
      transition: "repeated",
      delivery: "aggregate",
      after: { lastObservedAt: repeatedAt, repeatCount: 1 },
    });

    const changedAt = "2026-07-27T18:00:00.000Z";
    const changed = fold(
      events,
      observation(
        "changed",
        changedAt,
        { failureMode: "loop-stalled", stuck: 8 },
        ANOMALY,
        "critical",
      ),
      3,
    );
    expect(changed.decision).toMatchObject({
      verb: "aggregate",
      action: "extend",
      anomalyId: ANOMALY,
      delivery: "immediate",
    });
    expect(changed.receipt.after).toMatchObject({
      state: "changed",
      lastDeliveredAt: changedAt,
      repeatCount: 2,
    });

    const resolvedAt = "2026-07-27T19:00:00.000Z";
    const resolved = fold(events, observation("resolved", resolvedAt, { stuck: 0 }), 4);
    expect(resolved.decision).toMatchObject({
      verb: "aggregate",
      action: "close-deliver",
      anomalyId: ANOMALY,
      delivery: "immediate",
    });
    expect(resolved.receipt.after).toMatchObject({
      state: "resolved",
      resolutionDeliveredAt: resolvedAt,
      tombstone: { resolvedAt },
    });

    const resolvedRepeat = fold(
      events,
      observation("resolved", "2026-07-27T20:00:00.000Z", { stuck: 0 }),
      5,
    );
    expect(resolvedRepeat.decision).toEqual({ verb: "drop", anomalyId: ANOMALY });
    expect(resolvedRepeat.receipt.transition).toBe("resolved-repeat");
  });

  test("allows only one changed delivery for one anomaly on one PT day", () => {
    const events: MessageEventDocument[] = [];
    fold(events, observation("open", BASE), 1);
    const first = fold(
      events,
      observation("changed", "2026-07-27T17:00:00.000Z", { mode: "backlog", stuck: 5 }),
      2,
    );
    const second = fold(
      events,
      observation(
        "changed",
        "2026-07-27T18:00:00.000Z",
        { mode: "loop", stuck: 9 },
        ANOMALY,
        "critical",
      ),
      3,
    );
    const resolved = fold(
      events,
      observation("resolved", "2026-07-27T19:00:00.000Z", { stuck: 0 }),
      4,
    );
    expect(first.receipt.delivery).toBe("immediate");
    expect(second.receipt.delivery).toBe("aggregate");
    expect(second.decision).toMatchObject({ verb: "aggregate", action: "extend" });
    expect(second.decision).not.toHaveProperty("delivery");
    expect(resolved.receipt.delivery).toBe("immediate");
    expect(
      events.filter(
        (event) =>
          (
            event.payload as {
              incident: { delivery: string };
            }
          ).incident.delivery === "immediate",
      ),
    ).toHaveLength(3);
  });

  test("reopens as a linked successor and retains the resolved tombstone in history", () => {
    const events: MessageEventDocument[] = [];
    const opened = fold(events, observation("open", BASE), 1);
    fold(events, observation("resolved", "2026-07-27T17:00:00.000Z", { stuck: 0 }), 2);
    const reopened = fold(events, observation("open", "2026-07-28T16:00:00.000Z", { stuck: 2 }), 3);
    expect(reopened.receipt.transition).toBe("reopened");
    expect(reopened.receipt.after.follows).toBe(opened.receipt.after.aggregateId);
    expect(reopened.receipt.after.aggregateId).not.toBe(opened.receipt.after.aggregateId);

    const store = reconstructGatewayIncidentStore(events);
    expect(store.history[opened.receipt.after.aggregateId]).toMatchObject({
      state: "resolved",
      tombstone: { resolvedAt: "2026-07-27T17:00:00.000Z" },
    });
  });

  test("a distinct critical anomaly gets its own cap and names its anomaly ID", () => {
    const events: MessageEventDocument[] = [];
    fold(events, observation("open", BASE), 1);
    const distinct = fold(
      events,
      observation(
        "open",
        "2026-07-27T16:05:00.000Z",
        { failureMode: "scheduler-dead" },
        "hourly-loop-stalled",
        "critical",
      ),
      2,
    );
    expect(distinct.decision).toMatchObject({
      verb: "aggregate",
      action: "open",
      anomalyId: "hourly-loop-stalled",
      delivery: "immediate",
    });
    expect(distinct.reason).toContain("hourly-loop-stalled");
  });

  test("routine all-good evidence opens one daily digest, then joins it", () => {
    const events: MessageEventDocument[] = [];
    const first = fold(
      events,
      observation("resolved", BASE, { allGood: true }, "daily-all-good", "info"),
      1,
    );
    const second = fold(
      events,
      observation(
        "resolved",
        "2026-07-27T17:00:00.000Z",
        { allGood: true },
        "daily-all-good",
        "info",
      ),
      2,
    );
    expect(first.decision).toMatchObject({ verb: "aggregate", action: "open" });
    expect(second.decision).toMatchObject({
      verb: "aggregate",
      action: "join",
      aggregateId: first.receipt.after.aggregateId,
    });
    expect(first.receipt.delivery).toBe("daily-digest");
    expect(second.receipt.delivery).toBe("daily-digest");
  });

  test("reconstructs the Telegram platform anchor from the canonical delivery receipt", () => {
    const events: MessageEventDocument[] = [];
    const opened = fold(events, observation("open", BASE), 1);
    events.push({
      _id: "confirmed-1",
      kind: "delivery.confirmed",
      source: "gateway-transport",
      semanticKey: "delivery-confirmed:flow-1:message-1",
      payload: {},
      flowId: "flow-1",
      platform: "telegram",
      platformMessageId: "message-1",
      sequence: 2,
      recordedAt: Date.parse(BASE) + 1,
      occurredAt: Date.parse(BASE) + 1,
      schemaVersion: 1,
      _creationTime: Date.parse(BASE) + 1,
    });
    const store = reconstructGatewayIncidentStore(events);
    expect(store.history[opened.receipt.after.aggregateId].platformAnchor).toEqual({
      platform: "telegram",
      platformMessageId: "message-1",
    });
  });
});

test("replays the audited 42-input Campaign Pulse shape at 15 predicted DMs", () => {
  const events: MessageEventDocument[] = [];
  const dayStarts = [
    "2026-07-26T15:00:00.000Z",
    "2026-07-27T15:00:00.000Z",
    "2026-07-28T15:00:00.000Z",
    "2026-07-29T15:00:00.000Z",
  ];
  const observationsPerDay = [4, 15, 14, 9];
  let eventIndex = 1;

  for (const [dayIndex, count] of observationsPerDay.entries()) {
    const start = Date.parse(dayStarts[dayIndex]!);
    for (let offset = 0; offset < count; offset += 1) {
      const isChanged = offset === 1;
      const isResolved = offset === count - (dayIndex < 3 ? 2 : 1);
      const isCloseOut = dayIndex < 3 && offset === count - 1;
      const observedAt = new Date(start + offset * 60 * 60 * 1000).toISOString();
      if (isCloseOut) {
        fold(
          events,
          observation("resolved", observedAt, { closeOut: true }, "daily-all-good", "info"),
          eventIndex,
        );
      } else if (isResolved) {
        fold(events, observation("resolved", observedAt, { stuck: 0 }), eventIndex);
      } else if (isChanged) {
        fold(
          events,
          observation(
            "changed",
            observedAt,
            { failureMode: "loop-stalled", stuck: 8 },
            ANOMALY,
            "critical",
          ),
          eventIndex,
        );
      } else {
        fold(events, observation("open", observedAt), eventIndex);
      }
      eventIndex += 1;
    }
  }

  expect(events).toHaveLength(42);
  const receipts = events.map(
    (event) =>
      (event.payload as { incident: { delivery: string; after: { aggregateId: string } } })
        .incident,
  );
  const immediateDmCount = receipts.filter((receipt) => receipt.delivery === "immediate").length;
  const dailyDigestCount = new Set(
    receipts
      .filter((receipt) => receipt.delivery === "daily-digest")
      .map((receipt) => receipt.after.aggregateId),
  ).size;
  expect({
    immediateDmCount,
    dailyDigestCount,
    predictedDmCount: immediateDmCount + dailyDigestCount,
  }).toEqual({ immediateDmCount: 12, dailyDigestCount: 3, predictedDmCount: 15 });
});
