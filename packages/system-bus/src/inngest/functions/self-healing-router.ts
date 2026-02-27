import { loadBackupFailureRouterConfig } from "../../lib/backup-failure-router-config";
import { infer } from "../../lib/inference";
import { assertAllowedModel } from "../../lib/models";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

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
  kill?: string[];
  defer?: string[];
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
  sourceFunction: string;
  targetComponent: string;
  problemSummary: string;
  attempt?: number;
  domain?: "backup" | "sdk-reachability" | "all" | string;
  routeToFunction?: string;
  routeToEventName?: string;
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
  domain?: "backup" | "sdk-reachability" | "gateway-bridge" | "gateway-provider" | "otel-pipeline" | "all" | string;
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

type SelfHealingFlowContext = {
  runContextKey: string;
  flowTrace: string[];
  sourceEventName: string;
  sourceEventId?: string;
  attempt: number;
};

function buildSelfHealingFlowContext(
  eventName: string,
  eventId: string | undefined,
  context: SelfHealingContext,
  nextAttempt: number,
): SelfHealingFlowContext {
  const sourceFunction = toSafeText(context.sourceFunction, "system/self-healing.router");
  const targetComponent = toSafeText(context.targetComponent, "unknown");
  const targetEventName = toSafeText(context.targetEventName, "system.self.healing.retry.requested");
  const domain = toSafeText(context.domain, "all");
  const attempt = toSafeInt(context.attempt, 0);
  const safeEventName = toSafeText(eventName, "system/self.healing.requested");
  const safeNextAttempt = Math.max(0, Math.floor(nextAttempt));

  return {
    runContextKey: `${safeEventName}::${sourceFunction}::${targetComponent}::${domain}::${targetEventName}::next-${safeNextAttempt}`,
    flowTrace: [safeEventName, sourceFunction, targetComponent, domain, targetEventName],
    sourceEventName: safeEventName,
    sourceEventId: eventId,
    attempt,
  };
}

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

function clampDelayMs(value: number, retryPolicy: RetryPolicy): number {
  const min = toSafeInt(retryPolicy.sleepMinMs, SELF_HEALING_CONFIG.failureRouter.sleepMinMs);
  const max = toSafeInt(retryPolicy.sleepMaxMs, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs);
  if (!Number.isFinite(value) || value <= 0) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function estimateRetryDelayMs(attempt: number, retryPolicy: RetryPolicy): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const baseDelay = toSafeInt(retryPolicy.sleepMinMs, SELF_HEALING_CONFIG.failureRouter.sleepMinMs);
  const maxDelay = toSafeInt(retryPolicy.sleepMaxMs, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs);
  const jitter = Math.max(0, Math.floor(Math.random() * toSafeInt(retryPolicy.sleepStepMs, SELF_HEALING_CONFIG.failureRouter.sleepStepMs)));
  const capped = Math.min(baseDelay * 2 ** boundedAttempt, maxDelay);
  return clampDelayMs(capped + jitter, retryPolicy);
}

function formatInngestSleepDelay(delayMs: number, retryPolicy: RetryPolicy): string {
  const totalSeconds = Math.max(1, Math.ceil(clampDelayMs(delayMs, retryPolicy) / 1000));
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

function parseDecision(raw: unknown, fallbackAttempt: number, retryPolicy: RetryPolicy): Decision {
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
    delayMs: Number.isFinite(rawDelay)
      ? clampDelayMs(rawDelay, retryPolicy)
        : estimateRetryDelayMs(fallbackAttempt, retryPolicy),
    reason,
    confidence: Number.isFinite(confidence) ? confidence : 0.35,
    model: typeof record?.model === "string" ? record.model : BACKUP_RETRY_DECISION_MODEL,
    routeToFunction: toSafeText(record?.routeToFunction, ""),
    routeToEventName: toSafeText(record?.routeToEventName, ""),
  };
}

function summarizeEvidenceForRouterPayload(
  evidence: EvidenceItem[] | string[] | undefined,
): { count: number; samples: Array<EvidenceItem | string>; types: string[] } {
  const safeEvidence = Array.isArray(evidence) ? evidence : [];
  const sampleCount = Math.min(6, safeEvidence.length);
  return {
    count: safeEvidence.length,
    samples: safeEvidence.slice(0, sampleCount).map((entry) =>
      typeof entry === "string" ? `raw:${entry}` : entry
    ),
    types: [...new Set(
      safeEvidence.map((entry) =>
        typeof entry === "string" ? "string" : toSafeText(entry.type, "unknown")
      ),
    )],
  };
}

type SelfHealingCompletionStatus = "scheduled" | "exhausted" | "escalated" | "invalid" | "blocked";

function normalizeSelfHealingContext(raw: Record<string, unknown>): {
  context: SelfHealingContext;
  missing: string[];
  policy: RetryPolicy;
} {
  const candidate = raw as SelfHealingContext;
  const missing: string[] = [];

  const sourceFunction = toSafeText(candidate.sourceFunction, "unknown");
  const targetComponent = toSafeText(candidate.targetComponent, "");
  const problemSummary = toSafeText(candidate.problemSummary, "");
  const policy = pickRetryPolicy(candidate.retryPolicy ?? {});

  if (sourceFunction === "unknown") missing.push("sourceFunction");
  if (!targetComponent) missing.push("targetComponent");
  if (!problemSummary) missing.push("problemSummary");

  const playbook = candidate.playbook ?? {};
  const normalizedPlaybook: Playbook = {
    actions: Array.isArray(playbook.actions) ? playbook.actions : [],
    restart: Array.isArray(playbook.restart) ? playbook.restart : [],
    kill: Array.isArray(playbook.kill) ? playbook.kill : [],
    defer: Array.isArray(playbook.defer) ? playbook.defer : [],
    notify: Array.isArray(playbook.notify) ? playbook.notify : ["joelclaw otel search --hours 1"],
    links: Array.isArray(playbook.links) ? playbook.links : ["/Users/joel/Vault/system/system-log.jsonl"],
  };

  return {
    context: {
      ...candidate,
      sourceFunction,
      targetComponent,
      problemSummary,
      attempt: toSafeInt(candidate.attempt, 0),
      retryPolicy: policy,
      evidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
      playbook: normalizedPlaybook,
      owner: toSafeText(candidate.owner, "system"),
      domain: toSafeText(candidate.domain, "all"),
      context: candidate.context ?? {},
      deadlineAt: toSafeText(candidate.deadlineAt, ""),
      fallbackAction: candidate.fallbackAction ?? "manual",
      routeToFunction: toSafeText(candidate.routeToFunction, ""),
      targetEventName: toSafeText(candidate.targetEventName, ""),
    },
    missing,
    policy,
  };
}

async function emitSelfHealingCompleted(
  step: { sendEvent: (id: string, payload: { name: string; data: Record<string, unknown> }) => Promise<unknown> },
  eventId: string | undefined,
  request: {
    domain: string;
    sourceFunction: string;
    targetComponent: string;
    status: SelfHealingCompletionStatus;
    action: "retry" | "pause" | "escalate";
    attempt: number;
    nextAttempt?: number;
    reason: string;
    delayMs?: number;
    routeToEventName?: string;
    routeToFunction?: string;
    confidence?: number;
    model?: string;
    evidence?: EvidenceItem[] | string[];
    playbook?: Playbook;
    owner?: string;
    flowContext?: SelfHealingFlowContext;
  }
) {
  return step.sendEvent("emit-self-healing-completed", {
    name: "system/self.healing.completed",
    data: {
      domain: request.domain,
      status: request.status,
      sourceFunction: request.sourceFunction,
      targetComponent: request.targetComponent,
      attempt: request.attempt,
      nextAttempt: request.nextAttempt,
      action: request.action,
      reason: request.reason,
      detected: 1,
      inspected: 1,
      delayMs: request.delayMs,
      routeToEventName: request.routeToEventName,
      routeToFunction: request.routeToFunction,
      confidence: request.confidence,
      model: request.model,
      evidence: request.evidence ?? [],
      playbook: request.playbook,
      owner: request.owner,
      ...(request.flowContext ? { context: { runContext: request.flowContext } } : {}),
      eventId,
    },
  });
}

function pickRetryPolicy(input: RetryPolicy): RetryPolicy {
  const candidateMin = toSafeInt(input?.sleepMinMs, SELF_HEALING_CONFIG.failureRouter.sleepMinMs);
  const minMs = clampPolicyFloor(candidateMin, 5_000, 3_600_000);
  const maxMs = clampPolicyCeil(
    toSafeInt(input?.sleepMaxMs, SELF_HEALING_CONFIG.failureRouter.sleepMaxMs),
    minMs,
    14_400_000
  );
  const stepMs = clampPolicyFloor(
    toSafeInt(input?.sleepStepMs, SELF_HEALING_CONFIG.failureRouter.sleepStepMs),
    5_000,
    maxMs
  );

  return {
    maxRetries: clampPolicyFloor(toSafeInt(input?.maxRetries, SELF_HEALING_CONFIG.failureRouter.maxRetries), 1, 64),
    sleepMinMs: minMs,
    sleepMaxMs: maxMs,
    sleepStepMs: stepMs,
  };
}

function clampPolicyFloor(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampPolicyCeil(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function domainFromContext(context: SelfHealingContext): string {
  if (
    context.domain === "backup"
    || context.domain === "sdk-reachability"
    || context.domain === "gateway-bridge"
    || context.domain === "gateway-provider"
    || context.domain === "otel-pipeline"
    || context.domain === "all"
  ) {
    return context.domain;
  }
  return toSafeText(context.domain, "all");
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

async function analyzeSelfHealingWithPi(
  payload: SelfHealingContext,
  attempt: number,
  isRetry: boolean,
  flowContext: SelfHealingFlowContext,
): Promise<Decision> {
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

  assertAllowedModel(BACKUP_RETRY_DECISION_MODEL);
  assertAllowedModel(BACKUP_RETRY_FALLBACK_MODEL);

  const analyzeWithModel = async (
    model: string,
    flowContext: SelfHealingFlowContext,
  ) => {
    const inferResult = await infer(userPrompt, {
      task: "json",
      model,
      system: systemPrompt,
      component: "system-bus",
      action: "system.self.healing.decision",
      metadata: {
        requestedModel: model,
        isRetry,
        retryLevel: normalizedAttempt,
        payloadSourceFunction: flowContext.runContextKey,
        flowTrace: flowContext.flowTrace,
      },
    });
    const assistantText = inferResult.text;
    const parsed = parseJsonFromText(assistantText);

    const decision = parsed === null
      ? parseDecision({}, normalizedAttempt, policy)
      : parseDecision(parsed, normalizedAttempt, policy);

    if (!assistantText && decision.action === "escalate" && !decision.reason) {
      throw new Error("self-healing decision unavailable");
    }

    return decision;
  };

  try {
    return await analyzeWithModel(BACKUP_RETRY_DECISION_MODEL, flowContext);
  } catch {
    try {
      return await analyzeWithModel(BACKUP_RETRY_FALLBACK_MODEL, {
        ...flowContext,
        flowTrace: [...flowContext.flowTrace, "pi-fallback"],
      });
    } catch {
      return {
        action: "retry",
        delayMs: estimateRetryDelayMs(normalizedAttempt, policy),
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
  retryPolicy: RetryPolicy,
  flowContext: SelfHealingFlowContext
): RetryPayload {
  const routeToFunction = toSafeText(decision.routeToFunction || source.routeToFunction, source.sourceFunction ?? "");
  const normalizedRouteToFunction = normalizeBackupFunction(routeToFunction) ?? undefined;
  const targetEventName = toSafeText(
    decision.routeToEventName || source.targetEventName || source.routeToEventName,
    BACKUP_RETRY_EVENT_NAME,
  );
  const baseContext = {
    ...(source.context ?? {}),
    runContext: {
      runContextKey: flowContext.runContextKey,
      flowTrace: flowContext.flowTrace,
      sourceEventName: flowContext.sourceEventName,
      sourceEventId: flowContext.sourceEventId,
      attempt: flowContext.attempt,
      routeAttempt: nextAttempt,
      hasModelDecision: true,
      decision: {
        action: decision.action,
        model: decision.model,
      },
    },
  };
  const base: RetryPayload = {
    sourceFunction: toSafeText(source.sourceFunction, "unknown"),
    targetComponent: toSafeText(source.targetComponent, source.domain ?? "unknown"),
    problemSummary: toSafeText(source.problemSummary, "Backup/self-healing decision required."),
    domain: source.domain,
    attempt: nextAttempt,
    nextAttempt,
    retryPolicy,
    routeToEventName: targetEventName,
    targetEventName: toSafeText(source.targetEventName, targetEventName),
    routeToFunction: normalizedRouteToFunction,
    evidence: source.evidence,
    playbook: source.playbook,
    context: baseContext,
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
    const { context: data, missing, policy: retryPolicy } = normalizeSelfHealingContext(event.data ?? {});
    const attempt = toSafeInt(data.attempt, 0);
    const nextAttempt = attempt + 1;
    const domain = domainFromContext(data);
    const flowContext = buildSelfHealingFlowContext(
      event.name,
      event.id,
      data,
      nextAttempt,
    );
    const decision = await analyzeSelfHealingWithPi(
      data,
      attempt,
      attempt > 0,
      flowContext,
    );

    if (missing.length > 0) {
      const reason = `invalid request payload: missing ${missing.join(", ")}`;
      await emitOtelEvent({
        level: "warn",
        source: "worker",
        component: "self-healing",
        action: "system.self-healing.router",
        success: false,
        error: reason,
        metadata: {
          eventId: event.id,
          runContext: {
            runContextKey: flowContext.runContextKey,
            flowTrace: flowContext.flowTrace,
            sourceEventName: flowContext.sourceEventName,
            sourceEventId: flowContext.sourceEventId,
            attempt: flowContext.attempt,
            nextAttempt,
          },
          evidenceSummary: summarizeEvidenceForRouterPayload(data.evidence),
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          attempt,
          requiredFields: missing,
          decisionPolicy: retryPolicy,
        },
      });
      await emitSelfHealingCompleted(step, event.id, {
        domain,
        sourceFunction: data.sourceFunction,
        targetComponent: data.targetComponent,
        status: "invalid",
        action: "escalate",
        attempt,
        reason,
        flowContext,
        owner: data.owner,
      });
      return {
        status: "invalid",
        action: "escalate",
        reason,
      };
    }

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
            runContext: {
              runContextKey: flowContext.runContextKey,
              flowTrace: flowContext.flowTrace,
              sourceEventName: flowContext.sourceEventName,
              sourceEventId: flowContext.sourceEventId,
              attempt: flowContext.attempt,
              nextAttempt,
              maxRetries: maxAttempts,
              routeToEventName,
          },
          evidenceSummary: summarizeEvidenceForRouterPayload(data.evidence),
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          attempt,
          nextAttempt,
          maxRetries: maxAttempts,
          decision,
          },
        });
        await emitSelfHealingCompleted(step, event.id, {
          domain,
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          status: routeToEventName ? "exhausted" : "blocked",
          action: "escalate",
          attempt,
          reason: routeToEventName
            ? `Retry budget exceeded (${nextAttempt}/${maxAttempts})`
            : "Route target missing",
          routeToEventName,
          routeToFunction: decision.routeToFunction,
          confidence: decision.confidence,
          model: decision.model,
          evidence: data.evidence,
          playbook: data.playbook,
          flowContext,
          owner: data.owner,
        });
        return {
          status: routeToEventName ? "exhausted" : "blocked",
          reason: routeToEventName
            ? `Retry budget exceeded (${nextAttempt}/${maxAttempts})`
            : "Route target missing",
          action: decision.action,
        };
      }

      const delayMs = decision.delayMs > 0
        ? decision.delayMs
        : estimateRetryDelayMs(attempt, retryPolicy);
      await step.sleep("self-healing-router-wait", formatInngestSleepDelay(delayMs, retryPolicy));
      await step.sendEvent("emit-self-healing-retry", {
        name: routeToEventName,
        data: buildRetryPayload(data, decision, nextAttempt, retryPolicy, flowContext),
      });

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "self-healing",
        action: "system.self-healing.router",
        success: true,
        metadata: {
          eventId: event.id,
          runContext: {
            runContextKey: flowContext.runContextKey,
            flowTrace: flowContext.flowTrace,
            sourceEventName: flowContext.sourceEventName,
            sourceEventId: flowContext.sourceEventId,
            attempt: flowContext.attempt,
            nextAttempt,
            delayMs,
            reason: decision.reason,
          },
          evidenceSummary: summarizeEvidenceForRouterPayload(data.evidence),
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          attempt,
          nextAttempt,
          routeToEventName,
          delayMs,
          decision,
        },
      });
      await emitSelfHealingCompleted(step, event.id, {
        domain,
        sourceFunction: data.sourceFunction,
        targetComponent: data.targetComponent,
        status: "scheduled",
        action: decision.action,
        attempt: flowContext.attempt,
        reason: decision.reason,
        delayMs,
        routeToEventName,
        routeToFunction: decision.routeToFunction,
        confidence: decision.confidence,
        model: decision.model,
        evidence: data.evidence,
        playbook: data.playbook,
        flowContext,
        owner: data.owner,
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
          runContext: {
            runContextKey: flowContext.runContextKey,
            flowTrace: flowContext.flowTrace,
            sourceEventName: flowContext.sourceEventName,
            sourceEventId: flowContext.sourceEventId,
            attempt: flowContext.attempt,
            decision: decision.action,
            reason: decision.reason,
          },
          evidenceSummary: summarizeEvidenceForRouterPayload(data.evidence),
          sourceFunction: data.sourceFunction,
          targetComponent: data.targetComponent,
          attempt,
          decision,
        },
      });
      await emitSelfHealingCompleted(step, event.id, {
        domain,
        sourceFunction: data.sourceFunction,
        targetComponent: data.targetComponent,
        status: "escalated",
        action: decision.action,
        attempt,
        reason: decision.reason,
        evidence: data.evidence,
        playbook: data.playbook,
        flowContext,
        owner: data.owner,
        confidence: decision.confidence,
        model: decision.model,
      });
      return {
        status: "escalated",
        action: decision.action,
        reason: decision.reason,
      };
  }
);
