import type Redis from "ioredis";
import type {
  QueueControlConfig,
  QueueControlMode,
  QueueControlSource,
  QueueExpiredFamilyPauseState,
  QueueFamilyPauseState,
  QueueObserverAction,
  QueueResumeFamilyResult,
} from "./types";

export const DEFAULT_QUEUE_CONTROL_CONFIG: QueueControlConfig = {
  pauseStateKey: "joelclaw:queue:control:pauses",
  pauseExpiryKey: "joelclaw:queue:control:pause-expirations",
};

type QueueControlRedis = Pick<Redis, "hdel" | "hget" | "hgetall" | "hset" | "zadd" | "zrangebyscore" | "zrem">;

type PauseRecord = QueueFamilyPauseState;

function normalizeFamily(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Queue family is required");
  }
  return normalized;
}

function normalizeReason(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Queue control reason is required");
  }
  return normalized;
}

function parsePauseRecord(raw: string | null | undefined): PauseRecord | undefined {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<PauseRecord> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.kind !== "pause_family") return undefined;
    if (typeof parsed.family !== "string" || parsed.family.trim().length === 0) return undefined;
    if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) return undefined;
    if (typeof parsed.ttlMs !== "number" || !Number.isFinite(parsed.ttlMs) || parsed.ttlMs <= 0) return undefined;
    if (typeof parsed.appliedAt !== "string" || typeof parsed.expiresAt !== "string") return undefined;
    if (typeof parsed.appliedAtMs !== "number" || typeof parsed.expiresAtMs !== "number") return undefined;
    if (parsed.source !== "manual" && parsed.source !== "observer") return undefined;
    if (parsed.mode !== "manual" && parsed.mode !== "off" && parsed.mode !== "dry-run" && parsed.mode !== "enforce") {
      return undefined;
    }

    return {
      kind: "pause_family",
      family: parsed.family.trim(),
      ttlMs: Math.max(1, Math.round(parsed.ttlMs)),
      reason: parsed.reason.trim(),
      source: parsed.source,
      mode: parsed.mode,
      appliedAt: parsed.appliedAt,
      appliedAtMs: Math.round(parsed.appliedAtMs),
      expiresAt: parsed.expiresAt,
      expiresAtMs: Math.round(parsed.expiresAtMs),
      ...(typeof parsed.snapshotId === "string" && parsed.snapshotId.trim().length > 0
        ? { snapshotId: parsed.snapshotId.trim() }
        : {}),
      ...(typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? { model: parsed.model.trim() }
        : {}),
      ...(typeof parsed.actor === "string" && parsed.actor.trim().length > 0
        ? { actor: parsed.actor.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function serializePauseRecord(record: PauseRecord): string {
  return JSON.stringify(record);
}

export function pauseStateToControlAction(state: QueueFamilyPauseState): Extract<QueueObserverAction, { kind: "pause_family" }> {
  return {
    kind: "pause_family",
    family: state.family,
    ttlMs: state.ttlMs,
    reason: state.reason,
  };
}

export async function pauseQueueFamily(
  redis: QueueControlRedis,
  input: {
    family: string;
    ttlMs: number;
    reason: string;
    source?: QueueControlSource;
    mode?: QueueControlMode;
    snapshotId?: string;
    model?: string;
    actor?: string;
    now?: number;
    config?: QueueControlConfig;
  },
): Promise<QueueFamilyPauseState> {
  const config = input.config ?? DEFAULT_QUEUE_CONTROL_CONFIG;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const family = normalizeFamily(input.family);
  const ttlMs = Math.max(1, Math.round(input.ttlMs));
  const appliedAtMs = now;
  const expiresAtMs = appliedAtMs + ttlMs;

  const record: QueueFamilyPauseState = {
    kind: "pause_family",
    family,
    ttlMs,
    reason: normalizeReason(input.reason),
    source: input.source ?? "manual",
    mode: input.mode ?? "manual",
    appliedAt: new Date(appliedAtMs).toISOString(),
    appliedAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  };

  await redis.hset(config.pauseStateKey, family, serializePauseRecord(record));
  await redis.zadd(config.pauseExpiryKey, expiresAtMs, family);
  return record;
}

export async function resumeQueueFamily(
  redis: QueueControlRedis,
  input: {
    family: string;
    config?: QueueControlConfig;
  },
): Promise<QueueResumeFamilyResult> {
  const config = input.config ?? DEFAULT_QUEUE_CONTROL_CONFIG;
  const family = normalizeFamily(input.family);
  const existing = parsePauseRecord(await redis.hget(config.pauseStateKey, family));
  const removed = await redis.hdel(config.pauseStateKey, family);
  await redis.zrem(config.pauseExpiryKey, family);

  return {
    removed: removed > 0,
    ...(existing ? { pause: existing } : {}),
  };
}

export async function expireQueueFamilyPauses(
  redis: QueueControlRedis,
  input?: {
    now?: number;
    config?: QueueControlConfig;
  },
): Promise<QueueExpiredFamilyPauseState[]> {
  const config = input?.config ?? DEFAULT_QUEUE_CONTROL_CONFIG;
  const now = typeof input?.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const expiredFamilies = await redis.zrangebyscore(config.pauseExpiryKey, "-inf", String(now));
  const expired: QueueExpiredFamilyPauseState[] = [];

  for (const family of expiredFamilies) {
    const current = parsePauseRecord(await redis.hget(config.pauseStateKey, family));
    if (!current) {
      await redis.zrem(config.pauseExpiryKey, family);
      continue;
    }

    if (current.expiresAtMs > now) {
      continue;
    }

    const removed = await redis.hdel(config.pauseStateKey, family);
    await redis.zrem(config.pauseExpiryKey, family);

    if (removed > 0) {
      expired.push({
        ...current,
        expiredAt: new Date(now).toISOString(),
        expiredAtMs: now,
      });
    }
  }

  return expired.sort((a, b) => a.expiresAtMs - b.expiresAtMs || a.family.localeCompare(b.family));
}

export async function listActiveQueueFamilyPauses(
  redis: QueueControlRedis,
  input?: {
    now?: number;
    config?: QueueControlConfig;
  },
): Promise<QueueFamilyPauseState[]> {
  const config = input?.config ?? DEFAULT_QUEUE_CONTROL_CONFIG;
  const now = typeof input?.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const records = await redis.hgetall(config.pauseStateKey);

  return Object.values(records)
    .map((raw) => parsePauseRecord(raw))
    .filter((record): record is QueueFamilyPauseState => record !== undefined && record.expiresAtMs > now)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || a.family.localeCompare(b.family));
}

export function isQueueFamilyPaused(
  pauses: readonly QueueFamilyPauseState[],
  family: string,
): QueueFamilyPauseState | undefined {
  const normalized = normalizeFamily(family);
  return pauses.find((pause) => pause.family === normalized);
}
