import { createHash } from "node:crypto";
import type {
  GatewayDecision,
  GatewayIncidentDecisionReceipt,
  GatewayIncidentDeliverySlot,
  GatewayIncidentObservation,
  GatewayIncidentPlatformAnchor,
  GatewayIncidentState,
  MessageEventDocument,
} from "@joelclaw/message-event-log";

export const GATEWAY_INCIDENT_LATCH_SCHEMA = "gateway-incident-latch.v1" as const;
export const GATEWAY_INCIDENT_TIME_ZONE = "America/Los_Angeles" as const;
export const DEFAULT_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export type GatewayIncidentStore = {
  readonly incidents: Record<string, GatewayIncidentState>;
  readonly history: Record<string, GatewayIncidentState>;
  readonly deliverySlots: Record<string, Partial<Record<GatewayIncidentDeliverySlot, true>>>;
  readonly dailyDigestAggregateIds: Record<string, string>;
};

export type ReconcileGatewayIncidentResult = {
  readonly decision: GatewayDecision;
  readonly reason: string;
  readonly receipt: GatewayIncidentDecisionReceipt;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function validObservedAt(value: unknown): string | null {
  const cleaned = nonEmpty(value);
  return cleaned !== null && Number.isFinite(Date.parse(cleaned)) ? cleaned : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)) ?? "undefined")
    .digest("hex");
}

function compactHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function incidentKey(source: string, anomalyId: string): string {
  return `${source}\u0000${anomalyId}`;
}

function digestKey(source: string, ptDay: string): string {
  return `${source}\u0000${ptDay}`;
}

function deliveryBudgetKey(key: string, ptDay: string): string {
  return `${key}\u0000${ptDay}`;
}

function incidentAggregateId(input: {
  source: string;
  anomalyId: string;
  observedAt: string;
  follows?: string;
}): string {
  const suffix = compactHash(
    `${input.source}\u0000${input.anomalyId}\u0000${input.observedAt}\u0000${input.follows ?? ""}`,
  );
  return `incident:${input.anomalyId}:${suffix}`;
}

function dailyDigestAggregateId(source: string, ptDay: string): string {
  return `daily:${ptDay}:${compactHash(source)}`;
}

export function createGatewayIncidentStore(): GatewayIncidentStore {
  return {
    incidents: {},
    history: {},
    deliverySlots: {},
    dailyDigestAggregateIds: {},
  };
}

export function gatewayIncidentPtDate(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GATEWAY_INCIDENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Producer envelope:
 *
 * - `message.requested.source` supplies `source`.
 * - `message.requested.payload.evidence` supplies
 *   `{ anomalyId, state, severity, observedAt, evidence }`.
 *
 * A nested `payload.evidence.incident` object is accepted for producers whose
 * context already contains unrelated evidence.
 */
export function parseGatewayIncidentObservation(
  event: Pick<MessageEventDocument, "kind" | "payload" | "source">,
): GatewayIncidentObservation | null {
  if (event.kind !== "message.requested") return null;
  const payload = asRecord(event.payload);
  const outerEvidence = asRecord(payload?.evidence);
  const nestedIncident = asRecord(outerEvidence?.incident);
  const candidate = nestedIncident ?? outerEvidence;
  if (!candidate) return null;

  const anomalyId = nonEmpty(candidate.anomalyId);
  if (!nestedIncident && !anomalyId) return null;

  const source = nonEmpty(event.source);
  const suppliedSource = nonEmpty(candidate.source);
  const state = candidate.state;
  const severity = nonEmpty(candidate.severity);
  const observedAt = validObservedAt(candidate.observedAt);
  if (
    !source ||
    !anomalyId ||
    (suppliedSource !== null && suppliedSource !== source) ||
    (state !== "open" && state !== "changed" && state !== "resolved") ||
    !severity ||
    !observedAt ||
    !Object.hasOwn(candidate, "evidence")
  ) {
    throw new Error(
      "Invalid gateway incident producer contract: source must match the event and anomalyId, state, severity, observedAt, and evidence are required.",
    );
  }

  return {
    source,
    anomalyId,
    state,
    severity,
    observedAt,
    evidence: candidate.evidence,
  };
}

function claimDeliverySlot(input: {
  store: GatewayIncidentStore;
  key: string;
  ptDay: string;
  slot: GatewayIncidentDeliverySlot;
}): boolean {
  const key = deliveryBudgetKey(input.key, input.ptDay);
  const budget = input.store.deliverySlots[key] ?? {};
  input.store.deliverySlots[key] = budget;
  if (budget[input.slot]) return false;
  budget[input.slot] = true;
  return true;
}

function copyStore(store: GatewayIncidentStore): GatewayIncidentStore {
  return structuredClone(store);
}

function immediateAggregateDecision(input: {
  action: "open" | "extend" | "close-deliver";
  aggregateId: string;
  anomalyId: string;
  inputEventId: string;
  follows?: string;
  deliver: boolean;
}): GatewayDecision {
  if (!input.deliver && input.action === "close-deliver") {
    return { verb: "drop", anomalyId: input.anomalyId };
  }
  return {
    verb: "aggregate",
    action: input.action,
    aggregateId: input.aggregateId,
    anomalyId: input.anomalyId,
    memberEventIds: [input.inputEventId],
    ...(input.deliver ? { delivery: "immediate" as const } : {}),
    ...(input.follows ? { follows: input.follows } : {}),
  };
}

function transitionSlot(
  transition: GatewayIncidentDecisionReceipt["transition"],
): GatewayIncidentDeliverySlot | null {
  if (transition === "opened" || transition === "reopened") return "open";
  if (transition === "changed") return "changed";
  if (transition === "resolved") return "resolved";
  return null;
}

function transitionReason(input: {
  anomalyId: string;
  delivered: boolean;
  transition: GatewayIncidentDecisionReceipt["transition"];
}): string {
  const suffix = input.delivered ? "immediate delivery allowed" : "recorded without another DM";
  switch (input.transition) {
    case "opened":
      return `Incident ${input.anomalyId} opened; ${suffix}.`;
    case "reopened":
      return `Incident ${input.anomalyId} reopened as a linked successor; ${suffix}.`;
    case "changed":
      return `Incident ${input.anomalyId} changed materially; ${suffix}.`;
    case "resolved":
      return `Incident ${input.anomalyId} resolved; ${suffix}.`;
    case "repeated":
      return `Incident ${input.anomalyId} repeated without a material state change; joined its aggregate.`;
    case "resolved-repeat":
      return `Incident ${input.anomalyId} was already resolved; recorded and dropped.`;
    case "routine-all-good":
      return `Routine all-good observation ${input.anomalyId} joined the PT daily digest.`;
  }
}

export function reconcileGatewayIncident(input: {
  readonly store: GatewayIncidentStore;
  readonly observation: GatewayIncidentObservation;
  readonly inputEventId: string;
  readonly tombstoneMs?: number;
}): ReconcileGatewayIncidentResult {
  const store = copyStore(input.store);
  const observation = input.observation;
  const key = incidentKey(observation.source, observation.anomalyId);
  const previous = store.incidents[key];
  const evidenceHash = hash(observation.evidence);
  const ptDay = gatewayIncidentPtDate(observation.observedAt);
  const tombstoneMs = input.tombstoneMs ?? DEFAULT_TOMBSTONE_MS;
  let transition: GatewayIncidentDecisionReceipt["transition"];

  if (
    observation.state === "resolved" &&
    (!previous || previous.aggregateId.startsWith("daily:"))
  ) {
    transition = "routine-all-good";
  } else if (!previous) {
    transition = "opened";
  } else if (previous.state === "resolved" && observation.state === "resolved") {
    transition = "resolved-repeat";
  } else if (previous.state === "resolved") {
    transition = "reopened";
  } else if (observation.state === "resolved") {
    transition = "resolved";
  } else if (
    observation.state === "changed" &&
    (evidenceHash !== previous.lastEvidenceHash || observation.severity !== previous.severity)
  ) {
    transition = "changed";
  } else {
    transition = "repeated";
  }

  if (transition === "routine-all-good") {
    const dailyKey = digestKey(observation.source, ptDay);
    const existingAggregateId = store.dailyDigestAggregateIds[dailyKey];
    const aggregateId = existingAggregateId ?? dailyDigestAggregateId(observation.source, ptDay);
    store.dailyDigestAggregateIds[dailyKey] = aggregateId;
    const after: GatewayIncidentState = {
      source: observation.source,
      anomalyId: observation.anomalyId,
      state: "resolved",
      severity: observation.severity,
      firstObservedAt: observation.observedAt,
      lastObservedAt: observation.observedAt,
      lastEvidenceHash: evidenceHash,
      repeatCount: existingAggregateId ? (previous?.repeatCount ?? 0) + 1 : 0,
      aggregateId,
      tombstone: {
        resolvedAt: observation.observedAt,
        expiresAt: new Date(Date.parse(observation.observedAt) + tombstoneMs).toISOString(),
      },
    };
    store.incidents[key] = after;
    store.history[aggregateId] = after;
    const decision: GatewayDecision = {
      verb: "aggregate",
      action: existingAggregateId ? "join" : "open",
      aggregateId,
      anomalyId: observation.anomalyId,
      memberEventIds: [input.inputEventId],
      ...(!existingAggregateId
        ? { holdUntil: Date.parse(observation.observedAt) + 24 * 60 * 60 * 1000 }
        : {}),
    };
    const receipt: GatewayIncidentDecisionReceipt = {
      schema: GATEWAY_INCIDENT_LATCH_SCHEMA,
      key,
      observation,
      transition,
      delivery: "daily-digest",
      after,
      ptDate: ptDay,
    };
    return {
      decision,
      reason: transitionReason({
        anomalyId: observation.anomalyId,
        delivered: false,
        transition,
      }),
      receipt,
    };
  }

  if (transition === "resolved-repeat") {
    const after: GatewayIncidentState = {
      ...previous!,
      lastObservedAt: observation.observedAt,
      lastEvidenceHash: evidenceHash,
      repeatCount: previous!.repeatCount + 1,
    };
    store.incidents[key] = after;
    store.history[after.aggregateId] = after;
    const receipt: GatewayIncidentDecisionReceipt = {
      schema: GATEWAY_INCIDENT_LATCH_SCHEMA,
      key,
      observation,
      transition,
      delivery: "recorded-drop",
      after,
      ptDate: ptDay,
    };
    return {
      decision: { verb: "drop", anomalyId: observation.anomalyId },
      reason: transitionReason({
        anomalyId: observation.anomalyId,
        delivered: false,
        transition,
      }),
      receipt,
    };
  }

  const slot = transitionSlot(transition);
  const delivered = slot !== null && claimDeliverySlot({ store, key, ptDay, slot });
  const follows = transition === "reopened" ? previous?.aggregateId : previous?.follows;
  const aggregateId =
    transition === "opened" || transition === "reopened"
      ? incidentAggregateId({
          source: observation.source,
          anomalyId: observation.anomalyId,
          observedAt: observation.observedAt,
          ...(follows ? { follows } : {}),
        })
      : previous!.aggregateId;
  const firstObservedAt =
    transition === "opened" || transition === "reopened"
      ? observation.observedAt
      : previous!.firstObservedAt;
  const repeatCount =
    transition === "opened" || transition === "reopened" ? 0 : previous!.repeatCount + 1;
  const resolved = transition === "resolved";
  const sameIncident = transition !== "opened" && transition !== "reopened";
  const after: GatewayIncidentState = {
    source: observation.source,
    anomalyId: observation.anomalyId,
    state: resolved ? "resolved" : observation.state,
    severity: observation.severity,
    firstObservedAt,
    lastObservedAt: observation.observedAt,
    ...(delivered
      ? { lastDeliveredAt: observation.observedAt }
      : sameIncident && previous?.lastDeliveredAt
        ? { lastDeliveredAt: previous.lastDeliveredAt }
        : {}),
    lastEvidenceHash: evidenceHash,
    repeatCount,
    aggregateId,
    ...(sameIncident && previous?.platformAnchor
      ? { platformAnchor: previous.platformAnchor }
      : {}),
    ...(resolved && delivered ? { resolutionDeliveredAt: observation.observedAt } : {}),
    ...(resolved
      ? {
          tombstone: {
            resolvedAt: observation.observedAt,
            expiresAt: new Date(Date.parse(observation.observedAt) + tombstoneMs).toISOString(),
          },
        }
      : {}),
    ...(follows ? { follows } : {}),
  };
  store.incidents[key] = after;
  store.history[aggregateId] = after;

  let decision: GatewayDecision;
  if (transition === "repeated") {
    decision = {
      verb: "aggregate",
      action: "join",
      aggregateId,
      anomalyId: observation.anomalyId,
      memberEventIds: [input.inputEventId],
    };
  } else if (transition === "resolved") {
    decision = immediateAggregateDecision({
      action: "close-deliver",
      aggregateId,
      anomalyId: observation.anomalyId,
      inputEventId: input.inputEventId,
      deliver: delivered,
    });
  } else {
    decision = immediateAggregateDecision({
      action: transition === "changed" ? "extend" : "open",
      aggregateId,
      anomalyId: observation.anomalyId,
      inputEventId: input.inputEventId,
      ...(follows ? { follows } : {}),
      deliver: delivered,
    });
  }

  const receipt: GatewayIncidentDecisionReceipt = {
    schema: GATEWAY_INCIDENT_LATCH_SCHEMA,
    key,
    observation,
    transition,
    delivery: delivered ? "immediate" : "aggregate",
    after,
    ptDate: ptDay,
  };
  return {
    decision,
    reason: transitionReason({
      anomalyId: observation.anomalyId,
      delivered,
      transition,
    }),
    receipt,
  };
}

function platformAnchor(event: MessageEventDocument): GatewayIncidentPlatformAnchor | null {
  if (
    event.kind !== "delivery.confirmed" ||
    typeof event.platform !== "string" ||
    typeof event.platformMessageId !== "string" ||
    event.platformMessageId.trim().length === 0
  ) {
    return null;
  }
  return {
    platform: event.platform,
    platformMessageId: event.platformMessageId,
  };
}

export function reconstructGatewayIncidentStore(
  events: readonly MessageEventDocument[],
): GatewayIncidentStore {
  const store = createGatewayIncidentStore();
  const deliveryByFlow = new Map<string, { aggregateId: string; key: string }>();
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence || left.recordedAt - right.recordedAt,
  );

  for (const event of ordered) {
    if (event.kind === "gateway.decision.recorded") {
      const payload = asRecord(event.payload);
      const incident = asRecord(payload?.incident) as GatewayIncidentDecisionReceipt | null;
      const after = incident?.after;
      if (
        incident?.schema !== GATEWAY_INCIDENT_LATCH_SCHEMA ||
        !after ||
        typeof incident.key !== "string"
      ) {
        continue;
      }
      store.incidents[incident.key] = structuredClone(after);
      store.history[after.aggregateId] = structuredClone(after);
      const slot = transitionSlot(incident.transition);
      if (incident.delivery === "immediate" && slot) {
        const budget = deliveryBudgetKey(incident.key, incident.ptDate);
        store.deliverySlots[budget] ??= {};
        store.deliverySlots[budget][slot] = true;
      }
      if (incident.delivery === "daily-digest") {
        store.dailyDigestAggregateIds[digestKey(after.source, incident.ptDate)] = after.aggregateId;
      }
      if (event.flowId && incident.delivery === "immediate") {
        deliveryByFlow.set(event.flowId, {
          aggregateId: after.aggregateId,
          key: incident.key,
        });
      }
      continue;
    }

    const anchor = platformAnchor(event);
    const delivery = event.flowId ? deliveryByFlow.get(event.flowId) : undefined;
    if (!anchor || !delivery) continue;
    const current = store.incidents[delivery.key];
    if (current?.aggregateId === delivery.aggregateId) {
      store.incidents[delivery.key] = { ...current, platformAnchor: anchor };
    }
    const historical = store.history[delivery.aggregateId];
    if (historical) {
      store.history[delivery.aggregateId] = { ...historical, platformAnchor: anchor };
    }
  }

  return store;
}
