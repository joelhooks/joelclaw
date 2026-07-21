import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  gatewayDecisionSemanticKey,
} from "@joelclaw/message-event-log";

const MAX_SCAN_EVENTS = 20_000;
const PAGE_SIZE = 500;

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

export function validateDecisionPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object");
  if (!Array.isArray(payload.inputEventIds) || payload.inputEventIds.length === 0) {
    throw new Error("inputEventIds must contain at least one event ID");
  }
  const inputEventIds = payload.inputEventIds.map((id, index) => nonEmpty(id, `inputEventIds[${index}]`));
  if (new Set(inputEventIds).size !== inputEventIds.length) throw new Error("inputEventIds must not contain duplicates");
  nonEmpty(payload.reason, "reason");
  nonEmpty(payload.promptRevision, "promptRevision");
  positiveInteger(payload.decisionSeq, "decisionSeq");
  const decision = payload.decision;
  if (!decision || typeof decision !== "object") throw new Error("decision must be an object");
  const verbs = new Set(["deliver", "aggregate", "escalate", "fanout", "route", "drop"]);
  if (!verbs.has(decision.verb)) throw new Error(`Unsupported decision verb: ${decision.verb}`);
  // A decision that delivers must carry the full operator-facing message.
  // Five close-delivers shipped without text on cutover day and were never
  // sent — the executor cannot deliver what was never written.
  const delivers = decision.verb === "deliver" || decision.action === "close-deliver";
  if (delivers && (typeof payload.rewrite !== "string" || payload.rewrite.trim().length === 0)) {
    throw new Error("deliver and close-deliver decisions require non-empty payload.rewrite — the exact message text Joel receives");
  }
  if (decision.verb === "aggregate") {
    if (!new Set(["open", "join", "extend", "close-deliver"]).has(decision.action)) {
      throw new Error(`Unsupported aggregate action: ${decision.action}`);
    }
    nonEmpty(decision.aggregateId, "decision.aggregateId");
    if (!Array.isArray(decision.memberEventIds) || decision.memberEventIds.length === 0) {
      throw new Error("decision.memberEventIds must not be empty");
    }
    const members = decision.memberEventIds.map((id, index) => nonEmpty(id, `decision.memberEventIds[${index}]`));
    if (new Set(members).size !== members.length) throw new Error("decision.memberEventIds must not contain duplicates");
    for (const inputEventId of inputEventIds) {
      if (!members.includes(inputEventId)) throw new Error(`Aggregate members do not include input ${inputEventId}`);
    }
  }
  return { ...payload, inputEventIds, reason: payload.reason.trim(), promptRevision: payload.promptRevision.trim() };
}

export function createStreamTools({ client = createMessageEventLogClient(), now = () => Date.now() } = {}) {
  async function scanAll({ recordedAt = 0, stopWhen } = {}) {
    const events = [];
    let cursor = null;
    do {
      const page = await client.readSince(recordedAt, PAGE_SIZE, cursor);
      for (const event of page.events) {
        events.push(event);
        if (stopWhen?.(event)) return events;
        if (events.length >= MAX_SCAN_EVENTS) throw new Error(`Stream scan exceeded ${MAX_SCAN_EVENTS} events`);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return events;
  }

  async function appendAndReadBack(input) {
    const before = now();
    const receipt = await client.append(input);
    const candidates = await scanAll({ recordedAt: Math.max(0, before - 5_000), stopWhen: (event) => event._id === receipt.eventId });
    const event = candidates.find((candidate) => candidate._id === receipt.eventId);
    if (!event) throw new Error(`Append readback failed for ${receipt.eventId}`);
    if (event.kind !== input.kind || event.semanticKey !== input.semanticKey) {
      throw new Error(`Append readback mismatch for ${receipt.eventId}`);
    }
    return { receipt, event };
  }

  return {
    readSince: (args) => client.readSince(args.recordedAt, args.limit ?? 100, args.cursor ?? null),
    pending: (args = {}) => client.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, args.limit ?? 100),
    bootstrap: async (args = {}) => {
      const pending = await client.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, args.limit ?? 200);
      const all = await scanAll();
      const latestHandoff = all.filter((event) => event.kind === "gateway.handoff").at(-1) ?? null;
      return { consumer: GATEWAY_MESSAGE_EVENT_CONSUMER, latestHandoff, pending, replayAuthoritative: true };
    },
    recordDecision: async ({ payload, flowId, origin }) => {
      const validated = validateDecisionPayload(payload);
      return appendAndReadBack({
        semanticKey: gatewayDecisionSemanticKey(validated),
        kind: "gateway.decision.recorded",
        source: "joelclaw-gateway",
        payload: validated,
        ...(flowId ? { flowId } : {}),
        ...(origin ? { origin } : {}),
      });
    },
    appendGatewayEvent: async ({ semanticKey, kind, payload, flowId, origin }) => {
      const allowed = new Set(["gateway.handoff", "aggregate.deadline.reached", "inbound.interpreted"]);
      if (!allowed.has(kind)) throw new Error(`Plugin may not append event kind ${kind}`);
      return appendAndReadBack({
        semanticKey: nonEmpty(semanticKey, "semanticKey"),
        kind,
        source: "joelclaw-gateway",
        payload,
        ...(flowId ? { flowId } : {}),
        ...(origin ? { origin } : {}),
      });
    },
    advanceAfterDecision: async ({ eventId, decisionEventId }) => {
      nonEmpty(eventId, "eventId");
      nonEmpty(decisionEventId, "decisionEventId");
      const events = await scanAll();
      const input = events.find((event) => event._id === eventId);
      if (!input) throw new Error(`Input event not found: ${eventId}`);
      if (input.source === "joelclaw-gateway") {
        throw new Error("Use stream_advance_own_output for gateway-owned events");
      }
      const matching = events.filter(
        (event) => event.kind === "gateway.decision.recorded" && event.payload?.inputEventIds?.includes(eventId),
      );
      if (matching.length !== 1) throw new Error(`Expected exactly one decision receipt for ${eventId}; found ${matching.length}`);
      if (matching[0]._id !== decisionEventId) throw new Error(`Decision receipt mismatch for ${eventId}`);
      return client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, eventId);
    },
    advanceOwnOutput: async ({ eventId }) => {
      nonEmpty(eventId, "eventId");
      const events = await scanAll({ stopWhen: (event) => event._id === eventId });
      const event = events.find((candidate) => candidate._id === eventId);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      const gatewayAuthoredKinds = new Set(["gateway.decision.recorded", "gateway.handoff"]);
      const gatewaySources = new Set(["joelclaw-gateway", "gateway"]);
      if (!gatewayAuthoredKinds.has(event.kind) && !gatewaySources.has(event.source)) {
        throw new Error(`${eventId} is not gateway-owned output`);
      }
      return client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, eventId);
    },
  };
}
