import { describe, expect, test } from "bun:test";
import { createStreamTools } from "./stream-tools.mjs";

function incidentInput(id, state, observedAt, evidence) {
  return {
    _id: id,
    kind: "message.requested",
    source: "campaign-pulse",
    rawSourceId: id,
    flowId: `flow-${id}`,
    recordedAt: Date.parse(observedAt),
    occurredAt: Date.parse(observedAt),
    sequence: 1,
    payload: {
      text: `campaign ${state}`,
      evidence: {
        anomalyId: "welcome-email-backlog",
        state,
        severity: state === "changed" ? "critical" : "warning",
        observedAt,
        evidence,
      },
    },
  };
}

function fakeClient(seed) {
  const events = [...seed];
  let cursorSequence = 0;
  return {
    events,
    gatewayReplayContext: async (limit = 100) => {
      const pending = events
        .filter((event) => (event.sequence ?? 0) > cursorSequence)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
        .slice(0, Math.min(limit, 100));
      const pendingIds = new Set(pending.map((event) => event._id));
      return {
        pending,
        latestHandoff: events.filter((event) => event.kind === "gateway.handoff").at(-1) ?? null,
        coverages: events
          .filter((event) => event.kind === "gateway.decision.recorded")
          .flatMap((event) =>
            (event.payload?.inputEventIds ?? [])
              .filter((inputEventId) => pendingIds.has(inputEventId))
              .map((inputEventId) => ({
                inputEventId,
                decisionEventId: event._id,
                terminal:
                  event.payload?.decision?.action === "close-deliver" ||
                  new Set(["deliver", "observe", "fanout", "route", "drop"]).has(
                    event.payload?.decision?.verb,
                  ),
                verb: event.payload?.decision?.verb,
                ...(event.payload?.decision?.action
                  ? { action: event.payload.decision.action }
                  : {}),
              })),
          ),
      };
    },
    readSince: async (recordedAt, limit, cursor) => {
      const eligible = events.filter((event) => (event.recordedAt ?? 0) >= recordedAt);
      const offset = cursor ? Number(cursor) : 0;
      const page = eligible.slice(offset, offset + limit);
      return {
        events: page,
        nextCursor: offset + page.length < eligible.length ? String(offset + page.length) : null,
        source: "message-event-log",
      };
    },
    pendingForConsumer: async (_consumer, limit = 100) =>
      events
        .filter((event) => (event.sequence ?? 0) > cursorSequence)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
        .slice(0, Math.min(limit, 100)),
    append: async (input) => {
      const event = {
        ...input,
        _id: `event-${events.length + 1}`,
        recordedAt: Math.max(...events.map((item) => item.recordedAt ?? 0), 0) + 1,
        sequence: events.length + 1,
      };
      events.push(event);
      return {
        eventId: event._id,
        semanticKey: input.semanticKey,
        deduplicated: false,
        schemaVersion: 1,
      };
    },
    advanceCursor: async (_consumer, eventId) => {
      const event = events.find((item) => item._id === eventId);
      cursorSequence = Math.max(cursorSequence, event?.sequence ?? cursorSequence);
      return { lastEventId: eventId, lastSequence: cursorSequence };
    },
  };
}

function proposed(inputEventId, rewrite) {
  return {
    inputEventIds: [inputEventId],
    reason: "Agent proposed delivery before the latch.",
    promptRevision: "incident-test",
    decisionSeq: 1,
    decision: {
      verb: "deliver",
      target: { kind: "platform", platform: "telegram" },
    },
    rewrite,
  };
}

describe("stream incident latch integration", () => {
  test("rewrites open and repeat decisions before canonical append", async () => {
    const first = incidentInput("input-1", "open", "2026-07-27T16:00:00.000Z", {
      failureMode: "backlog",
      stuck: 3,
    });
    const client = fakeClient([first]);
    const stream = createStreamTools({ client, now: () => Date.parse("2026-07-27T16:00:01.000Z") });

    const opened = await stream.recordDecision({
      payload: proposed("input-1", "Three welcome emails are stuck."),
    });
    expect(opened.advanceAfter).toBe(true);
    expect(opened.event.payload).toMatchObject({
      decision: {
        verb: "aggregate",
        action: "open",
        anomalyId: "welcome-email-backlog",
        delivery: "immediate",
      },
      incident: {
        transition: "opened",
        delivery: "immediate",
      },
    });

    const repeat = incidentInput("input-2", "open", "2026-07-27T17:00:00.000Z", {
      failureMode: "backlog",
      stuck: 3,
    });
    repeat.sequence = client.events.length + 1;
    client.events.push(repeat);
    const joined = await stream.recordDecision({
      payload: proposed("input-2", "The same welcome emails are still stuck."),
    });
    expect(joined.event.payload).toMatchObject({
      decision: {
        verb: "aggregate",
        action: "join",
        anomalyId: "welcome-email-backlog",
      },
      incident: {
        transition: "repeated",
        delivery: "aggregate",
        after: { repeatCount: 1 },
      },
    });
    expect(joined.event.payload.decision).not.toHaveProperty("delivery");
  });
});
