import { describe, expect, test } from "bun:test";
import { createToolHandlers, handleMcpMessage, toolDefinitions } from "./index.mjs";
import { createStreamTools, validateDecisionPayload } from "./stream-tools.mjs";
import { createWakeTools } from "./wake-tools.mjs";

const inputEvent = { _id: "input-1", kind: "message.requested", source: "producer", recordedAt: 10, sequence: 1 };
const decisionPayload = {
  inputEventIds: ["input-1"],
  reason: "Joel asked for the result.",
  promptRevision: "abc123",
  decisionSeq: 1,
  decision: { verb: "deliver", target: { kind: "platform", platform: "telegram" } },
  rewrite: "Done.",
};

function fakeClient() {
  const events = [inputEvent];
  return {
    events,
    readSince: async (recordedAt, limit, cursor) => {
      const eligible = events.filter((event) => (event.recordedAt ?? 0) >= recordedAt);
      const offset = cursor ? Number(cursor) : 0;
      const page = eligible.slice(offset, offset + limit);
      return { events: page, nextCursor: offset + page.length < eligible.length ? String(offset + page.length) : null, source: "message-event-log" };
    },
    pendingForConsumer: async () => events,
    append: async (input) => {
      const event = { ...input, _id: `event-${events.length + 1}`, recordedAt: 20 + events.length, sequence: events.length + 1 };
      events.push(event);
      return { eventId: event._id, semanticKey: input.semanticKey, deduplicated: false, schemaVersion: 1 };
    },
    advanceCursor: async (consumer, eventId) => ({ consumer, lastEventId: eventId, lastSequence: 1, updatedAt: 30 }),
  };
}

describe("stream receipts", () => {
  test("validates one complete decision and reads it back", async () => {
    const client = fakeClient();
    const stream = createStreamTools({ client, now: () => 20 });
    const appended = await stream.recordDecision({ payload: decisionPayload });
    expect(appended.receipt.semanticKey).toBe("gateway:input-1:1");
    expect(appended.event.kind).toBe("gateway.decision.recorded");
    const cursor = await stream.advanceAfterDecision({ eventId: "input-1", decisionEventId: appended.receipt.eventId });
    expect(cursor.lastEventId).toBe("input-1");
  });

  test("refuses duplicate decisions before cursor advance", async () => {
    const client = fakeClient();
    const stream = createStreamTools({ client, now: () => 20 });
    const first = await stream.recordDecision({ payload: decisionPayload });
    await stream.recordDecision({ payload: { ...decisionPayload, decisionSeq: 2 } });
    await expect(stream.advanceAfterDecision({ eventId: "input-1", decisionEventId: first.receipt.eventId })).rejects.toThrow("found 2");
  });

  test("rejects duplicate aggregate members", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      decision: { verb: "aggregate", action: "open", aggregateId: "a1", memberEventIds: ["input-1", "input-1"] },
    })).toThrow("must not contain duplicates");
  });
});

test("MCP exposes all production tool families", async () => {
  const names = toolDefinitions.map((tool) => tool.name);
  expect(names.some((name) => name.startsWith("stream_"))).toBe(true);
  expect(names.some((name) => name.startsWith("herdr_"))).toBe(true);
  expect(names.some((name) => name.startsWith("wake_"))).toBe(true);
  const listed = await handleMcpMessage({ id: 1, method: "tools/list" }, createToolHandlers({
    stream: {}, herdr: {}, wake: {},
  }));
  expect(listed.tools).toHaveLength(16);
});

test("aggregate deadline uses the durable wake registry", async () => {
  const calls = [];
  const wake = createWakeTools({ run: async (...args) => { calls.push(args); return { ok: true }; } });
  await wake.scheduleAggregateDeadline({
    target: "gateway-agent",
    holdUntil: Date.now() + 60_000,
    aggregateId: "storm-1",
    memberEventIds: ["input-1"],
  });
  expect(calls[0][0]).toBe("joelclaw");
  expect(calls[0][1]).toContain("wake");
  expect(calls[0][1].join(" ")).toContain("aggregate.deadline.reached");
});
