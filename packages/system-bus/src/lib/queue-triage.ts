import {
  lookupQueueEvent,
  Priority,
  type QueueEventEnvelope,
  type QueuePriorityLabel,
  type QueueRouteCheck,
  type QueueTriageDecision,
  type QueueTriageFallbackReason,
  type QueueTriageMode,
  type QueueTriageOutcome,
} from "@joelclaw/queue";
import { z } from "zod";
import { emitOtelEvent } from "../observability/emit";
import { infer } from "./inference";
import { MODEL } from "./models";

const QUEUE_TRIAGE_COMPONENT = "queue-triage";
const DEFAULT_TIMEOUT_MS = 45_000;
const FORBIDDEN_OVERRIDE_KEYS = [
  "routeTarget",
  "handlerTarget",
  "handler",
  "target",
  "routeOverride",
  "eventName",
] as const;

export const QUEUE_TRIAGE_MODEL = MODEL.HAIKU;

export const QUEUE_TRIAGE_SYSTEM_PROMPT = `You are the queue admission triage model for JoelClaw.

You are reviewing an already-registered queue event family.
You may only shape queue admission within these bounded controls:
- priority: P0 | P1 | P2 | P3
- dedupKey: null or a short stable semantic dedup key
- routeCheck: confirm | mismatch

Hard rules:
- DO NOT invent a new handler target.
- DO NOT propose a route override.
- DO NOT change the event family name.
- routeCheck is only a signal about whether the supplied static registry route looks wrong.
- If you are unsure, keep the static priority and set routeCheck to confirm.
- Keep reasoning to one short sentence.

Respond with ONLY valid JSON:
{
  "priority": "P0|P1|P2|P3",
  "dedupKey": "string or null",
  "routeCheck": "confirm|mismatch",
  "reasoning": "one short sentence"
}`;

const QueueTriageOutputSchema = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  dedupKey: z.string().trim().min(1).max(240).nullable().optional(),
  routeCheck: z.enum(["confirm", "mismatch"]),
  reasoning: z.string().trim().min(1).max(280),
}).strict();

type QueueTriageOutput = z.infer<typeof QueueTriageOutputSchema>;

type QueueTriageParseResult =
  | { ok: true; value: QueueTriageOutput }
  | { ok: false; reason: QueueTriageFallbackReason; error: string };

export type QueueTriageInput = {
  mode: QueueTriageMode;
  envelope: QueueEventEnvelope<Record<string, unknown>>;
  dedupKey?: string;
  timeoutMs?: number;
  model?: string;
};

function normalizeDedupKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function priorityLabelFromPriority(priority: Priority): QueuePriorityLabel {
  if (priority === Priority.P0) return "P0";
  if (priority === Priority.P1) return "P1";
  if (priority === Priority.P2) return "P2";
  return "P3";
}

function buildBaselineOutcome(priority: Priority, dedupKey?: string): QueueTriageOutcome {
  return {
    priority: priorityLabelFromPriority(priority),
    dedupKey: normalizeDedupKey(dedupKey),
    routeCheck: "confirm",
  };
}

function buildTriageFallbackDecision(input: {
  mode: QueueTriageMode;
  family: string;
  model?: string;
  fallbackReason: QueueTriageFallbackReason;
  baseline: QueueTriageOutcome;
  latencyMs: number;
}): QueueTriageDecision {
  return {
    mode: input.mode,
    model: input.model,
    family: input.family,
    suggested: { ...input.baseline },
    final: { ...input.baseline },
    applied: false,
    fallbackReason: input.fallbackReason,
    latencyMs: input.latencyMs,
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

function detectUnsafeOverrideKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys = Object.keys(value as Record<string, unknown>);
  return FORBIDDEN_OVERRIDE_KEYS.filter((key) => keys.includes(key));
}

export function parseQueueTriageOutput(raw: string): QueueTriageParseResult {
  const parsed = parseJsonCandidate(raw);
  if (!parsed) {
    return {
      ok: false,
      reason: "invalid_json",
      error: "Queue triage returned invalid JSON",
    };
  }

  const forbidden = detectUnsafeOverrideKeys(parsed);
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: "unsafe_override",
      error: `Queue triage attempted forbidden override keys: ${forbidden.join(", ")}`,
    };
  }

  const result = QueueTriageOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema_error",
      error: result.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  return {
    ok: true,
    value: result.data,
  };
}

function fallbackReasonFromError(error: unknown): QueueTriageFallbackReason {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  return "model_error";
}

function buildUserPrompt(input: {
  family: string;
  envelope: QueueEventEnvelope<Record<string, unknown>>;
  baseline: QueueTriageOutcome;
  handlerType?: string;
  handlerTarget?: string;
  dedupWindowMs?: number;
}): string {
  const dedupWindow = typeof input.dedupWindowMs === "number" ? input.dedupWindowMs : null;
  return [
    `Queue family: ${input.family}`,
    `Static priority: ${input.baseline.priority}`,
    `Static dedup key: ${input.baseline.dedupKey ?? "null"}`,
    `Static handler type: ${input.handlerType ?? "unknown"}`,
    `Static handler target: ${input.handlerTarget ?? "unknown"}`,
    `Registry dedup window ms: ${dedupWindow ?? "null"}`,
    `Event source: ${input.envelope.source}`,
    `Event id: ${input.envelope.id}`,
    `Correlation id: ${input.envelope.trace?.correlationId ?? input.envelope.id}`,
    "Event payload JSON:",
    JSON.stringify(input.envelope.data, null, 2),
  ].join("\n");
}

async function emitQueueTriageStarted(input: {
  eventId: string;
  correlationId: string;
  family: string;
  mode: QueueTriageMode;
  model: string;
  queueEventName: string;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_TRIAGE_COMPONENT,
    action: "queue.triage.started",
    success: true,
    metadata: {
      eventId: input.eventId,
      correlationId: input.correlationId,
      family: input.family,
      mode: input.mode,
      model: input.model,
      queueEventName: input.queueEventName,
    },
  });
}

async function emitQueueTriageCompleted(input: {
  eventId: string;
  correlationId: string;
  family: string;
  queueEventName: string;
  decision: QueueTriageDecision;
}): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: QUEUE_TRIAGE_COMPONENT,
    action: "queue.triage.completed",
    success: true,
    duration_ms: input.decision.latencyMs,
    metadata: {
      eventId: input.eventId,
      correlationId: input.correlationId,
      family: input.family,
      queueEventName: input.queueEventName,
      mode: input.decision.mode,
      model: input.decision.model ?? null,
      suggestedPriority: input.decision.suggested.priority,
      finalPriority: input.decision.final.priority,
      suggestedDedupKey: input.decision.suggested.dedupKey ?? null,
      finalDedupKey: input.decision.final.dedupKey ?? null,
      routeCheck: input.decision.final.routeCheck,
      applied: input.decision.applied,
      fallbackReason: input.decision.fallbackReason ?? null,
      latencyMs: input.decision.latencyMs,
    },
  });
}

async function emitQueueTriageFailed(input: {
  eventId: string;
  correlationId: string;
  family: string;
  mode: QueueTriageMode;
  model: string;
  queueEventName: string;
  error: string;
  latencyMs: number;
}): Promise<void> {
  await emitOtelEvent({
    level: "error",
    source: "worker",
    component: QUEUE_TRIAGE_COMPONENT,
    action: "queue.triage.failed",
    success: false,
    error: input.error,
    duration_ms: input.latencyMs,
    metadata: {
      eventId: input.eventId,
      correlationId: input.correlationId,
      family: input.family,
      mode: input.mode,
      model: input.model,
      queueEventName: input.queueEventName,
      latencyMs: input.latencyMs,
    },
  });
}

async function emitQueueTriageFallback(input: {
  eventId: string;
  correlationId: string;
  family: string;
  queueEventName: string;
  decision: QueueTriageDecision;
}): Promise<void> {
  const degraded = input.decision.fallbackReason && input.decision.fallbackReason !== "disabled";
  await emitOtelEvent({
    level: degraded ? "warn" : "info",
    source: "worker",
    component: QUEUE_TRIAGE_COMPONENT,
    action: "queue.triage.fallback",
    success: !degraded,
    error: degraded ? input.decision.fallbackReason : undefined,
    duration_ms: input.decision.latencyMs,
    metadata: {
      eventId: input.eventId,
      correlationId: input.correlationId,
      family: input.family,
      queueEventName: input.queueEventName,
      mode: input.decision.mode,
      model: input.decision.model ?? null,
      fallbackReason: input.decision.fallbackReason ?? null,
      finalPriority: input.decision.final.priority,
      finalDedupKey: input.decision.final.dedupKey ?? null,
      routeCheck: input.decision.final.routeCheck,
      latencyMs: input.decision.latencyMs,
    },
  });
}

export async function triageQueueEvent(input: QueueTriageInput): Promise<QueueTriageDecision> {
  const registryEntry = lookupQueueEvent(input.envelope.name);
  if (!registryEntry) {
    throw new Error(`queue triage requires a registered event family: ${input.envelope.name}`);
  }

  const family = input.envelope.name;
  const model = input.model ?? QUEUE_TRIAGE_MODEL;
  const correlationId = input.envelope.trace?.correlationId?.trim() || input.envelope.id;
  const baseline = buildBaselineOutcome(
    input.envelope.priority ?? registryEntry.priority ?? Priority.P2,
    input.dedupKey,
  );

  if (input.mode === "off") {
    const decision = buildTriageFallbackDecision({
      mode: input.mode,
      family,
      model,
      fallbackReason: "disabled",
      baseline,
      latencyMs: 0,
    });
    await emitQueueTriageFallback({
      eventId: input.envelope.id,
      correlationId,
      family,
      queueEventName: input.envelope.name,
      decision,
    });
    return decision;
  }

  const startedAt = Date.now();
  await emitQueueTriageStarted({
    eventId: input.envelope.id,
    correlationId,
    family,
    mode: input.mode,
    model,
    queueEventName: input.envelope.name,
  });

  try {
    const result = await infer(
      buildUserPrompt({
        family,
        envelope: input.envelope,
        baseline,
        handlerType: registryEntry.handler?.type,
        handlerTarget: registryEntry.handler?.target,
        dedupWindowMs: registryEntry.dedupWindowMs,
      }),
      {
        model,
        task: "classification",
        system: QUEUE_TRIAGE_SYSTEM_PROMPT,
        component: QUEUE_TRIAGE_COMPONENT,
        action: "queue.triage.classify",
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        requireTextOutput: true,
        noTools: true,
        metadata: {
          eventId: input.envelope.id,
          correlationId,
          family,
          mode: input.mode,
          queueEventName: input.envelope.name,
        },
      },
    );

    const parsed = parseQueueTriageOutput(result.text);
    if (!parsed.ok) {
      const latencyMs = Date.now() - startedAt;
      await emitQueueTriageFailed({
        eventId: input.envelope.id,
        correlationId,
        family,
        mode: input.mode,
        model,
        queueEventName: input.envelope.name,
        error: parsed.error,
        latencyMs,
      });

      const decision = buildTriageFallbackDecision({
        mode: input.mode,
        family,
        model,
        fallbackReason: parsed.reason,
        baseline,
        latencyMs,
      });
      await emitQueueTriageFallback({
        eventId: input.envelope.id,
        correlationId,
        family,
        queueEventName: input.envelope.name,
        decision,
      });
      return decision;
    }

    const suggested: QueueTriageOutcome = {
      priority: parsed.value.priority,
      dedupKey: normalizeDedupKey(parsed.value.dedupKey),
      routeCheck: parsed.value.routeCheck,
      reasoning: parsed.value.reasoning,
    };

    const final: QueueTriageOutcome = input.mode === "enforce"
      ? {
          priority: suggested.priority,
          dedupKey: suggested.dedupKey,
          routeCheck: suggested.routeCheck,
          reasoning: suggested.reasoning,
        }
      : {
          ...baseline,
          routeCheck: suggested.routeCheck,
          reasoning: suggested.reasoning,
        };

    const decision: QueueTriageDecision = {
      mode: input.mode,
      model: result.model ?? model,
      family,
      suggested,
      final,
      applied: input.mode === "enforce"
        && (final.priority !== baseline.priority || final.dedupKey !== baseline.dedupKey),
      latencyMs: Date.now() - startedAt,
    };

    await emitQueueTriageCompleted({
      eventId: input.envelope.id,
      correlationId,
      family,
      queueEventName: input.envelope.name,
      decision,
    });

    return decision;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    await emitQueueTriageFailed({
      eventId: input.envelope.id,
      correlationId,
      family,
      mode: input.mode,
      model,
      queueEventName: input.envelope.name,
      error: message,
      latencyMs,
    });

    const decision = buildTriageFallbackDecision({
      mode: input.mode,
      family,
      model,
      fallbackReason: fallbackReasonFromError(error),
      baseline,
      latencyMs,
    });

    await emitQueueTriageFallback({
      eventId: input.envelope.id,
      correlationId,
      family,
      queueEventName: input.envelope.name,
      decision,
    });

    return decision;
  }
}

export const __queueTriageTestUtils = {
  buildBaselineOutcome,
  buildUserPrompt,
  fallbackReasonFromError,
  parseJsonCandidate,
  parseQueueTriageOutput,
  priorityLabelFromPriority,
};
