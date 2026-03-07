import { randomUUID } from "node:crypto";
import {
  init,
  lookupQueueEvent,
  Priority,
  persist,
  type QueueConfig,
  type QueueEventEnvelope,
  type TelemetryEmitter,
} from "@joelclaw/queue";
import { emitOtelEvent } from "../observability/emit";
import { getRedisClient } from "./redis";

const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:system-bus",
  consumerName: "system-bus",
};

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

function parsePilotSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isQueuePilotEnabled(name: string): boolean {
  return parsePilotSet(process.env.QUEUE_PILOTS).has(name.trim().toLowerCase());
}

async function ensureQueueInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = init(getRedisClient(), QUEUE_CONFIG, { telemetry: queueTelemetry });
  }

  await initPromise;
}

export async function enqueueRegisteredQueueEvent(input: {
  name: string;
  data: Record<string, unknown>;
  source: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ streamId: string; eventId: string; priority: number }> {
  await ensureQueueInitialized();

  const eventName = input.name.trim();
  const registryEntry = lookupQueueEvent(eventName);
  if (!registryEntry) {
    throw new Error(`queue registry has no entry for ${eventName}`);
  }

  const priority = registryEntry.priority ?? Priority.P2;
  const eventId = input.eventId?.trim() || randomUUID();
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

  const result = await persist({
    payload: envelope as Record<string, unknown>,
    priority,
    metadata: {
      envelope_version: "1",
      source: input.source,
      ...(input.metadata ?? {}),
    },
  });

  if (!result) {
    throw new Error(`${eventName} event was rejected by queue filter`);
  }

  return {
    streamId: result.streamId,
    eventId,
    priority: result.priority,
  };
}

export async function enqueueDiscoveryNoted(input: {
  url: string;
  context?: string;
  source: string;
  eventId?: string;
}): Promise<{ streamId: string; eventId: string; priority: number }> {
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
