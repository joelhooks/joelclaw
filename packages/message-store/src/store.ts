import { createHash } from "node:crypto";
import type { CandidateMessage as QueueCandidateMessage } from "@joelclaw/queue";
import {Priority, 
  Priority as QueuePriority,
  ack as queueAck,
  drainByPriority as queueDrainByPriority,
  getUnacked as queueGetUnacked,
  indexMessagesByPriority as queueIndexMessagesByPriority,
  init as queueInit,
  persist as queuePersist,
  trimOld as queueTrimOld
} from "@joelclaw/queue";
import type Redis from "ioredis";
import type {
  DrainByPriorityOptions,
  InboundMessage,
  PersistResult,
  StoredMessage,
  TelemetryEmitter,
} from "./types";

const GATEWAY_STREAM_KEY = "joelclaw:gateway:messages";
const GATEWAY_PRIORITY_KEY = "joelclaw:gateway:priority";
const DEDUP_KEY_PREFIX = "joelclaw:gateway:dedup:";
const CONSUMER_GROUP = "gateway-session";
const CONSUMER_NAME = "daemon";
const DEDUP_WINDOW_SECONDS = 30;
const AGING_PROMOTION_MS = 5 * 60 * 1000;
const P3_AUTO_ACK_MS = 60 * 1000;
const P3_COALESCE_MS = 60 * 1000;

let redisClient: Redis | undefined;
let p0DrainStreak = 0;
let telemetryEmitter: TelemetryEmitter = {
  emit: () => {},
};

function emitMessageStoreTelemetry(action: string, detail: string, extra?: Record<string, unknown>): void {
  telemetryEmitter.emit(action, detail, {
    ...(extra ?? {}),
  });
}

function getClient(): Redis {
  if (!redisClient) {
    throw new Error("[gateway:store] redis client not initialized");
  }
  return redisClient;
}

function priorityName(priority: number): "P0" | "P1" | "P2" | "P3" {
  if (priority === Priority.P0) return "P0";
  if (priority === Priority.P1) return "P1";
  if (priority === Priority.P2) return "P2";
  return "P3";
}

function stripInjectedChannelContext(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("---\nChannel:")) {
    return trimmed;
  }

  const contextEnd = trimmed.indexOf("\n---\n", 4);
  if (contextEnd === -1) {
    return trimmed;
  }

  const body = trimmed.slice(contextEnd + "\n---\n".length).trim();
  return body || trimmed;
}

function normalizePromptForDedup(prompt: string): {
  normalizedBody: string;
  strippedInjectedContext: boolean;
} {
  const trimmed = prompt.trim();
  const stripped = stripInjectedChannelContext(prompt);
  return {
    normalizedBody: stripped.replace(/\s+/g, " ").trim(),
    strippedInjectedContext: stripped !== trimmed,
  };
}

function hashDedupKey(source: string, prompt: string): string {
  const { normalizedBody } = normalizePromptForDedup(prompt);
  return createHash("sha256")
    .update(source)
    .update("\n")
    .update(normalizedBody)
    .digest("hex");
}

function extractEventHints(metadata?: Record<string, unknown>): string[] {
  if (!metadata) return [];
  const out: string[] = [];

  const pushEvent = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed.length > 0) out.push(trimmed);
        }
      }
    }
  };

  pushEvent(metadata.event);
  pushEvent(metadata.eventType);
  pushEvent(metadata.type);
  pushEvent(metadata.eventTypes);

  const digestTypes = metadata.digestTypes;
  if (digestTypes && typeof digestTypes === "object" && !Array.isArray(digestTypes)) {
    out.push(...Object.keys(digestTypes));
  }

  return out;
}

/**
 * Classify priority for an inbound gateway message.
 * Gateway-specific logic based on source and event hints.
 */
export function classifyPriority(msg: InboundMessage): number {
  const prompt = msg.prompt.trim();
  const lowerSource = msg.source.toLowerCase();
  const eventHints = Array.isArray(msg.event)
    ? msg.event
    : (typeof msg.event === "string" ? [msg.event] : []);
  const lowerHints = eventHints.map((event) => event.toLowerCase());

  if (prompt.startsWith("/")) return Priority.P0;
  if (msg.source === "callback_query") return Priority.P0;

  if (lowerSource === "telegram" || lowerSource.startsWith("telegram:") || lowerSource.startsWith("telegram.") || lowerHints.some((event) => event.includes("telegram.human"))) {
    return Priority.P1;
  }
  if (lowerSource === "imessage" || lowerSource.startsWith("imessage:") || lowerSource.startsWith("imessage.") || lowerHints.some((event) => event.includes("imessage.human"))) {
    return Priority.P1;
  }
  if (lowerHints.some((event) => /deploy\.failed|friction-fix/u.test(event))) {
    return Priority.P1;
  }
  if (lowerSource === "heartbeat" || lowerHints.some((event) => /heartbeat|cron\.heartbeat/u.test(event))) {
    return Priority.P2;
  }

  return Priority.P3;
}

/**
 * Initialize the message store with Redis client.
 * Sets up the gateway queue using @joelclaw/queue.
 */
export async function init(redis: Redis, telemetry?: TelemetryEmitter): Promise<void> {
  telemetryEmitter = telemetry ?? { emit: () => {} };
  redisClient = redis;

  await queueInit(redis, {
    streamKey: GATEWAY_STREAM_KEY,
    priorityKey: GATEWAY_PRIORITY_KEY,
    consumerGroup: CONSUMER_GROUP,
    consumerName: CONSUMER_NAME,
    maxUnackedAge: 10 * 60 * 1000, // 10 minutes
    maxArchiveAge: 24 * 60 * 60 * 1000, // 24 hours
  }, { telemetry });

  console.log("[gateway:store] initialized gateway message queue");
}

/**
 * Persist an inbound gateway message.
 * Applies dedup, priority classification, and channels to the generic queue.
 *
 * Returns null if the message is deduplicated, PersistResult otherwise.
 */
export async function persist(msg: {
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}): Promise<PersistResult | null> {
  const redis = getClient();
  const timestamp = Date.now();
  const metadata = msg.metadata ? JSON.stringify(msg.metadata) : "";
  const priority = classifyPriority({
    source: msg.source,
    prompt: msg.prompt,
    metadata: msg.metadata,
    event: extractEventHints(msg.metadata),
  });

  // Check dedup before queuing
  const { normalizedBody, strippedInjectedContext } = normalizePromptForDedup(msg.prompt);
  const dedupHash = hashDedupKey(msg.source, msg.prompt);
  const dedupKey = `${DEDUP_KEY_PREFIX}${dedupHash}`;
  const dedupResult = await redis.set(dedupKey, "1", "EX", DEDUP_WINDOW_SECONDS, "NX");

  if (dedupResult !== "OK") {
    emitMessageStoreTelemetry("message.dedup_dropped", "debug", {
      source: msg.source,
      message_source: msg.source,
      priority,
      priority_label: priorityName(priority),
      dedup_layer: "message-store",
      dedup_window_seconds: DEDUP_WINDOW_SECONDS,
      dedup_hash_prefix: dedupHash.slice(0, 12),
      prompt_length: msg.prompt.length,
      normalized_length: normalizedBody.length,
      stripped_injected_context: strippedInjectedContext,
    });

    console.log("[gateway:store] dropped duplicate inbound message", {
      source: msg.source,
      dedupWindowSeconds: DEDUP_WINDOW_SECONDS,
      dedupHashPrefix: dedupHash.slice(0, 12),
      strippedInjectedContext,
    });
    return null;
  }

  // Persist to queue with gateway-specific payload
  const result = await queuePersist({
    payload: {
      source: msg.source,
      prompt: msg.prompt,
    },
    priority: priority as QueuePriority,
    metadata: msg.metadata,
  });

  if (!result) {
    return null;
  }

  emitMessageStoreTelemetry("message.queued", "debug", {
    source: msg.source,
    streamId: result.streamId,
    priority,
    priority_label: priorityName(priority),
    wait_time_ms: 0,
  });

  console.log("[gateway:store] persisted inbound message", {
    streamId: result.streamId,
    source: msg.source,
    priority: priorityName(priority),
  });

  return { streamId: result.streamId, priority };
}

/**
 * Acknowledge a message (mark resolved and delete from queue).
 */
export async function ack(streamId: string): Promise<void> {
  await queueAck(streamId);
}

/**
 * Get unacked messages that should be replayed.
 */
export async function getUnacked(maxAgeMs: number = 10 * 60 * 1000): Promise<StoredMessage[]> {
  const queuedMessages = await queueGetUnacked(maxAgeMs);
  return queuedMessages.map((msg) => ({
    id: msg.id,
    source: msg.payload.source as string,
    prompt: msg.payload.prompt as string,
    metadata: msg.metadata,
    timestamp: msg.timestamp,
    priority: msg.priority,
    acked: msg.acked,
  }));
}

/**
 * Re-index messages by priority.
 */
export async function indexMessagesByPriority(messages: StoredMessage[]): Promise<number> {
  const queueMessages = messages.map((msg) => ({
    id: msg.id,
    payload: {
      source: msg.source,
      prompt: msg.prompt,
    },
    metadata: msg.metadata,
    timestamp: msg.timestamp,
    priority: msg.priority as QueuePriority,
    acked: msg.acked,
  }));
  return queueIndexMessagesByPriority(queueMessages);
}

/**
 * Drain messages with gateway-specific behavior:
 * - P0 drain streak (after 3 P0s, allow a lower priority)
 * - P3 coalescing (combine multiple P3s within a window)
 * - Aging promotion
 */
export async function drainByPriority(options?: DrainByPriorityOptions): Promise<StoredMessage[]> {
  const excludeIds = new Set<string>(options?.excludeIds ?? []);
  const limit = Math.max(1, options?.limit ?? 1);
  const drained: StoredMessage[] = [];

  while (drained.length < limit) {
    const now = Date.now();

    // Get candidates from queue
    const candidates = await queueDrainByPriority({
      limit: 256,
      excludeIds: excludeIds,
      agingPromotionMs: AGING_PROMOTION_MS,
    });

    if (candidates.length === 0) break;

    // Apply P0 drain streak logic
    let selected = candidates[0];
    if (selected && selected.effectivePriority !== Priority.P0) {
      p0DrainStreak = 0;
    } else if (selected) {
      const lower = candidates.find((c) => c.effectivePriority !== Priority.P0);
      if (lower && p0DrainStreak >= 3) {
        p0DrainStreak = 0;
        selected = lower;
      } else {
        p0DrainStreak += 1;
      }
    }

    if (!selected) break;

    // Apply P3 coalescing
    const message = await coalesceP3Message(selected, candidates, now);
    const finalCandidate = candidates.find((c) => c.message.id === message.id) ?? selected;

    if (finalCandidate.promotedFrom !== undefined) {
      emitMessageStoreTelemetry("message.promoted", "info", {
        streamId: finalCandidate.message.id,
        source: message.source,
        priority: finalCandidate.effectivePriority,
        priority_label: priorityName(finalCandidate.effectivePriority),
        previous_priority: finalCandidate.promotedFrom,
        previous_priority_label: priorityName(finalCandidate.promotedFrom),
        wait_time_ms: finalCandidate.waitTimeMs,
      });
    }

    drained.push({
      id: message.id,
      source: message.source,
      prompt: message.prompt,
      metadata: message.metadata,
      timestamp: message.timestamp,
      priority: finalCandidate.effectivePriority,
      acked: message.acked,
    });

    excludeIds.add(message.id);
  }

  return drained;
}

async function coalesceP3Message(
  selected: QueueCandidateMessage,
  candidates: QueueCandidateMessage[],
  now: number,
): Promise<{
  id: string;
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  acked: boolean;
}> {
  const selectedMsg = {
    id: selected.message.id,
    source: selected.message.payload.source as string,
    prompt: selected.message.payload.prompt as string,
    metadata: selected.message.metadata,
    timestamp: selected.message.timestamp,
    acked: selected.message.acked,
  };

  if (selected.message.priority !== Priority.P3) return selectedMsg;

  const coalescible = candidates
    .filter((candidate) =>
      candidate.message.priority === Priority.P3
      && Math.max(0, now - candidate.message.timestamp) <= P3_COALESCE_MS,
    )
    .sort((a, b) => a.message.timestamp - b.message.timestamp);

  if (coalescible.length <= 1) return selectedMsg;

  const keeper = coalescible[0];
  if (!keeper) return selectedMsg;

  const suppressed = coalescible.filter((candidate) => candidate.message.id !== keeper.message.id);
  for (const item of suppressed) {
    await ack(item.message.id);
  }

  const coalescedCount = coalescible.length;
  const summary = {
    id: keeper.message.id,
    source: keeper.message.payload.source as string,
    prompt: `${coalescedCount} probe events suppressed`,
    metadata: {
      ...(keeper.message.metadata ?? {}),
      coalescedCount,
      coalescedIds: coalescible.map((candidate) => candidate.message.id),
    },
    timestamp: keeper.message.timestamp,
    acked: keeper.message.acked,
  };

  emitMessageStoreTelemetry("message.coalesced", "info", {
    streamId: keeper.message.id,
    priority: keeper.message.priority,
    priority_label: priorityName(keeper.message.priority),
    wait_time_ms: Math.max(0, now - keeper.message.timestamp),
    coalescedCount,
  });

  return summary;
}

/**
 * Trim old acked messages from the queue.
 */
export async function trimOld(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
  return queueTrimOld(maxAge);
}

export const __messageStoreTestUtils = {
  stripInjectedChannelContext,
  normalizePromptForDedup,
  hashDedupKey,
};
