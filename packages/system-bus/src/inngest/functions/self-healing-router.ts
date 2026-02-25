import { $ } from "bun";
import { inngest } from "../client";
import { emitOtelEvent } from "../../observability/emit";
import { parsePiJsonAssistant, traceLlmGeneration } from "../../lib/langfuse";
import { assertAllowedModel } from "../../lib/models";
import { loadBackupFailureRouterConfig } from "../../lib/backup-failure-router-config";

const BACKUP_RETRY_EVENT_NAME = "system/backup.retry.requested";
const BACKUP_RETRY_DECISION_MODEL = loadBackupFailureRouterConfig().failureRouter.model;
const BACKUP_RETRY_FALLBACK_MODEL = loadBackupFailureRouterConfig().failureRouter.fallbackModel;

type EvidenceItem = {
  type: string;
  detail: string;
};

type Playbook = {
  actions?: string[];
  restart?: string[];
  notify?: string[];
  links?: string[];
};

type RetryPolicy = {
  maxRetries?: number;
  sleepMinMs?: number;
  sleepMaxMs?: number;
  sleepStepMs?: number;
};

type SelfHealingContext = {
  sourceFunction?: string;
  targetComponent?: string;
  problemSummary?: string;
  attempt?: number;
  domain?: "backup" | "sdk-reachability" | "all" | string;
  routeToFunction?: string;
  targetEventName?: string;
  retryPolicy?: RetryPolicy;
  evidence?: EvidenceItem[] | string[];
  context?: Record<string, unknown>;
  playbook?: Playbook;
  owner?: string;
  deadlineAt?: string;
  fallbackAction?: "escalate" | "manual";
};

type Decision = {
  action: "retry" | "pause" | "escalate";
  delayMs: number;
  reason: string;
  confidence: number;
  model: string;
  routeToFunction?: string;
  routeToEventName?: string;
};

type RetryPayload = {
  sourceFunction?: string;
  targetComponent?: string;
  problemSummary?: string;
  attempt: number;
  nextAttempt: number;
  retryPolicy?: RetryPolicy;
  routeToEventName?: string;
  targetEventName?: string;
  routeToFunction?: string;
  targetFunctionId?: "system/backup.typesense" | "system/backup.redis" | string;
  target?: "typesense" | "redis" | string;
  error?: string;
  backupFailureDetectedAt?: string;
  transportMode?: "local" | "remote";
  transportAttempts?: number;
  transportDestination?: string;
  retryWindowHours?: number;
  retryWindowMinutes?: number;
  evidence?: EvidenceItem[] | string[];
  playbook?: Playbook;
  context?: Record<string, unknown>;
  owner?: string;
  deadlineAt?: string;
  decision: {
    action: "retry" | "pause" | "escalate";
    delayMs: number;
    reason: string;
    confidence: number;
    model: string;
    routeToFunction?: string;
    routeToEventName?: string;
  };
};

function toSafeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

function toSafeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function clampDelayMs(value: number): number {
  const fallback = SELF_HEALING_CONFIG.failureRouter.sleepMinMs;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(fallback > 0 ? fallback * 12_000 : Number.MAX_SAFE_INTEGER, Math.min(value, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs));
}

function estimateRetryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const baseDelay = SELF_HEALING_CONFIG.failureRouter.sleepMinMs;
  const capped = Math.min(baseDelay * 2 ** boundedAttempt, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs);
  const jitter = Math.max(0, Math.floor(Math.random() * SELF_HEALING_CONFIG.failureRouter.sleepStepMs));
  return clampDelayMs(capped + jitter);
}

function formatInngestSleepDelay(delayMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(clampDelayMs(delayMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;

  if (hours > 0) return `${hours}h`;
  if (remMinutes > 0) return `${remMinutes}m`;
  return `${seconds}s`;
}

function parseJsonFromText(raw: string): unknown | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  const parse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  const direct = parse(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const fencedValue = parse(fenced[1].trim());
    if (fencedValue !== null) return fencedValue;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return parse(trimmed.slice(start, end + 1));
  }

  return null;
}

function parseDecision(raw: unknown, fallbackAttempt: number): Decision {
  const record = raw as Record<string, unknown>;
  const actionText = String(record?.action ?? record?.decision ?? record?.route ?? "").toLowerCase();
  const rawAction = typeof record?.action === "string" ? record.action : "";
  const action =
    rawAction.includes("retry") || rawAction.includes("re-run")
      ? "retry"
      : rawAction.includes("pause") || rawAction.includes("wait")
        ? "pause"
        : rawAction.includes("escalate") || rawAction.includes("manual")
          ? "escalate"
          : fallbackAttempt > 2
            ? "pause"
            : "retry";

  const delayMsCandidate = toSafeInt(record?.delayMs, Number.NaN);
  const delaySecondsCandidate = toSafeInt(record?.delaySeconds, Number.NaN);
  const waitMinutesCandidate = toSafeInt(record?.waitMinutes, Number.NaN);
  const waitHoursCandidate = toSafeInt(record?.waitHours, Number.NaN);
  const rawDelay = delayMsCandidate > 0
    ? delayMsCandidate
    : delaySecondsCandidate > 0
      ? delaySecondsCandidate * 1000
      : waitMinutesCandidate > 0
        ? waitMinutesCandidate * 60_000
        : waitHoursCandidate > 0
          ? waitHoursCandidate * 60 * 60_000
          : Number.NaN;
  const confidence = typeof record?.confidence === "number" ? record.confidence : 0.35;
  const reason = typeof record?.reason === "string" && record.reason.length > 0 ? record.reason : "Model output unavailable.";

  return {
    action,
    delayMs: Number.isFinite(rawDelay) ? rawDelay : estimateRetryDelayMs(fallbackAttempt),
    reason,
    confidence: Number.isFinite(confidence) ? confidence : 0.35,
    model: typeof record?.model === "string" ? record.model : BACKUP_RETRY_DECISION_MODEL,
    routeToFunction: toSafeText(record?.routeToFunction, ""),
    routeToEventName: toSafeText(record?.routeToEventName, ""),
  };
}

function pickRetryPolicy(input: RetryPolicy): RetryPolicy {
  return {
    maxRetries: toSafeInt(input?.maxRetries, SELF_HEALING_CONFIG.failureRouter.maxRetries),
    sleepMinMs: toSafeInt(input?.sleepMinMs, SELF_HEALING_CONFIG.failureRouter.sleepMinMs),
    sleepMaxMs: toSafeInt(input?.sleepMaxMs, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs),
    sleepStepMs: toSafeInt(input?.sleepStepMs, SELF_HEALING_CONFIG.failureRouter.sleepStepMs),
  };
}

function normalizeBackupFunction(value: unknown): "system/backup.typesense" | "system/backup.redis" | null {
  const candidate = toSafeText(value, "");
  if (candidate === "system/backup.redis") return "system/backup.redis";
  if (candidate === "system/backup.typesense") return "system/backup.typesense";
  return null;
}

function targetFromFunction(value: string | undefined): "typesense" | "redis" | "unknown" {
  if (value === "system/backup.redis") return "redis";
  if (value === "system/backup.typesense") return "typesense";
  return "unknown";
}

const SELF_HEALING_CONFIG = loadBackupFailureRouterConfig();

async function analyzeSelfHealingWithPi(payload: SelfHealingContext, attempt: number, isRetry: boolean): Promise<Decision> {
  const policy = pickRetryPolicy(payload.retryPolicy ?? {});
  const normalizedAttempt = toSafeInt(attempt, 0);

  const systemPrompt = [
    "You are a senior SRE coding agent operating in the joelclaw system.",
    "Use Codex-style structured prompting: return only the requested JSON object, no prose, no markdown, no hidden reasoning.",
    "System shape:",
    "- Durable router receives `system/self.healing.requested` events for cross-domain incidents.",
    "- For each event, choose exactly one action: retry, pause, or escalate/manual.",
    "- On retry or pause, select a bounded delay and emit `system/self.healing.retry.requested` via deterministic step scheduling.",
    "- Route targets should map to explicit event names (for backup, use `system/backup.retry.requested`).",
    "Operational skills to honor where relevant:",
    "- inngest-* for durable orchestration and event-driven retries.",
    "- o11y-logging for telemetry/observability in all branches.",
    "- gateway-setup for mount, worker, and session path issues.",
    "Return one strict JSON object and nothing else.",
    "Schema:",
    `{\n  "action": "retry|pause|escalate",\n  "delayMs": number,\n  "reason": string,\n  "routeToFunction": string (optional),\n  "routeToEventName": string (optional),\n  "confidence": number (0-1)\n}`,
    `Max retries configured: ${policy.maxRetries}.`,
    "Prefer concrete reasoning with signal evidence and clear next-step semantics.",
  ].join("\n");

  const userPrompt = [
    "Self-healing request:",
    JSON.stringify(payload, null, 2),
    `Retry attempt: ${normalizedAttempt}`,
    `Is repeated retry event: ${isRetry ? "true" : "false"}`,
    `Policy: ${JSON.stringify(policy)}`,
  ].join("\n\n");

  const startedAt = Date.now();
  assertAllowedModel(BACKUP_RETRY_DECISION_MODEL);
  assertAllowedModel(BACKUP_RETRY_FALLBACK_MODEL);

  const analyzeWithModel = async (model: string) => {
    const result = await $`pi --no-tools --no-session --no-extensions --print --mode json --model ${model} --system-prompt ${systemPrompt} ${userPrompt}`.quiet().nothrow();
    const raw = await result.text();
    const parsedPi = parsePiJsonAssistant(raw);
    const assistantText = parsedPi?.text ?? raw;
    const parsed = parseJsonFromText(assistantText);

    const decision = parsed === null
      ? parseDecision({}, normalizedAttempt)
      : parseDecision(parsed, normalizedAttempt);

    await traceLlmGeneration({
      traceName: "joelclaw.self-healing-router",
      generationName: "self.healing.decision",
      component: "system-bus",
      action: "system.self.healing.decision",
      input: { payload, attempt: normalizedAttempt },
      output: decision,
      provider: parsedPi?.provider,
      model: parsedPi?.model ?? model,
      usage: parsedPi?.usage,
      durationMs: Date.now() - startedAt,
      metadata: {
        requestedModel: model,
        isRetry,
        reason: decision.reason,
      },
    });

    if (result.exitCode !== 0 && decision.action === "escalate" && !decision.reason) {
      throw new Error(`pi exited ${result.exitCode}`);
    }

    return decision;
  };

  try {
    return await analyzeWithModel(BACKUP_RETRY_DECISION_MODEL);
  } catch {
    try {
      return await analyzeWithModel(BACKUP_RETRY_FALLBACK_MODEL);
    } catch {
      return {
        action: "retry",
        delayMs: estimateRetryDelayMs(normalizedAttempt),
        reason: "Model analysis unavailable; using fallback backoff.",
        confidence: 0.35,
        model: BACKUP_RETRY_FALLBACK_MODEL,
      };
    }
  }
}

function contextNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function buildRetryPayload(
  source: SelfHealingContext,
  decision: Decision,
  nextAttempt: number,
  retryPolicy: RetryPolicy
): RetryPayload {
  const routeToFunction = toSafeText(decision.routeToFunction || source.routeToFunction, source.sourceFunction ?? "");
  const normalizedRouteToFunction = normalizeBackupFunction(routeToFunction) ?? undefined;
  const targetEventName = toSafeText(
    decision.routeToEventName || source.targetEventName || source.routeToEventName,
    BACKUP_RETRY_EVENT_NAME,
  );
  const base: RetryPayload = {
    sourceFunction: toSafeText(source.sourceFunction, "unknown"),
    targetComponent: toSafeText(source.targetComponent, source.domain ?? "unknown"),
    problemSummary: toSafeText(source.problemSummary, "Backup/self-healing decision required."),
    attempt: nextAttempt,
    nextAttempt,
    retryPolicy,
    routeToEventName: targetEventName,
    targetEventName: toSafeText(source.targetEventName, targetEventName),
    routeToFunction: normalizedRouteToFunction,
    evidence: source.evidence,
    playbook: source.playbook,
    context: source.context,
    owner: source.owner,
    deadlineAt: source.deadlineAt,
    decision: {
      action: decision.action,
      delayMs: decision.delayMs,
      reason: decision.reason,
      confidence: decision.confidence,
      model: decision.model,
      routeToEventName: targetEventName,
      routeToFunction: normalizedRouteToFunction,
    },
  };

  if (normalizedRouteToFunction) {
    base.targetFunctionId = normalizedRouteToFunction;
    base.target = targetFromFunction(normalizedRouteToFunction);
  }

  const context = source.context ?? {};
  if (source.domain === "backup" || targetEventName === BACKUP_RETRY_EVENT_NAME) {
    base.error = toSafeText(source.problemSummary, `${base.sourceFunction}: ${base.problemSummary}`);
    base.backupFailureDetectedAt = toSafeText(context.backupFailureDetectedAt, new Date().toISOString());
    base.retryWindowHours = context.retryWindowHours && typeof context.retryWindowHours === "number"
      ? context.retryWindowHours
      : undefined;
    base.retryWindowMinutes = toSafeInt(context.retryWindowHours, 0) > 0
      ? Math.floor(context.retryWindowHours as number * 60)
      : undefined;
    base.transportMode = context.transportMode === "remote" ? "remote" : "local";
    base.transportAttempts = context.transportAttempts && typeof context.transportAttempts === "number"
      ? context.transportAttempts
      : undefined;
    base.transportDestination = toSafeText(context.transportDestination, "");
  }

  return base;
}

export const selfHealingRouter = inngest.createFunction(
  {
    id: "system/self-healing.router",
    name: "Route Self-Healing Decisions",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ event: "system/self.healing.requested" }],
  async ({ event, step }) => {
    const data = (event.data ?? {}) as SelfHealingContext;
    const attempt = toSafeInt(data.attempt, 0);
    const nextAttempt = attempt + 1;
    const retryPolicy = pickRetryPolicy(data.retryPolicy ?? {});
    const decision = await analyzeSelfHealingWithPi(data, attempt, attempt > 0);

    const isRetryLike = decision.action === "retry" || decision.action === "pause";
    const routeToEventName = decision.routeToEventName || toSafeText(data.targetEventName, "");
    const maxAttempts = toSafeInt(retryPolicy.maxRetries, SELF_HEALING_CONFIG.failureRouter.maxRetries);

    if (isRetryLike) {
      if (nextAttempt > maxAttempts || !routeToEventName) {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "self-healing",
          action: "system.self-healing.router",
          success: false,
          error: routeToEventName
            ? `Retry budget exceeded for ${data.sourceFunction} after ${nextAttempt} attempts`
            : "No route target supplied by decision model",
          metadata: {
            eventId: event.id,
            sourceFunction: data.sourceFunction,
            targetComponent: data.targetComponent,
            attempt,
            nextAttempt,
            maxRetries: maxAttempts,
            decision,
          },
        });
        return {
          status: "escalated",
          reason: routeToEventName
            ? `Retry budget exceeded (${nextAttempt}/${maxAttempts})`
            : "Route target missing",
          action: decision.action,
        };
      }

      const delayMs = decision.delayMs > 0
        ? decision.delayMs
        : estimateRetryDelayMs(attempt);
      await step.sleep("self-healing-router-wait", formatInngestSleepDelay(delayMs));
      await step.sendEvent("emit-self-healing-retry", {
        name: routeToEventName,
        data: buildRetryPayload(data, decision, nextAttempt, retryPolicy),
      });

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "self-healing",
        action: "system.self-healing.router",
        success: true,
        metadata: {
          eventId: event.id,
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          attempt,
          nextAttempt,
          routeToEventName,
          delayMs,
          decision,
        },
      });

      return {
        status: "scheduled",
        action: decision.action,
        nextAttempt,
        delayMs,
      };
    }

    await emitOtelEvent({
      level: "warn",
      source: "worker",
      component: "self-healing",
      action: "system.self-healing.router",
      success: false,
      error: `Escalating self-healing request for ${data.sourceFunction}`,
      metadata: {
        eventId: event.id,
        sourceFunction: data.sourceFunction,
        targetComponent: data.targetComponent,
        attempt,
        decision,
      },
    });
    return {
      status: "escalated",
      action: decision.action,
      reason: decision.reason,
    };
  }
);

