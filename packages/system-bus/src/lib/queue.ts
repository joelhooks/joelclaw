import { randomUUID } from "node:crypto";
import {
  init,
  lookupQueueEvent,
  Priority,
  persist,
  type QueueConfig,
  type QueueEventEnvelope,
  type QueuePriorityLabel,
  type QueueTriageDecision,
  type QueueTriageMode,
  type TelemetryEmitter,
} from "@joelclaw/queue";
import { emitOtelEvent } from "../observability/emit";
import { triageQueueEvent } from "./queue-triage";
import { getRedisClient } from "./redis";

const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:system-bus",
  consumerName: "system-bus",
};

const DEFAULT_QUEUE_TRIAGE_FAMILIES = [
  "discovery/noted",
  "discovery/captured",
  "content/updated",
  "subscription/check-feeds.requested",
  "github/workflow_run.completed",
] as const;

const QUEUE_TRIAGE_FAMILY_ALIASES = {
  discovery: ["discovery/noted", "discovery/captured"],
  content: ["content/updated"],
  subscriptions: ["subscription/check-feeds.requested"],
  github: ["github/workflow_run.completed"],
} as const satisfies Record<string, readonly string[]>;

let initPromise: Promise<void> | null = null;

const queueTelemetry: TelemetryEmitter = {
  emit(action, detail, extra) {
    void emitOtelEvent({
      level: "info",
      source: "worker",
      component: "queue",
      action,
      success: true,
      metadata: {
        detail,
        ...(extra ?? {}),
      },
    }).catch(() => {});
  },
};

const queueDeps = {
  getRedisClient,
  init,
  lookupQueueEvent,
  persist,
  triageQueueEvent,
};

export type QueueAdmissionInput = {
  name: string;
  data: Record<string, unknown>;
  source: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
  priority?: Priority | QueuePriorityLabel;
};

export type QueueAdmissionResult = {
  streamId: string;
  eventId: string;
  priority: number;
  triageMode: QueueTriageMode;
  triage?: QueueTriageDecision;
};

function parsePilotSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseQueueTriageMode(raw: string | undefined): QueueTriageMode {
  const normalized = (raw ?? "off").trim().toLowerCase();
  if (normalized === "shadow") return "shadow";
  if (normalized === "enforce") return "enforce";
  return "off";
}

function parsePriorityOverride(value: QueueAdmissionInput["priority"]): Priority | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === Priority.P0 || value === Priority.P1 || value === Priority.P2 || value === Priority.P3) {
      return value;
    }
    return undefined;
  }

  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toUpperCase();
  if (normalized === "P0") return Priority.P0;
  if (normalized === "P1") return Priority.P1;
  if (normalized === "P2") return Priority.P2;
  if (normalized === "P3") return Priority.P3;
  return undefined;
}

function expandQueueTriageFamilies(raw: string | undefined): Set<string> {
  const configured = parsePilotSet(raw);
  if (configured.size === 0) {
    return new Set(DEFAULT_QUEUE_TRIAGE_FAMILIES);
  }

  const expanded = new Set<string>();
  for (const value of configured) {
    const aliasTargets = QUEUE_TRIAGE_FAMILY_ALIASES[value as keyof typeof QUEUE_TRIAGE_FAMILY_ALIASES];
    if (aliasTargets) {
      for (const target of aliasTargets) {
        expanded.add(target);
      }
      continue;
    }

    expanded.add(value);
  }

  return expanded;
}

function resolveQueueTriageMode(eventName: string): QueueTriageMode {
  const requestedMode = parseQueueTriageMode(process.env.QUEUE_TRIAGE_MODE);
  if (requestedMode === "off") return "off";

  const family = eventName.trim().toLowerCase();
  const enabledFamilies = expandQueueTriageFamilies(process.env.QUEUE_TRIAGE_FAMILIES);
  if (!enabledFamilies.has(family)) {
    return "off";
  }

  // Story 2 is shadow-only even if an eager operator sets `enforce` early.
  return requestedMode === "enforce" ? "shadow" : requestedMode;
}

export function isQueuePilotEnabled(name: string): boolean {
  return parsePilotSet(process.env.QUEUE_PILOTS).has(name.trim().toLowerCase());
}

export async function ensureQueueInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = queueDeps.init(queueDeps.getRedisClient(), QUEUE_CONFIG, { telemetry: queueTelemetry });
  }

  await initPromise;
}

async function buildQueueAdmissionEnvelope(input: QueueAdmissionInput): Promise<{
  eventId: string;
  priority: Priority;
  envelope: QueueEventEnvelope;
  triageMode: QueueTriageMode;
  triage?: QueueTriageDecision;
}> {
  const eventName = input.name.trim();
  const registryEntry = queueDeps.lookupQueueEvent(eventName);
  if (!registryEntry) {
    throw new Error(`queue registry has no entry for ${eventName}`);
  }

  const eventId = input.eventId?.trim() || randomUUID();
  const priority = parsePriorityOverride(input.priority) ?? registryEntry.priority ?? Priority.P2;
  const triageMode = resolveQueueTriageMode(eventName);

  const envelope: QueueEventEnvelope = {
    id: eventId,
    name: eventName,
    source: input.source,
    ts: Date.now(),
    data: input.data,
    priority,
    trace: {
      correlationId: eventId,
    },
  };

  if (triageMode === "off") {
    return { eventId, priority, envelope, triageMode };
  }

  const triage = await queueDeps.triageQueueEvent({
    mode: triageMode,
    envelope,
  });

  envelope.triage = triage;
  envelope.priority = parsePriorityOverride(triage.final.priority) ?? priority;

  return {
    eventId,
    priority: envelope.priority,
    envelope,
    triageMode,
    triage,
  };
}

export async function enqueueRegisteredQueueEvent(input: QueueAdmissionInput): Promise<QueueAdmissionResult> {
  await ensureQueueInitialized();

  const admission = await buildQueueAdmissionEnvelope(input);
  const result = await queueDeps.persist({
    payload: admission.envelope as Record<string, unknown>,
    priority: admission.priority,
    metadata: {
      envelope_version: "1",
      source: input.source,
      triageMode: admission.triageMode,
      triageApplied: admission.triage?.applied ?? false,
      triageFallbackReason: admission.triage?.fallbackReason ?? null,
      triageSuggestedPriority: admission.triage?.suggested.priority ?? null,
      triageFinalPriority: admission.triage?.final.priority ?? null,
      triageRouteCheck: admission.triage?.final.routeCheck ?? null,
      ...(input.metadata ?? {}),
    },
  });

  if (!result) {
    throw new Error(`${input.name.trim()} event was rejected by queue filter`);
  }

  return {
    streamId: result.streamId,
    eventId: admission.eventId,
    priority: result.priority,
    triageMode: admission.triageMode,
    triage: admission.triage,
  };
}

export async function enqueueDiscoveryNoted(input: {
  url: string;
  context?: string;
  source: string;
  eventId?: string;
}): Promise<QueueAdmissionResult> {
  const data: Record<string, unknown> = { url: input.url };
  if (input.context?.trim()) {
    data.context = input.context.trim();
  }

  return enqueueRegisteredQueueEvent({
    name: "discovery/noted",
    data,
    source: input.source,
    eventId: input.eventId,
  });
}

export const __queueTestUtils = {
  buildQueueAdmissionEnvelope,
  deps: queueDeps,
  expandQueueTriageFamilies,
  parsePriorityOverride,
  parseQueueTriageMode,
  resetInitPromise() {
    initPromise = null;
  },
  resolveQueueTriageMode,
};
