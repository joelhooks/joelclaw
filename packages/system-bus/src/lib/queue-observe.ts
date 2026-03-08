import { randomUUID } from "node:crypto";
import {
  Priority,
  type QueueControlMode,
  type QueueObservationDecision,
  type QueueObservationDrainerSummary,
  type QueueObservationFallbackReason,
  type QueueObservationFindings,
  type QueueObservationGatewaySummary,
  type QueueObservationMode,
  type QueueObservationPressure,
  type QueueObservationSnapshot,
  type QueueObservationTriageSummary,
  type QueueObserverAction,
  type QueuePriorityCounts,
  type QueuePriorityLabel,
  type QueueTriageFallbackReason,
  type StoredMessage,
} from "@joelclaw/queue";
import { z } from "zod";
import { emitOtelEvent } from "../observability/emit";
import { infer } from "./inference";
import { MODEL } from "./models";

const QUEUE_OBSERVE_COMPONENT = "queue-observe";
const QUEUE_CONTROL_COMPONENT = "queue-control";
const DEFAULT_TIMEOUT_MS = 60_000;
const AUTO_APPLY_ACTION_KINDS = new Set<QueueObserverAction["kind"]>([
  "pause_family",
  "resume_family",
  "escalate",
]);
const PRIORITY_LABELS: QueuePriorityLabel[] = ["P0", "P1", "P2", "P3"];

export const QUEUE_OBSERVE_MODEL = MODEL.SONNET;

export const QUEUE_OBSERVE_SYSTEM_PROMPT = `You are the bounded queue observer for JoelClaw.

You are reviewing a canonical queue snapshot assembled by deterministic code.
You may only return:
- findings.queuePressure: healthy | degraded | backlogged
- findings.downstreamState: healthy | degraded | down
- findings.summary: one short paragraph
- actions: a JSON array of bounded actions from this enum:
  - noop
  - pause_family
  - resume_family
  - reprioritize_family
  - batch_family
  - shed_family
  - escalate

Hard rules:
- Never invent a family that is not present in the supplied snapshot.
- Never invent a new action kind.
- Never describe direct Redis writes, route overrides, or handler overrides.
- Keep reasons concise and concrete.
- Use noop when no action is warranted.
- pause_family and batch_family ttlMs must stay between 60000 and 86400000.
- escalate is reporting only; use channel=telegram.

Respond with ONLY valid JSON:
{
  "findings": {
    "queuePressure": "healthy|degraded|backlogged",
    "downstreamState": "healthy|degraded|down",
    "summary": "one short paragraph"
  },
  "actions": [
    { "kind": "noop", "reason": "..." }
  ]
}`;

const BaseReasonSchema = z.string().trim().min(1).max(280);
const FamilySchema = z.string().trim().min(1).max(160);

const QueueObserverActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("noop"),
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("pause_family"),
    family: FamilySchema,
    ttlMs: z.number().int().min(60_000).max(86_400_000),
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("resume_family"),
    family: FamilySchema,
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("reprioritize_family"),
    family: FamilySchema,
    priority: z.enum(PRIORITY_LABELS),
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("batch_family"),
    family: FamilySchema,
    ttlMs: z.number().int().min(60_000).max(86_400_000),
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("shed_family"),
    family: FamilySchema,
    reason: BaseReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("escalate"),
    channel: z.literal("telegram"),
    severity: z.enum(["info", "warn", "error"]),
    message: z.string().trim().min(1).max(500),
  }).strict(),
]);

const QueueObserveOutputSchema = z.object({
  findings: z.object({
    queuePressure: z.enum(["healthy", "degraded", "backlogged"]),
    downstreamState: z.enum(["healthy", "degraded", "down"]),
    summary: z.string().trim().min(1).max(500),
  }).strict(),
  actions: z.array(QueueObserverActionSchema).max(8),
}).strict();

type QueueObserveOutput = z.infer<typeof QueueObserveOutputSchema>;

type QueueObserveParseResult =
  | { ok: true; value: QueueObserveOutput }
  | { ok: false; reason: QueueObservationFallbackReason; error: string };

export type BuildQueueObservationSnapshotInput = {
  snapshotId?: string;
  capturedAt?: string;
  now?: number;
  stats: {
    total: number;
    byPriority?: Partial<QueuePriorityCounts>;
    oldestTimestamp?: number | null;
    newestTimestamp?: number | null;
  };
  messages: ReadonlyArray<Pick<StoredMessage, "payload" | "priority" | "timestamp">>;
  triage?: Partial<QueueObservationTriageSummary>;
  drainer?: Partial<QueueObservationDrainerSummary>;
  gateway?: Partial<QueueObservationGatewaySummary>;
};

export type ObserveQueueSnapshotInput = {
  mode: QueueObservationMode;
  snapshot: QueueObservationSnapshot;
  autoApplyFamilies?: Iterable<string>;
  timeoutMs?: number;
  model?: string;
};

function emptyPriorityCounts(): QueuePriorityCounts {
  return {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
}

function normalizePriorityCounts(input?: Partial<QueuePriorityCounts> | null): QueuePriorityCounts {
  const counts = emptyPriorityCounts();
  if (!input) return counts;

  for (const label of PRIORITY_LABELS) {
    const raw = input[label];
    counts[label] = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  return counts;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function ageFromTimestamp(timestamp: number | null | undefined, now: number): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return Math.max(0, now - timestamp);
}

function priorityLabelFromPriority(priority: Priority): QueuePriorityLabel {
  if (priority === Priority.P0) return "P0";
  if (priority === Priority.P1) return "P1";
  if (priority === Priority.P2) return "P2";
  return "P3";
}

function normalizeFamilyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function messageFamily(message: Pick<StoredMessage, "payload">): string {
  return normalizeFamilyName(message.payload?.name) ?? "unknown";
}

function percentile(values: readonly number[], target: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((target / 100) * ordered.length) - 1));
  return ordered[index] ?? null;
}

export function buildQueueObservationSnapshot(input: BuildQueueObservationSnapshotInput): QueueObservationSnapshot {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const familyMap = new Map<string, {
    family: string;
    total: number;
    byPriority: QueuePriorityCounts;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  }>();

  for (const message of input.messages) {
    const family = messageFamily(message);
    const entry = familyMap.get(family) ?? {
      family,
      total: 0,
      byPriority: emptyPriorityCounts(),
      oldestTimestamp: null,
      newestTimestamp: null,
    };

    entry.total += 1;
    entry.byPriority[priorityLabelFromPriority(message.priority)] += 1;
    entry.oldestTimestamp = entry.oldestTimestamp == null
      ? message.timestamp
      : Math.min(entry.oldestTimestamp, message.timestamp);
    entry.newestTimestamp = entry.newestTimestamp == null
      ? message.timestamp
      : Math.max(entry.newestTimestamp, message.timestamp);
    familyMap.set(family, entry);
  }

  const families = [...familyMap.values()]
    .map((entry) => ({
      family: entry.family,
      total: entry.total,
      byPriority: entry.byPriority,
      oldestAgeMs: ageFromTimestamp(entry.oldestTimestamp, now),
      newestAgeMs: ageFromTimestamp(entry.newestTimestamp, now),
    }))
    .sort((a, b) => b.total - a.total || b.oldestAgeMs! - a.oldestAgeMs! || a.family.localeCompare(b.family));

  const triageLatency = input.triage?.latencyMs;
  const triageFallbackByReason = input.triage?.fallbackByReason ?? {};

  return {
    snapshotId: input.snapshotId?.trim() || randomUUID(),
    capturedAt: input.capturedAt ?? new Date(now).toISOString(),
    totals: {
      depth: Math.max(0, Math.round(asFiniteNumber(input.stats.total))),
      byPriority: normalizePriorityCounts(input.stats.byPriority),
      oldestAgeMs: ageFromTimestamp(normalizeTimestamp(input.stats.oldestTimestamp), now),
      newestAgeMs: ageFromTimestamp(normalizeTimestamp(input.stats.newestTimestamp), now),
    },
    families,
    triage: {
      attempts: Math.max(0, Math.round(asFiniteNumber(input.triage?.attempts))),
      completed: Math.max(0, Math.round(asFiniteNumber(input.triage?.completed))),
      failed: Math.max(0, Math.round(asFiniteNumber(input.triage?.failed))),
      fallbacks: Math.max(0, Math.round(asFiniteNumber(input.triage?.fallbacks))),
      fallbackByReason: Object.fromEntries(
        Object.entries(triageFallbackByReason).map(([reason, value]) => [reason, Math.max(0, Math.round(asFiniteNumber(value)))]),
      ) as Partial<Record<QueueTriageFallbackReason, number>>,
      routeMismatches: Math.max(0, Math.round(asFiniteNumber(input.triage?.routeMismatches))),
      latencyMs: {
        p50: triageLatency?.p50 ?? null,
        p95: triageLatency?.p95 ?? null,
      },
    },
    drainer: {
      state: input.drainer?.state ?? "healthy",
      recentDispatches: Math.max(0, Math.round(asFiniteNumber(input.drainer?.recentDispatches))),
      recentFailures: Math.max(0, Math.round(asFiniteNumber(input.drainer?.recentFailures))),
      throughputPerMinute: typeof input.drainer?.throughputPerMinute === "number" && Number.isFinite(input.drainer.throughputPerMinute)
        ? input.drainer.throughputPerMinute
        : null,
    },
    gateway: {
      sleepMode: input.gateway?.sleepMode ?? false,
      quietHours: input.gateway?.quietHours ?? null,
      mutedChannels: [...new Set((input.gateway?.mutedChannels ?? []).map((value) => value.trim()).filter(Boolean))].sort(),
    },
  };
}

function deriveQueuePressure(snapshot: QueueObservationSnapshot): QueueObservationPressure {
  const oldestAgeMs = snapshot.totals.oldestAgeMs ?? 0;
  if (snapshot.totals.depth >= 25 || oldestAgeMs >= 15 * 60_000) {
    return "backlogged";
  }
  if (snapshot.totals.depth >= 5 || oldestAgeMs >= 5 * 60_000 || snapshot.triage.fallbacks > 0) {
    return "degraded";
  }
  return "healthy";
}

function deriveDownstreamState(snapshot: QueueObservationSnapshot): QueueObservationFindings["downstreamState"] {
  if (snapshot.drainer.state === "down") return "down";
  if (snapshot.drainer.state === "degraded" || snapshot.drainer.recentFailures > 0) {
    return "degraded";
  }
  return "healthy";
}

function deriveDefaultFindings(
  snapshot: QueueObservationSnapshot,
  fallbackReason?: QueueObservationFallbackReason,
): QueueObservationFindings {
  const queuePressure = deriveQueuePressure(snapshot);
  const downstreamState = deriveDownstreamState(snapshot);
  const fragments = [
    `Queue depth ${snapshot.totals.depth}`,
    `pressure ${queuePressure}`,
    `downstream ${downstreamState}`,
    `${snapshot.families.length} active families`,
  ];

  if (fallbackReason) {
    fragments.push(`observer fallback ${fallbackReason}`);
  }

  return {
    queuePressure,
    downstreamState,
    summary: fragments.join("; "),
  };
}

function parseJsonCandidate(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates = [
    trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1],
    trimmed,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }

  return null;
}

function actionFamily(action: QueueObserverAction): string | null {
  switch (action.kind) {
    case "pause_family":
    case "resume_family":
    case "reprioritize_family":
    case "batch_family":
    case "shed_family":
      return action.family;
    default:
      return null;
  }
}

function validateActionFamilies(
  actions: readonly QueueObserverAction[],
  snapshot: QueueObservationSnapshot,
): string[] {
  const allowedFamilies = new Set(snapshot.families.map((family) => family.family));
  return actions
    .map(actionFamily)
    .filter((family): family is string => typeof family === "string")
    .filter((family) => !allowedFamilies.has(family));
}

export function parseQueueObservationOutput(
  raw: string,
  snapshot: QueueObservationSnapshot,
): QueueObserveParseResult {
  const parsed = parseJsonCandidate(raw);
  if (!parsed) {
    return {
      ok: false,
      reason: "invalid_json",
      error: "Queue observer returned invalid JSON",
    };
  }

  const result = QueueObserveOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema_error",
      error: result.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  const actions = result.data.actions as QueueObserverAction[];
  const invalidFamilies = validateActionFamilies(actions, snapshot);
  if (invalidFamilies.length > 0) {
    return {
      ok: false,
      reason: "unsafe_action",
      error: `Queue observer referenced non-snapshot families: ${invalidFamilies.join(", ")}`,
    };
  }

  return {
    ok: true,
    value: {
      findings: result.data.findings,
      actions,
    },
  };
}

export function fallbackReasonFromError(error: unknown): QueueObservationFallbackReason {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  return "model_error";
}

function normalizeFamilies(values: Iterable<string> | undefined): Set<string> {
  return new Set(
    [...(values ?? [])]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function selectFinalActions(input: {
  mode: QueueObservationMode;
  actions: readonly QueueObserverAction[];
  autoApplyFamilies: Set<string>;
}): QueueObserverAction[] {
  if (input.mode !== "enforce") return [];

  return input.actions.filter((action) => {
    if (!AUTO_APPLY_ACTION_KINDS.has(action.kind)) {
      return false;
    }

    if (action.kind === "escalate") {
      return true;
    }

    const family = actionFamily(action);
    return typeof family === "string" && input.autoApplyFamilies.has(family);
  });
}

function buildFallbackDecision(input: {
  mode: QueueObservationMode;
  snapshot: QueueObservationSnapshot;
  model?: string;
  latencyMs: number;
  fallbackReason: QueueObservationFallbackReason;
}): QueueObservationDecision {
  return {
    mode: input.mode,
    model: input.model,
    snapshotId: input.snapshot.snapshotId,
    findings: deriveDefaultFindings(input.snapshot, input.fallbackReason),
    suggestedActions: [],
    finalActions: [],
    appliedCount: 0,
    fallbackReason: input.fallbackReason,
    latencyMs: input.latencyMs,
  };
}

function shouldUseDeterministicNoop(snapshot: QueueObservationSnapshot): boolean {
  return snapshot.totals.depth === 0 && snapshot.families.length === 0;
}

function buildDeterministicNoopDecision(input: {
  mode: QueueObservationMode;
  snapshot: QueueObservationSnapshot;
  model?: string;
  latencyMs: number;
  reason: string;
}): QueueObservationDecision {
  return {
    mode: input.mode,
    model: input.model,
    snapshotId: input.snapshot.snapshotId,
    findings: deriveDefaultFindings(input.snapshot),
    suggestedActions: [{ kind: "noop", reason: input.reason }],
    finalActions: [],
    appliedCount: 0,
    latencyMs: input.latencyMs,
  };
}

function buildUserPrompt(input: {
  snapshot: QueueObservationSnapshot;
  mode: QueueObservationMode;
  autoApplyFamilies: Set<string>;
}): string {
  return [
    `Observation mode: ${input.mode}`,
    `Snapshot id: ${input.snapshot.snapshotId}`,
    `Auto-apply families in this run: ${input.autoApplyFamilies.size > 0 ? [...input.autoApplyFamilies].join(", ") : "none"}`,
    "Queue snapshot JSON:",
    JSON.stringify(input.snapshot, null, 2),
  ].join("\n");
}

function summarizeActionKinds(actions: readonly QueueObserverAction[]): string[] {
  return [...new Set(actions.map((action) => action.kind))].sort();
}

function serializeActionMetadata(action: QueueObserverAction): Record<string, unknown> {
  switch (action.kind) {
    case "noop":
      return { kind: action.kind, reason: action.reason };
    case "pause_family":
    case "batch_family":
      return { kind: action.kind, family: action.family, ttlMs: action.ttlMs, reason: action.reason };
    case "resume_family":
    case "shed_family":
      return { kind: action.kind, family: action.family, reason: action.reason };
    case "reprioritize_family":
      return { kind: action.kind, family: action.family, priority: action.priority, reason: action.reason };
    case "escalate":
      return { kind: action.kind, channel: action.channel, severity: action.severity, message: action.message };
  }
}

async function emitQueueObserveStarted(input: {
  snapshot: QueueObservationSnapshot;
  mode: QueueObservationMode;
  model: string;
  autoApplyFamilies: Set<string>;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_OBSERVE_COMPONENT,
    action: "queue.observe.started",
    success: true,
    metadata: {
      snapshotId: input.snapshot.snapshotId,
      mode: input.mode,
      model: input.model,
      depth: input.snapshot.totals.depth,
      familyCount: input.snapshot.families.length,
      autoApplyFamilies: [...input.autoApplyFamilies].sort(),
    },
  });
}

async function emitQueueObserveCompleted(input: {
  decision: QueueObservationDecision;
  autoApplyFamilies: Set<string>;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_OBSERVE_COMPONENT,
    action: "queue.observe.completed",
    success: true,
    duration_ms: input.decision.latencyMs,
    metadata: {
      snapshotId: input.decision.snapshotId,
      mode: input.decision.mode,
      model: input.decision.model ?? null,
      queuePressure: input.decision.findings.queuePressure,
      downstreamState: input.decision.findings.downstreamState,
      summary: input.decision.findings.summary,
      suggestedCount: input.decision.suggestedActions.length,
      finalCount: input.decision.finalActions.length,
      appliedCount: input.decision.appliedCount,
      suggestedActionKinds: summarizeActionKinds(input.decision.suggestedActions),
      finalActionKinds: summarizeActionKinds(input.decision.finalActions),
      autoApplyFamilies: [...input.autoApplyFamilies].sort(),
      fallbackReason: input.decision.fallbackReason ?? null,
      latencyMs: input.decision.latencyMs,
    },
  });
}

async function emitQueueObserveFailed(input: {
  snapshot: QueueObservationSnapshot;
  mode: QueueObservationMode;
  model: string;
  error: string;
  latencyMs: number;
}): Promise<void> {
  await emitOtelEvent({
    level: "error",
    source: "worker",
    component: QUEUE_OBSERVE_COMPONENT,
    action: "queue.observe.failed",
    success: false,
    error: input.error,
    duration_ms: input.latencyMs,
    metadata: {
      snapshotId: input.snapshot.snapshotId,
      mode: input.mode,
      model: input.model,
      depth: input.snapshot.totals.depth,
      familyCount: input.snapshot.families.length,
      latencyMs: input.latencyMs,
    },
  });
}

async function emitQueueObserveFallback(input: {
  decision: QueueObservationDecision;
}): Promise<void> {
  const degraded = input.decision.fallbackReason && input.decision.fallbackReason !== "disabled";
  await emitOtelEvent({
    level: degraded ? "warn" : "info",
    source: "worker",
    component: QUEUE_OBSERVE_COMPONENT,
    action: "queue.observe.fallback",
    success: !degraded,
    error: degraded ? input.decision.fallbackReason : undefined,
    duration_ms: input.decision.latencyMs,
    metadata: {
      snapshotId: input.decision.snapshotId,
      mode: input.decision.mode,
      model: input.decision.model ?? null,
      fallbackReason: input.decision.fallbackReason ?? null,
      queuePressure: input.decision.findings.queuePressure,
      downstreamState: input.decision.findings.downstreamState,
      summary: input.decision.findings.summary,
      latencyMs: input.decision.latencyMs,
    },
  });
}

export async function emitQueueControlApplied(input: {
  snapshotId: string;
  mode: QueueControlMode;
  action: QueueObserverAction;
  model?: string;
  expiresAt?: string | null;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_CONTROL_COMPONENT,
    action: "queue.control.applied",
    success: true,
    metadata: {
      snapshotId: input.snapshotId,
      mode: input.mode,
      model: input.model ?? null,
      expiresAt: input.expiresAt ?? null,
      action: serializeActionMetadata(input.action),
    },
  });
}

export async function emitQueueControlExpired(input: {
  snapshotId: string;
  action: QueueObserverAction;
  expiredAt?: string | null;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_CONTROL_COMPONENT,
    action: "queue.control.expired",
    success: true,
    metadata: {
      snapshotId: input.snapshotId,
      expiredAt: input.expiredAt ?? null,
      action: serializeActionMetadata(input.action),
    },
  });
}

export async function emitQueueControlRejected(input: {
  snapshotId: string;
  mode: QueueControlMode;
  action: QueueObserverAction;
  reason: string;
  model?: string;
}): Promise<void> {
  await emitOtelEvent({
    level: "warn",
    source: "worker",
    component: QUEUE_CONTROL_COMPONENT,
    action: "queue.control.rejected",
    success: false,
    error: input.reason,
    metadata: {
      snapshotId: input.snapshotId,
      mode: input.mode,
      model: input.model ?? null,
      action: serializeActionMetadata(input.action),
      reason: input.reason,
    },
  });
}

export async function observeQueueSnapshot(input: ObserveQueueSnapshotInput): Promise<QueueObservationDecision> {
  const startedAt = Date.now();
  const model = input.model ?? QUEUE_OBSERVE_MODEL;
  const autoApplyFamilies = normalizeFamilies(input.autoApplyFamilies);

  if (input.mode === "off") {
    const decision = buildFallbackDecision({
      mode: input.mode,
      snapshot: input.snapshot,
      model,
      latencyMs: 0,
      fallbackReason: "disabled",
    });

    await emitQueueObserveFallback({ decision });
    return decision;
  }

  await emitQueueObserveStarted({
    snapshot: input.snapshot,
    mode: input.mode,
    model,
    autoApplyFamilies,
  });

  if (shouldUseDeterministicNoop(input.snapshot)) {
    const decision = buildDeterministicNoopDecision({
      mode: input.mode,
      snapshot: input.snapshot,
      latencyMs: Date.now() - startedAt,
      reason: "Queue is empty; no queue control action is warranted.",
    });

    await emitQueueObserveCompleted({
      decision,
      autoApplyFamilies,
    });
    return decision;
  }

  try {
    const result = await infer(buildUserPrompt({
      snapshot: input.snapshot,
      mode: input.mode,
      autoApplyFamilies,
    }), {
      model,
      timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      system: QUEUE_OBSERVE_SYSTEM_PROMPT,
      json: true,
      requireJson: true,
      requireTextOutput: true,
      component: QUEUE_OBSERVE_COMPONENT,
      action: "queue.observe.infer",
      metadata: {
        snapshotId: input.snapshot.snapshotId,
        mode: input.mode,
      },
    });

    const parsed = parseQueueObservationOutput(result.text, input.snapshot);
    const latencyMs = Date.now() - startedAt;

    if (!parsed.ok) {
      await emitQueueObserveFailed({
        snapshot: input.snapshot,
        mode: input.mode,
        model: result.model ?? model,
        error: parsed.error,
        latencyMs,
      });

      const decision = buildFallbackDecision({
        mode: input.mode,
        snapshot: input.snapshot,
        model: result.model ?? model,
        latencyMs,
        fallbackReason: parsed.reason,
      });
      await emitQueueObserveFallback({ decision });
      return decision;
    }

    const finalActions = selectFinalActions({
      mode: input.mode,
      actions: parsed.value.actions as QueueObserverAction[],
      autoApplyFamilies,
    });

    const decision: QueueObservationDecision = {
      mode: input.mode,
      model: result.model ?? model,
      snapshotId: input.snapshot.snapshotId,
      findings: parsed.value.findings,
      suggestedActions: parsed.value.actions as QueueObserverAction[],
      finalActions,
      appliedCount: 0,
      latencyMs,
    };

    await emitQueueObserveCompleted({
      decision,
      autoApplyFamilies,
    });
    return decision;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const fallbackReason = fallbackReasonFromError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    await emitQueueObserveFailed({
      snapshot: input.snapshot,
      mode: input.mode,
      model,
      error: errorMessage,
      latencyMs,
    });

    const decision = buildFallbackDecision({
      mode: input.mode,
      snapshot: input.snapshot,
      model,
      latencyMs,
      fallbackReason,
    });
    await emitQueueObserveFallback({ decision });
    return decision;
  }
}

export const __queueObserveTestUtils = {
  buildUserPrompt,
  deriveDefaultFindings,
  fallbackReasonFromError,
  parseQueueObservationOutput,
  percentile,
  selectFinalActions,
};
