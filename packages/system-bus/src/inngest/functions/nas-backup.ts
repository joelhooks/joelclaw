import { $ } from "bun";
import { execSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { infer } from "../../lib/inference";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../../observability/emit";
import { assertAllowedModel } from "../../lib/models";
import { loadBackupFailureRouterConfig } from "../../lib/backup-failure-router-config";

const HOME_DIR = process.env.HOME ?? "/Users/joel";

const BACKUP_ROUTER_CONFIG = loadBackupFailureRouterConfig();
const NAS_NVME_ROOT = BACKUP_ROUTER_CONFIG.transport.nasNvmeRoot; // fast shared storage (1.78TB NVMe)
const NAS_HDD_ROOT = BACKUP_ROUTER_CONFIG.transport.nasHddRoot; // bulk archive (57TB HDD RAID5)

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_POD = "typesense-0";
const TYPESENSE_NAMESPACE = "joelclaw";
const TYPESENSE_SNAPSHOT_ROOT = "/data/snapshots";
const TYPESENSE_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/typesense`;
const TYPESENSE_STAGE_ROOT = "/tmp/joelclaw/typesense-snapshots";
const TYPESENSE_BACKUP_REMOTE_ROOT = "/volume1/joelclaw/backups/typesense";

const REDIS_POD = "redis-0";
const REDIS_NAMESPACE = "joelclaw";
const REDIS_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/redis`;
const REDIS_BACKUP_REMOTE_ROOT = "/volume1/joelclaw/backups/redis";
const REDIS_BACKUP_STAGING_ROOT = `${TYPESENSE_STAGE_ROOT}/redis`;

const BACKUP_RECOVERY_WINDOW_HOURS = BACKUP_ROUTER_CONFIG.transport.recoveryWindowHours;
const BACKUP_MAX_ATTEMPTS = BACKUP_ROUTER_CONFIG.transport.maxAttempts;
const BACKUP_RETRY_BASE_MS = BACKUP_ROUTER_CONFIG.transport.retryBaseMs;
const BACKUP_RETRY_MAX_MS = BACKUP_ROUTER_CONFIG.transport.retryMaxMs;
const BACKUP_FAILURE_ROUTER_MODEL = BACKUP_ROUTER_CONFIG.failureRouter.model;
const BACKUP_FAILURE_ROUTER_FALLBACK_MODEL = BACKUP_ROUTER_CONFIG.failureRouter.fallbackModel;
const BACKUP_ROUTER_MAX_RETRIES = BACKUP_ROUTER_CONFIG.failureRouter.maxRetries;
const BACKUP_ROUTER_SLEEP_MIN_MS = BACKUP_ROUTER_CONFIG.failureRouter.sleepMinMs;
const BACKUP_ROUTER_SLEEP_MAX_MS = BACKUP_ROUTER_CONFIG.failureRouter.sleepMaxMs;
const BACKUP_ROUTER_SLEEP_STEP_MS = BACKUP_ROUTER_CONFIG.failureRouter.sleepStepMs;
const NAS_SSH_HOST = BACKUP_ROUTER_CONFIG.transport.nasSshHost;
const NAS_SSH_FLAGS = BACKUP_ROUTER_CONFIG.transport.nasSshFlags;
const BACKUP_FAILURE_EVENT = "system/backup.failure.detected";
const SELF_HEALING_REQUEST_EVENT = "system/self.healing.requested";
const BACKUP_RETRY_REQUEST_EVENT = "system/backup.retry.requested";

const SESSIONS_BACKUP_ROOT = `${NAS_HDD_ROOT}/sessions`;
const CLAUDE_PROJECTS_ROOT = `${HOME_DIR}/.claude/projects`;
const PI_SESSIONS_ROOT = `${HOME_DIR}/.pi/sessions`;

const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_EXPORT_ROOT = `${NAS_HDD_ROOT}/otel`;

const MEMORY_LOG_ROOT = `${HOME_DIR}/.joelclaw/workspace/memory`;
const MEMORY_LOG_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/logs`;
const SLOG_PATH = `${HOME_DIR}/Vault/system/system-log.jsonl`;
const SLOG_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/slog`;

type BackupTarget = "typesense" | "redis";
type BackupFailureAction = "retry" | "pause" | "escalate";
type BackupFunctionId = "system/backup.typesense" | "system/backup.redis";
type BackupFailureDecision = {
  action: BackupFailureAction;
  delayMs: number;
  reason: string;
  confidence: number;
  model: string;
  routeTo: BackupFunctionId;
};

type BackupFailureEventData = {
  targetFunctionId: BackupFunctionId;
  target: BackupTarget;
  error: string;
  backupFailureDetectedAt: string;
  attempt: number;
  transportMode?: BackupMode;
  transportAttempts?: number;
  transportDestination?: string;
  retryWindowHours?: number;
  context?: Record<string, unknown>;
};

type SelfHealingPlaybook = {
  actions?: string[];
  restart?: string[];
  notify?: string[];
  links?: string[];
};

type SelfHealingEvidence = {
  type: string;
  detail: string;
};

type ShellResult = {
  exitCode: number;
  stdout: Buffer | Uint8Array | string;
  stderr: Buffer | Uint8Array | string;
};

type BackupMode = "local" | "remote";

type RetryResult = {
  mode: BackupMode;
  attempts: number;
};

type RetryError = Error | unknown;

type TypesenseHit = {
  document?: Record<string, unknown>;
};

type TypesenseSearchResult = {
  hits?: TypesenseHit[];
};

function parseAttempt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

type BackupFailureFlowContext = {
  flowContextKey: string;
  flowTrace: string[];
  sourceEventName: string;
  sourceEventId?: string;
  attempt: number;
};

function buildBackupFailureFlowContext(input: {
  eventName: string;
  eventId?: string;
  payload: BackupFailureEventData;
}): BackupFailureFlowContext {
  const attempt = Math.max(0, Math.floor(parseAttempt(input.payload.attempt, 0)));
  const sourceEventName = typeof input.eventName === "string" && input.eventName.trim().length > 0
    ? input.eventName.trim()
    : BACKUP_FAILURE_EVENT;
  return {
    flowContextKey: `${sourceEventName}::${input.payload.targetFunctionId}::${input.payload.target}::attempt-${attempt}`,
    flowTrace: [
      sourceEventName,
      "system/backup.failure.router",
      input.payload.targetFunctionId,
      input.payload.target,
      `attempt:${attempt}`,
    ],
    sourceEventName,
    sourceEventId: input.eventId,
    attempt,
  };
}

function extractSelfHealingEvidence(value: unknown): SelfHealingEvidence[] {
  if (!Array.isArray(value)) return [];
  const output: SelfHealingEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; detail?: unknown };
    if (typeof candidate.type === "string" && typeof candidate.detail === "string") {
      output.push({ type: candidate.type, detail: candidate.detail });
    }
  }
  return output;
}

function stringifyFailureError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function clampDelayMs(value: number): number {
  if (!Number.isFinite(value)) return BACKUP_ROUTER_SLEEP_MIN_MS;
  if (value <= 0) return BACKUP_ROUTER_SLEEP_MIN_MS;
  if (value > BACKUP_ROUTER_SLEEP_MAX_MS) return BACKUP_ROUTER_SLEEP_MAX_MS;
  return Math.floor(value);
}

function estimateRouterDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(BACKUP_ROUTER_SLEEP_MIN_MS * 2 ** boundedAttempt, BACKUP_ROUTER_SLEEP_MAX_MS);
  const jitter = Math.max(0, Math.floor(Math.random() * BACKUP_ROUTER_SLEEP_STEP_MS));
  return clampDelayMs(exponential + jitter);
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
    const extracted = trimmed.slice(start, end + 1);
    const extractedValue = parse(extracted);
    if (extractedValue !== null) return extractedValue;
  }

  return null;
}

function normalizeFailureDecision(
  raw: unknown,
  fallbackTarget: BackupFunctionId,
  fallbackAttempt: number
): BackupFailureDecision {
  const record = raw as Record<string, unknown>;
  const actionText = String(record?.action ?? record?.decision ?? record?.route ?? "").toLowerCase();
  const delayMsCandidate = parseAttempt(record?.delayMs, Number.NaN);
  const delaySecondsCandidate = parseAttempt(record?.delaySeconds, Number.NaN);
  const waitMinutesCandidate = parseAttempt(record?.waitMinutes, Number.NaN);
  const waitHoursCandidate = parseAttempt(record?.waitHours, Number.NaN);
  const routeCandidate = String(record?.routeTo ?? fallbackTarget) as BackupFunctionId | string;

  const action: BackupFailureAction =
    actionText.includes("retry") || actionText.includes("try") ? "retry" :
      actionText.includes("pause") || actionText.includes("wait") ? "pause" :
        "escalate";

  const confidenceCandidate = Number(record?.confidence);
  const reason =
    typeof record?.reason === "string" && record.reason.length > 0
      ? record.reason
      : "No reason supplied.";
  const parsedTarget =
    routeCandidate === "system/backup.redis" || routeCandidate === "system/backup.typesense"
      ? routeCandidate
      : fallbackTarget;
  const rawDelay =
    delayMsCandidate > 0
      ? delayMsCandidate
      : delaySecondsCandidate > 0
        ? delaySecondsCandidate * 1000
        : waitMinutesCandidate > 0
          ? waitMinutesCandidate * 60_000
          : waitHoursCandidate > 0
            ? waitHoursCandidate * 60 * 60_000
            : Number.NaN;

  const delayMs = clampDelayMs(Number.isFinite(rawDelay) ? rawDelay : estimateRouterDelayMs(fallbackAttempt));

  return {
    action,
    delayMs,
    reason,
    confidence: Number.isFinite(confidenceCandidate) ? confidenceCandidate : 0.5,
    model: typeof record?.model === "string" ? record.model : BACKUP_FAILURE_ROUTER_MODEL,
    routeTo: parsedTarget,
  };
}

async function analyzeBackupFailureWithPi(
  payload: BackupFailureEventData,
  attempt: number,
  isRetry: boolean
): Promise<BackupFailureDecision> {
  const systemPrompt = [
    "You are a senior SRE coding agent operating in the joelclaw system.",
    "Use Codex-style structured prompting: return only the requested JSON object, no prose, no markdown, no hidden reasoning.",
    "System shape:",
    "- Event bus is Inngest; this function is a failure router invoked from backup failure events.",
    "- Backup functions: `system/backup.typesense`, `system/backup.redis`.",
    "- Failure event: `system/backup.failure.detected`; retry event: `system/backup.retry.requested`.",
    "- If this decision requests another run, this function emits `system/backup.retry.requested`.",
    "Operational skills to honor where relevant:",
    "- inngest-* for durable orchestration and event-driven retries.",
    "- o11y-logging for telemetry/observability in all branches.",
    "- observability- and gateway-related flows stay structured and auditable.",
    "Return one strict JSON object and nothing else.",
    "Schema:",
    `{\n  "action": "retry|pause|escalate",\n  "delayMs": number,\n  "reason": string,\n  "routeTo": "system/backup.typesense|system/backup.redis",\n  "confidence": number (0-1)\n}`,
    "Use action=retry for recoverable transport failures or transient infra issues.",
    "Use action=pause when transient conditions likely require a bounded wait before a single reattempt.",
    "Use action=escalate when retries are unlikely to help.",
    "Delay should usually be in milliseconds and between 30_000 and 14_400_000.",
    "Prefer concrete reasoning in reason with concrete trigger signals from the event payload.",
  ].join("\n");

  const userPrompt = [
    "Failure event:",
    JSON.stringify(payload, null, 2),
    `Retry attempt: ${attempt}`,
    `Is this a repeated retry event: ${isRetry ? "true" : "false"}`,
  ].join("\n\n");

  assertAllowedModel(BACKUP_FAILURE_ROUTER_MODEL);
  assertAllowedModel(BACKUP_FAILURE_ROUTER_FALLBACK_MODEL);

  const analyzeWithModel = async (model: string) => {
    const inferResult = await infer(userPrompt, {
      task: "json",
      model,
      system: systemPrompt,
      component: "nas-backup",
      action: "system.backup.failure.analyze",
      metadata: {
        requestedModel: model,
        retryEvent: isRetry,
        attempt,
      },
    });
    const assistantText = inferResult.text;
    const parsed = parseJsonFromText(assistantText);

    if (!assistantText && !parsed) {
      throw new Error(`backup router fallback analysis failed for model ${model}`);
    }

    const decision = parsed === null ? normalizeFailureDecision({}, payload.targetFunctionId, attempt) : normalizeFailureDecision(parsed, payload.targetFunctionId, attempt);

    return {
      ...decision,
      model: inferResult.model ?? model,
    };
  };

  try {
    return await analyzeWithModel(BACKUP_FAILURE_ROUTER_MODEL);
  } catch {
    try {
      const fallbackDecision = await analyzeWithModel(BACKUP_FAILURE_ROUTER_FALLBACK_MODEL);
      if (fallbackDecision) {
        return fallbackDecision;
      }
    } catch {
      // fall through to local fallback
    }
    return {
      action: "retry",
      delayMs: estimateRouterDelayMs(attempt),
      reason: "Model analysis unavailable; using fallback backoff.",
      confidence: 0.35,
      model: BACKUP_FAILURE_ROUTER_FALLBACK_MODEL,
      routeTo: payload.targetFunctionId,
    };
  }
}

type SelfHealingRequestData = {
  sourceFunction: BackupFunctionId;
  targetComponent: string;
  routeToFunction?: BackupFunctionId;
  domain?: "backup" | "sdk-reachability" | "gateway-bridge" | "gateway-provider" | "otel-pipeline" | "all" | string;
  problemSummary: string;
  attempt?: number;
  targetEventName?: string;
  retryPolicy?: {
    maxRetries?: number;
    sleepMinMs?: number;
    sleepMaxMs?: number;
    sleepStepMs?: number;
  };
  evidence?: Array<SelfHealingEvidence>;
  playbook?: SelfHealingPlaybook;
  context?: Record<string, unknown>;
};

function summarizeBackupEvidence(
  evidence: Array<SelfHealingEvidence> | undefined,
): {
  count: number;
  samples: Array<SelfHealingEvidence>;
  types: string[];
} {
  const safeEvidence = Array.isArray(evidence) ? evidence : [];
  const sampleCount = Math.min(6, safeEvidence.length);
  return {
    count: safeEvidence.length,
    samples: safeEvidence.slice(0, sampleCount),
    types: [...new Set(safeEvidence.map((item) => item?.type?.trim() || "unknown"))],
  };
}

type BackupFailureOnFailureContext = {
  error: unknown;
  event: {
    id?: string;
    name: string;
    data?: Record<string, unknown>;
  };
  step: {
    sendEvent: (
      id: string,
      payload:
        | {
            name: typeof BACKUP_FAILURE_EVENT;
            data: BackupFailureEventData;
          }
        | {
            name: typeof SELF_HEALING_REQUEST_EVENT;
            data: SelfHealingRequestData;
          }
    ) => Promise<unknown>;
  };
};

type BackupRetryEventData = BackupFailureEventData & {
  decision?: BackupFailureDecision;
  attempt: number;
  nextAttempt?: number;
};

type BackupRouterContext = {
  event: {
    id?: string;
    name: string;
    data?: Record<string, unknown>;
  };
  step: {
    sleep: (name: string, duration: string) => Promise<void>;
    sendEvent: (
      id: string,
      payload:
        | {
            name: string;
            data: BackupRetryEventData;
          }
        | Array<{
            name: string;
            data: BackupRetryEventData;
          }>
    ) => Promise<{ ids: string[] }>;
  };
};

function createBackupOnFailureHandler(
  targetFunctionId: BackupFunctionId,
  target: BackupTarget
): (context: BackupFailureOnFailureContext) => Promise<void> {
  return async ({ error, event, step }) => {
    const eventData = event.data ?? {};
    const payload: BackupFailureEventData = {
      targetFunctionId,
      target,
      error: stringifyFailureError(error),
      backupFailureDetectedAt: new Date().toISOString(),
      attempt: parseAttempt(eventData?.attempt, 0),
      transportMode: typeof eventData?.transportMode === "string" ? (eventData.transportMode as BackupMode) : undefined,
      transportAttempts: parseAttempt(eventData?.transportAttempts, 0),
      transportDestination:
        typeof eventData?.transportDestination === "string" ? eventData.transportDestination : undefined,
      retryWindowHours: parseAttempt(eventData?.retryWindowHours, BACKUP_RECOVERY_WINDOW_HOURS),
    };
    const evidence = [
      {
        type: "backup-failure",
        detail: `targetFunctionId=${targetFunctionId}; target=${target}; attempt=${payload.attempt}`,
      },
      {
        type: "attempt",
        detail: `transportMode=${payload.transportMode ?? "unknown"} transportAttempts=${payload.transportAttempts ?? 0}`,
      },
    ] as SelfHealingEvidence[];
    const flowContext = buildBackupFailureFlowContext({
      eventName: event.name,
      eventId: event.id,
      payload,
    });
    payload.context = {
      sourceEventName: event.name,
      sourceEventId: event.id,
      runContext: flowContext,
      transportDestination: typeof eventData?.transportDestination === "string" ? eventData.transportDestination : undefined,
      retryWindowHours: parseAttempt(eventData?.retryWindowHours, BACKUP_RECOVERY_WINDOW_HOURS),
      backupFailureDetectedAt: payload.backupFailureDetectedAt,
      attempt: payload.attempt,
      sourceFunction: targetFunctionId,
      target,
      evidence,
    };
    const homeDir = process.env.HOME ?? "/Users/joel";
    const selfHealingPayload = {
      sourceFunction: targetFunctionId,
      targetComponent: `backup:${target}`,
      routeToFunction: targetFunctionId,
      domain: "backup",
      problemSummary: `${targetFunctionId}: ${payload.error}`,
      attempt: payload.attempt,
      targetEventName: BACKUP_RETRY_REQUEST_EVENT,
      retryPolicy: {
        maxRetries: BACKUP_ROUTER_MAX_RETRIES,
        sleepMinMs: BACKUP_ROUTER_SLEEP_MIN_MS,
        sleepMaxMs: BACKUP_ROUTER_SLEEP_MAX_MS,
        sleepStepMs: BACKUP_ROUTER_SLEEP_STEP_MS,
      },
      evidence,
      playbook: {
        actions: ["route to backup retry event after structured decision"],
        restart: [
          "Verify NAS mount via `stat /Volumes/three-body`",
          "Validate SSH access to configured NAS host",
        ],
        notify: ["joelclaw system logs and OTEL"],
        links: [
          `${homeDir}/Vault/system/system-log.jsonl`,
          `${homeDir}/.joelclaw/system-bus.config.json`,
        ],
      } as SelfHealingPlaybook,
      context: {
        runContext: flowContext,
        transportDestination: payload.transportDestination,
        retryWindowHours: payload.retryWindowHours,
        backupFailureDetectedAt: payload.backupFailureDetectedAt,
        sourceEventName: flowContext.sourceEventName,
        sourceEventId: flowContext.sourceEventId,
      },
    };

    try {
      await emitOtelEvent({
        level: "error",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.failure.detected",
        success: false,
        error: payload.error,
        metadata: {
          runContext: flowContext,
          evidenceSummary: summarizeBackupEvidence(evidence),
          targetFunctionId,
          target,
          eventId: event.id,
          attempt: payload.attempt,
          transportMode: payload.transportMode,
          transportAttempts: payload.transportAttempts,
          transportDestination: payload.transportDestination,
        },
      });

      await step.sendEvent("emit-backup-failure", {
        name: BACKUP_FAILURE_EVENT,
        data: payload,
      });
      await step.sendEvent("emit-self-healing-request", {
        name: SELF_HEALING_REQUEST_EVENT,
        data: selfHealingPayload,
      });
    } catch (error) {
      const details = stringifyFailureError(error);
      console.warn(`Failed to emit backup failure event for ${targetFunctionId}: ${event.id ?? "unknown event"}: ${details}`);
      await emitOtelEvent({
        level: "error",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.failure.dispatch",
        success: false,
        error: `failed to emit backup failure events: ${details}`,
        metadata: {
          runContext: flowContext,
          eventId: event.id,
          targetFunctionId,
          target,
          selfHealingContext: selfHealingPayload.context,
        },
      });
    }
  };
}

function isRetryEventForFunction(eventData: Record<string, unknown> | undefined, targetFunctionId: BackupFunctionId): boolean {
  if (!eventData) return true;

  const requestedTarget = String(eventData.targetFunctionId ?? "");
  if (!requestedTarget) return true;

  return requestedTarget === targetFunctionId;
}

function resolveEventAttempt(eventData: Record<string, unknown> | undefined): number {
  if (!eventData) return 0;
  return parseAttempt(eventData.attempt, 0);
}

function normalizeFailureTarget(value: unknown): BackupTarget {
  return value === "redis" ? "redis" : "typesense";
}

function normalizeFailureTargetFunction(value: unknown): BackupFunctionId {
  return value === "system/backup.redis" ? "system/backup.redis" : "system/backup.typesense";
}

function normalizeTargetFromFunction(value: BackupFunctionId): BackupTarget {
  return value === "system/backup.redis" ? "redis" : "typesense";
}

function normalizeRetryData(raw: Record<string, unknown>): BackupFailureEventData {
  const targetFunctionId = normalizeFailureTargetFunction(raw.targetFunctionId);
  return {
    targetFunctionId,
    target: normalizeFailureTarget(raw.target),
    error: stringifyFailureError(raw.error ?? "Unknown backup failure"),
    backupFailureDetectedAt:
      typeof raw.backupFailureDetectedAt === "string" ? raw.backupFailureDetectedAt : new Date().toISOString(),
    attempt: parseAttempt(raw.attempt, 0),
    transportMode:
      typeof raw.transportMode === "string"
        ? raw.transportMode === "remote"
          ? "remote"
          : "local"
      : undefined,
    transportAttempts: parseAttempt(raw.transportAttempts, 0),
    transportDestination:
      typeof raw.transportDestination === "string" ? raw.transportDestination : undefined,
    retryWindowHours: parseAttempt(raw.retryWindowHours, BACKUP_RECOVERY_WINDOW_HOURS),
    context: raw.context && typeof raw.context === "object" ? raw.context as Record<string, unknown> : undefined,
  };
}

function computeRetryDelayMs(attempt: number): number {
  const scaled = Math.min(BACKUP_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKUP_RETRY_MAX_MS);
  const jitter = Math.max(0, Math.min(1000, Math.floor(scaled * 0.2)));
  return scaled + Math.floor(Math.random() * (jitter + 1));
}

function isRetryableBackupError(error: RetryError): boolean {
  const message = toText((error as Error)?.message ?? `${error ?? ""}`).toLowerCase();
  return /operation timed out|timed out|timeout|connection/i.test(message)
    || /connect.*timed out|no route to host|network is unreachable|econn|ssh:|resource temporarily unavailable/i.test(message)
    || /input\/output|i\/o error|stale file handle|temporary failure|server is unavailable/i.test(message);
}

async function checkLocalBackupTarget(path: string): Promise<boolean> {
  const probe = `${path}/.joelclaw-backup-probe-${Date.now()}`;
  try {
    await runShell(
      `mkdir -p ${path}`,
      $`mkdir -p ${path}`.quiet().nothrow()
    );
    await runShell(
      `touch ${probe} && rm -f ${probe}`,
      $`touch ${probe} && rm -f ${probe}`.quiet().nothrow()
    );
    return true;
  } catch {
    return false;
  }
}

async function checkRemoteBackupTarget(path: string): Promise<boolean> {
  const mkdirResult = await $`ssh ${NAS_SSH_FLAGS} ${NAS_SSH_HOST} "mkdir -p ${path}"`.quiet().nothrow();
  if (mkdirResult.exitCode !== 0) return false;

  const probe = `${path}/.joelclaw-backup-probe-${Date.now()}`;
  const probeResult = await $`ssh ${NAS_SSH_FLAGS} ${NAS_SSH_HOST} "touch ${probe} && rm -f ${probe}"`.quiet().nothrow();
  return probeResult.exitCode === 0;
}

async function ensureRemoteDirectory(path: string): Promise<void> {
  await runShell(
    `mkdir -p ${path} via remote`,
    $`ssh ${NAS_SSH_FLAGS} ${NAS_SSH_HOST} "mkdir -p ${path}"`.quiet().nothrow()
  );
}

async function runWithBackupTransport<T>(
  label: string,
  localPath: string,
  remotePath: string,
  runLocal: () => Promise<T>,
  runRemote: () => Promise<T>,
): Promise<RetryResult & { result: T }> {
  const start = Date.now();
  const timeoutMs = BACKUP_RECOVERY_WINDOW_HOURS * 60 * 60 * 1000;
  const deadline = start + timeoutMs;
  let mode: BackupMode = "local";
  let lastError: RetryError;
  let attempts = 0;

  for (let attempt = 1; attempt <= BACKUP_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    if (Date.now() > deadline) break;

    if (mode === "local") {
      const localOk = await checkLocalBackupTarget(localPath);
      if (localOk) {
        try {
          const result = await runLocal();
          return { mode, attempts, result };
        } catch (error) {
          lastError = error;
          if (!isRetryableBackupError(error)) {
            throw error;
          }
          const remoteOk = await checkRemoteBackupTarget(remotePath);
          if (remoteOk) mode = "remote";
        }
      } else {
        const remoteOk = await checkRemoteBackupTarget(remotePath);
        if (remoteOk) {
          mode = "remote";
        }
      }
    } else {
      const remoteOk = await checkRemoteBackupTarget(remotePath);
      if (remoteOk) {
        try {
          const result = await runRemote();
          return { mode, attempts, result };
        } catch (error) {
          lastError = error;
          if (!isRetryableBackupError(error)) {
            throw error;
          }
          const localOk = await checkLocalBackupTarget(localPath);
          if (localOk) mode = "local";
        }
      } else {
        const localOk = await checkLocalBackupTarget(localPath);
        if (localOk) {
          mode = "local";
        }
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || attempt >= BACKUP_MAX_ATTEMPTS) break;
    await Bun.sleep(Math.min(computeRetryDelayMs(attempt), remainingMs));
  }

  throw (lastError as Error) ?? new Error(`${label} failed after ${attempts} attempts in ${BACKUP_RECOVERY_WINDOW_HOURS}h`);
}

async function copyDirectoryWithFallback(
  source: string,
  localDestination: string,
  remoteDestination: string,
): Promise<RetryResult> {
  const { mode, attempts } = await runWithBackupTransport(
    `copy ${source} to backup target`,
    localDestination,
    remoteDestination,
    async () => {
      await runShell(
        `mkdir -p ${localDestination}`,
        $`mkdir -p ${localDestination}`.quiet().nothrow()
      );
      await runShell(
        `rsync -az ${source}/ ${localDestination}/`,
        $`rsync -az ${source}/ ${localDestination}/`.quiet().nothrow()
      );
      return;
    },
    async () => {
      await ensureRemoteDirectory(remoteDestination);
      await runShell(
        `scp -r ${source}/. ${NAS_SSH_HOST}:${remoteDestination}/`,
        $`scp -o ${NAS_SSH_FLAGS} -r ${source}/. ${NAS_SSH_HOST}:${remoteDestination}/`.quiet().nothrow()
      );
      return;
    }
  );

  return { mode, attempts };
}

async function copyFileWithFallback(
  source: string,
  localDestination: string,
  remoteDestination: string,
): Promise<RetryResult> {
  const localDir = dirname(localDestination);
  const remoteDir = dirname(remoteDestination);
  const { mode, attempts } = await runWithBackupTransport(
    `copy file ${source} to backup target`,
    localDir,
    remoteDir,
    async () => {
      await runShell(
        `mkdir -p ${localDir}`,
        $`mkdir -p ${localDir}`.quiet().nothrow()
      );
      await runShell(
        `cp ${source} ${localDestination}`,
        $`cp ${source} ${localDestination}`.quiet().nothrow()
      );
      return;
    },
    async () => {
      await ensureRemoteDirectory(remoteDir);
      await runShell(
        `scp ${source} to remote backup`,
        $`scp -o ${NAS_SSH_FLAGS} ${source} ${NAS_SSH_HOST}:${remoteDestination}`.quiet().nothrow()
      );
      return;
    }
  );

  return { mode, attempts };
}

function toText(value: Buffer | Uint8Array | string): string {
  if (typeof value === "string") return value.trim();
  return Buffer.from(value).toString("utf8").trim();
}

function commandError(command: string, result: ShellResult): Error {
  const stderr = toText(result.stderr);
  const stdout = toText(result.stdout);
  return new Error(
    `${command} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`
  );
}

async function runShell(command: string, run: Promise<ShellResult>): Promise<ShellResult> {
  const result = await run;
  if (result.exitCode !== 0) throw commandError(command, result);
  return result;
}

function formatLosAngelesParts(now = new Date()): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
  };
}

function getDateStamp(now = new Date()): string {
  const parts = formatLosAngelesParts(now);
  return `${parts.year}${parts.month}${parts.day}`;
}

function getMonthStamp(now = new Date()): string {
  const parts = formatLosAngelesParts(now);
  return `${parts.year}${parts.month}`;
}

function getTypesenseApiKey(): string {
  if (process.env.TYPESENSE_API_KEY && process.env.TYPESENSE_API_KEY.trim().length > 0) {
    return process.env.TYPESENSE_API_KEY.trim();
  }

  try {
    return execSync("secrets lease typesense_api_key --ttl 5m", {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("No TYPESENSE_API_KEY and secrets lease failed");
  }
}

async function ensureNasMounted(): Promise<void> {
  const result = await $`stat ${NAS_HDD_ROOT}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = toText(result.stderr);
    throw new NonRetriableError(
      `NAS mount unavailable at ${NAS_HDD_ROOT}${stderr ? `: ${stderr}` : ""}`
    );
  }
}

async function ensureDir(path: string): Promise<void> {
  await runShell(
    `mkdir -p ${path}`,
    $`mkdir -p ${path}`.quiet().nothrow()
  );
}

async function pathExists(path: string): Promise<boolean> {
  const result = await $`stat ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function listFilesOlderThanDays(
  root: string,
  olderThanDays: number,
  glob?: string
): Promise<string[]> {
  if (!(await pathExists(root))) return [];

  const result = glob
    ? await runShell(
      `find ${root} -type f -name ${glob} -mtime +${olderThanDays} -print`,
      $`find ${root} -type f -name ${glob} -mtime +${olderThanDays} -print`.quiet().nothrow()
    )
    : await runShell(
      `find ${root} -type f -mtime +${olderThanDays} -print`,
      $`find ${root} -type f -mtime +${olderThanDays} -print`.quiet().nothrow()
    );

  const stdout = toText(result.stdout);
  if (!stdout) return [];
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function destinationFromSourceRoot(filePath: string, sourceRoot: string, destinationRoot: string): string {
  const sourceRelative = relative(sourceRoot, filePath);
  if (!sourceRelative || sourceRelative.startsWith("..")) {
    return join(destinationRoot, basename(filePath));
  }
  return join(destinationRoot, sourceRelative);
}

function destinationFromHome(filePath: string, destinationRoot: string): string {
  const sourceRelative = relative(HOME_DIR, filePath);
  if (!sourceRelative || sourceRelative.startsWith("..")) {
    return join(destinationRoot, basename(filePath));
  }
  return join(destinationRoot, sourceRelative);
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  await ensureDir(dirname(targetPath));
  await runShell(
    `mv ${sourcePath} ${targetPath}`,
    $`mv ${sourcePath} ${targetPath}`.quiet().nothrow()
  );
}

async function triggerTypesenseSnapshot(snapshotPath: string): Promise<unknown> {
  const apiKey = getTypesenseApiKey();
  const response = await fetch(
    `${TYPESENSE_URL}/operations/snapshot?snapshot_path=${encodeURIComponent(snapshotPath)}`,
    {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense snapshot failed (${response.status}): ${responseText}`);
  }

  if (!responseText) return {};
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return { raw: responseText };
  }
}

async function fetchOtelPage(
  cutoffTimestamp: number,
  page: number,
  perPage: number
): Promise<Record<string, unknown>[]> {
  const apiKey = getTypesenseApiKey();
  const params = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    per_page: String(perPage),
    page: String(page),
    sort_by: "timestamp:asc",
    filter_by: `timestamp:<${Math.floor(cutoffTimestamp)}`,
  });

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents/search?${params.toString()}`,
    {
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense otel search failed (${response.status}): ${responseText}`);
  }

  let parsed: TypesenseSearchResult = {};
  if (responseText) {
    parsed = JSON.parse(responseText) as TypesenseSearchResult;
  }
  const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
  return hits
    .map((hit) => hit.document)
    .filter((doc): doc is Record<string, unknown> => !!doc && typeof doc === "object");
}

async function exportOtelEvents(cutoffTimestamp: number, outputPath: string): Promise<number> {
  const perPage = 250;
  let page = 1;
  let count = 0;

  const writer = createWriteStream(outputPath, { flags: "w" });
  try {
    while (true) {
      const documents = await fetchOtelPage(cutoffTimestamp, page, perPage);
      if (documents.length === 0) break;

      for (const document of documents) {
        writer.write(`${JSON.stringify(document)}\n`);
        count += 1;
      }

      if (documents.length < perPage) break;
      page += 1;
    }
  } finally {
    writer.end();
    await once(writer, "finish");
  }

  return count;
}

async function deleteOtelEvents(cutoffTimestamp: number): Promise<number> {
  const apiKey = getTypesenseApiKey();
  const filterBy = `timestamp:<${Math.floor(cutoffTimestamp)}`;
  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents?batch_size=500&filter_by=${encodeURIComponent(filterBy)}`,
    {
      method: "DELETE",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense otel delete failed (${response.status}): ${responseText}`);
  }

  if (!responseText) return 0;
  try {
    const parsed = JSON.parse(responseText) as { num_deleted?: number };
    return typeof parsed.num_deleted === "number" ? parsed.num_deleted : 0;
  } catch {
    return 0;
  }
}

export const backupTypesense = inngest.createFunction(
  {
    id: "system/backup.typesense",
    name: "Backup Typesense Snapshot to NAS",
    concurrency: { limit: 1 },
    retries: 2,
    onFailure: createBackupOnFailureHandler("system/backup.typesense", "typesense"),
  },
  [{ cron: "TZ=America/Los_Angeles 0 3 * * *" }, { event: BACKUP_RETRY_REQUEST_EVENT }],
  async ({ step, event }) => {
    const metadata: Record<string, unknown> = {
      schedule: "daily_3am_pt",
      mount: NAS_HDD_ROOT,
    };

    const eventData = event.data as Record<string, unknown> | undefined;
    if (!isRetryEventForFunction(eventData, "system/backup.typesense")) {
      return { skipped: true, reason: "event-target-mismatch" };
    }

    const attempt = resolveEventAttempt(eventData);
    let transportMode: BackupMode = "local";
    let transportAttempts = 0;

    if (attempt > 0) {
      metadata.retryAttempt = attempt;
    }

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.typesense",
        metadata,
      },
      async () => {
        const dateStamp = await step.run("resolve-date-stamp", async () => getDateStamp());
        const snapshotPath = `${TYPESENSE_SNAPSHOT_ROOT}/${dateStamp}`;
        const stagedSnapshotPath = `${TYPESENSE_STAGE_ROOT}/${dateStamp}`;
        const destinationPath = `${TYPESENSE_BACKUP_ROOT}/${dateStamp}`;
        const remoteDestinationPath = `${TYPESENSE_BACKUP_REMOTE_ROOT}/${dateStamp}`;

        await step.run("prepare-directories", async () => {
          await ensureDir(TYPESENSE_STAGE_ROOT);
          await runShell(
            `rm -rf ${stagedSnapshotPath}`,
            $`rm -rf ${stagedSnapshotPath}`.quiet().nothrow()
          );
        });

        const snapshotResult = await step.run("trigger-snapshot", async () =>
          triggerTypesenseSnapshot(snapshotPath)
        );

        await step.run("copy-snapshot-to-host", async () => {
          // kubectl cp strips the source directory name when copying into an existing local dir.
          // Copy snapshot contents into an explicit dated staging directory so rsync has a stable source path.
          await ensureDir(stagedSnapshotPath);
          await runShell(
            `kubectl cp -n ${TYPESENSE_NAMESPACE} ${TYPESENSE_POD}:${snapshotPath}/. ${stagedSnapshotPath}`,
            $`kubectl cp -n ${TYPESENSE_NAMESPACE} ${TYPESENSE_POD}:${snapshotPath}/. ${stagedSnapshotPath}`.quiet().nothrow()
          );

          const snapshotContentProbe = await runShell(
            `find ${stagedSnapshotPath} -mindepth 1 -print -quit`,
            $`find ${stagedSnapshotPath} -mindepth 1 -print -quit`.quiet().nothrow()
          );
          if (!toText(snapshotContentProbe.stdout)) {
            throw new Error(`No Typesense snapshot files staged at ${stagedSnapshotPath}`);
          }
        });

        await step.run("sync-snapshot-to-nas", async () => {
          const result = await copyDirectoryWithFallback(
            stagedSnapshotPath,
            destinationPath,
            remoteDestinationPath
          );
          transportMode = result.mode;
          transportAttempts = result.attempts;
        });

        await step.run("cleanup-stage", async () => {
          await runShell(
            `rm -rf ${stagedSnapshotPath}`,
            $`rm -rf ${stagedSnapshotPath}`.quiet().nothrow()
          );
        });

        metadata.date = dateStamp;
        metadata.snapshotPath = snapshotPath;
        metadata.destinationPath = destinationPath;
        metadata.remoteDestinationPath = remoteDestinationPath;
        metadata.retryAttempt = attempt;
        metadata.transportMode = transportMode;
        metadata.transportAttempts = transportAttempts;
        metadata.snapshotResult = snapshotResult;

        return {
          date: dateStamp,
          transportMode,
          transportAttempts,
          snapshotPath,
          destinationPath,
        };
      }
    );
  }
);

export const backupRedis = inngest.createFunction(
  {
    id: "system/backup.redis",
    name: "Backup Redis RDB to NAS",
    concurrency: { limit: 1 },
    retries: 2,
    onFailure: createBackupOnFailureHandler("system/backup.redis", "redis"),
  },
  [{ cron: "TZ=America/Los_Angeles 30 3 * * *" }, { event: BACKUP_RETRY_REQUEST_EVENT }],
  async ({ step, event }) => {
    const metadata: Record<string, unknown> = {
      schedule: "daily_330am_pt",
      mount: NAS_HDD_ROOT,
    };

    const eventData = event.data as Record<string, unknown> | undefined;
    if (!isRetryEventForFunction(eventData, "system/backup.redis")) {
      return { skipped: true, reason: "event-target-mismatch" };
    }

    const attempt = resolveEventAttempt(eventData);
    let transportMode: BackupMode = "local";
    let transportAttempts = 0;

    if (attempt > 0) {
      metadata.retryAttempt = attempt;
    }

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.redis",
        metadata,
      },
      async () => {
        const dateStamp = await step.run("resolve-date-stamp", async () => getDateStamp());
        const destinationPath = `${REDIS_BACKUP_ROOT}/dump-${dateStamp}.rdb`;
        const stagingPath = `${REDIS_BACKUP_STAGING_ROOT}/${dateStamp}/dump.rdb`;
        const remoteDestinationPath = `${REDIS_BACKUP_REMOTE_ROOT}/dump-${dateStamp}.rdb`;

        await step.run("prepare-redis-backup-dir", async () => {
          await ensureDir(REDIS_BACKUP_STAGING_ROOT);
          await ensureDir(dirname(stagingPath));
          await runShell(`rm -f ${stagingPath}`, $`rm -f ${stagingPath}`.quiet().nothrow());
        });

        await step.run("trigger-redis-bgsave", async () => {
          await runShell(
            `kubectl exec -n ${REDIS_NAMESPACE} ${REDIS_POD} -- redis-cli BGSAVE`,
            $`kubectl exec -n ${REDIS_NAMESPACE} ${REDIS_POD} -- redis-cli BGSAVE`.quiet().nothrow()
          );
        });

        await step.run("wait-for-bgsave", async () => {
          await Bun.sleep(10_000);
        });

        await step.run("copy-redis-rdb", async () => {
          await runShell(
            `kubectl cp -n ${REDIS_NAMESPACE} ${REDIS_POD}:/data/dump.rdb ${stagingPath}`,
            $`kubectl cp -n ${REDIS_NAMESPACE} ${REDIS_POD}:/data/dump.rdb ${stagingPath}`.quiet().nothrow()
          );
        });

        await step.run("copy-redis-rdb-to-nas", async () => {
          const result = await copyFileWithFallback(stagingPath, destinationPath, remoteDestinationPath);
          transportMode = result.mode;
          transportAttempts = result.attempts;
        });

        await step.run("cleanup-redis-stage", async () => {
          await runShell(`rm -f ${stagingPath}`, $`rm -f ${stagingPath}`.quiet().nothrow());
        });

        metadata.date = dateStamp;
        metadata.destinationPath = destinationPath;
        metadata.remoteDestinationPath = remoteDestinationPath;
        metadata.retryAttempt = attempt;
        metadata.transportMode = transportMode;
        metadata.transportAttempts = transportAttempts;

        return {
          date: dateStamp,
          transportMode,
          transportAttempts,
          destinationPath,
        };
      }
    );
  }
);

export const backupFailureRouter = inngest.createFunction(
  {
    id: "system/backup.failure.router",
    name: "Route Backup Failures",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ event: BACKUP_FAILURE_EVENT }],
  async ({ event, step }: BackupRouterContext): Promise<{
    status: "escalated" | "scheduled";
    targetFunctionId: BackupFunctionId;
    reason?: string;
    attempt: number;
    delayMs?: number;
  }> => {
    const eventDataRaw = (event.data ?? {}) as Record<string, unknown>;
    const payload = normalizeRetryData(eventDataRaw);
    const attempt = parseAttempt(eventDataRaw.attempt, 0);
    const isRetry = attempt > 0;
    const flowContext = buildBackupFailureFlowContext({
      eventName: event.name,
      eventId: event.id,
      payload,
    });
    const eventContext = eventDataRaw.context;
    const evidenceSummary = summarizeBackupEvidence(
      extractSelfHealingEvidence(
        typeof eventContext === "object" && eventContext !== null && "evidence" in eventContext
          ? (eventContext as Record<string, unknown>).evidence
          : undefined,
      ),
    );
    const decision = await analyzeBackupFailureWithPi(payload, attempt, isRetry);

    await emitOtelEvent({
      level: "info",
      source: "worker",
      component: "nas-backup",
      action: "system.backup.failure.router",
      success: true,
      metadata: {
        runContext: flowContext,
        eventId: event.id,
        targetFunctionId: payload.targetFunctionId,
        target: payload.target,
        attempt,
        isRetry,
        evidenceSummary,
        decision,
      },
    });

    if (decision.action === "retry" || decision.action === "pause") {
      const retryAttempt = Math.max(attempt, 0) + 1;
      if (retryAttempt > BACKUP_ROUTER_MAX_RETRIES) {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "nas-backup",
          action: "system.backup.failure.router",
          success: false,
          error: `Retry budget exceeded for ${payload.targetFunctionId} at attempt ${retryAttempt}`,
          metadata: {
            runContext: flowContext,
            eventId: event.id,
            targetFunctionId: payload.targetFunctionId,
            target: payload.target,
            attempt,
            maxRetries: BACKUP_ROUTER_MAX_RETRIES,
            nextAttempt: retryAttempt,
            evidenceSummary,
            decision,
          },
        });
        return {
          status: "escalated",
          reason: `Retry budget exceeded (${retryAttempt} attempts)`,
          targetFunctionId: payload.targetFunctionId,
          attempt,
        };
      }

      const delayMs = decision.delayMs > 0 ? decision.delayMs : estimateRouterDelayMs(attempt);
      await step.sleep("backup-retry-wait", formatInngestSleepDelay(delayMs));

      await step.sendEvent("request-backup-retry", {
        name: BACKUP_RETRY_REQUEST_EVENT,
        data: {
          ...payload,
          targetFunctionId: decision.routeTo,
          target: normalizeTargetFromFunction(decision.routeTo),
          attempt: retryAttempt,
          nextAttempt: retryAttempt,
          decision,
        },
      });

      return {
        status: "scheduled",
        targetFunctionId: decision.routeTo,
        attempt: retryAttempt,
        delayMs,
        reason: decision.reason,
      };
    }

    await emitOtelEvent({
      level: "error",
      source: "worker",
      component: "nas-backup",
      action: "system.backup.failure.router",
      success: false,
      error: `Escalating backup failure for ${payload.targetFunctionId}: ${decision.reason}`,
      metadata: {
        runContext: flowContext,
        eventId: event.id,
        targetFunctionId: payload.targetFunctionId,
        target: payload.target,
        attempt,
        evidenceSummary,
        decision,
      },
    });

    return {
      status: "escalated",
      reason: decision.reason,
      targetFunctionId: payload.targetFunctionId,
      attempt,
    };
  }
);

export const rotateSessions = inngest.createFunction(
  {
    id: "system/rotate.sessions",
    name: "Rotate Old Session Files to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 0 4 * * 0" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "weekly_sunday_4am_pt",
      mount: NAS_HDD_ROOT,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.sessions",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        await step.run("prepare-sessions-dir", async () => {
          await ensureDir(SESSIONS_BACKUP_ROOT);
        });

        const claudeFiles = await step.run("list-claude-sessions", async () =>
          listFilesOlderThanDays(CLAUDE_PROJECTS_ROOT, 7, "*.jsonl")
        );
        const piFiles = await step.run("list-pi-sessions", async () =>
          listFilesOlderThanDays(PI_SESSIONS_ROOT, 7)
        );

        const filesToMove = [...claudeFiles, ...piFiles];

        const movedCount = await step.run("move-session-files", async () => {
          let moved = 0;
          for (const filePath of filesToMove) {
            const destinationPath = destinationFromHome(filePath, SESSIONS_BACKUP_ROOT);
            await moveFile(filePath, destinationPath);
            moved += 1;
          }
          return moved;
        });

        metadata.filesExamined = filesToMove.length;
        metadata.rotatedCount = movedCount;
        metadata.claudeCount = claudeFiles.length;
        metadata.piCount = piFiles.length;

        return {
          rotatedCount: movedCount,
          claudeCount: claudeFiles.length,
          piCount: piFiles.length,
        };
      }
    );
  }
);

export const rotateOtel = inngest.createFunction(
  {
    id: "system/rotate.otel",
    name: "Rotate OTEL Events to NAS Archive",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 0 4 1 * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "monthly_1st_4am_pt",
      mount: NAS_HDD_ROOT,
      retentionDays: 90,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.otel",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const monthStamp = await step.run("resolve-month-stamp", async () => getMonthStamp());
        const outputPath = `${OTEL_EXPORT_ROOT}/otel-${monthStamp}.jsonl`;
        const cutoffTimestamp = Date.now() - (90 * 24 * 60 * 60 * 1000);

        await step.run("prepare-otel-dir", async () => {
          await ensureDir(OTEL_EXPORT_ROOT);
        });

        const exportedCount = await step.run("export-otel-events", async () =>
          exportOtelEvents(cutoffTimestamp, outputPath)
        );

        const deletedCount = await step.run("delete-exported-otel-events", async () => {
          if (exportedCount === 0) return 0;
          return deleteOtelEvents(cutoffTimestamp);
        });

        metadata.month = monthStamp;
        metadata.outputPath = outputPath;
        metadata.cutoffTimestamp = cutoffTimestamp;
        metadata.exportedCount = exportedCount;
        metadata.deletedCount = deletedCount;

        return {
          month: monthStamp,
          outputPath,
          exportedCount,
          deletedCount,
        };
      }
    );
  }
);

export const rotateLogs = inngest.createFunction(
  {
    id: "system/rotate.logs",
    name: "Rotate Local Logs to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 30 4 1 * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "monthly_1st_430am_pt",
      mount: NAS_HDD_ROOT,
      retentionDays: 30,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.logs",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const monthStamp = await step.run("resolve-month-stamp", async () => getMonthStamp());
        const slogDestinationPath = `${SLOG_BACKUP_ROOT}/system-log-${monthStamp}.jsonl`;

        await step.run("prepare-log-dirs", async () => {
          await ensureDir(MEMORY_LOG_BACKUP_ROOT);
          await ensureDir(SLOG_BACKUP_ROOT);
        });

        const oldLogFiles = await step.run("list-old-memory-logs", async () =>
          listFilesOlderThanDays(MEMORY_LOG_ROOT, 30)
        );

        const movedLogs = await step.run("move-old-memory-logs", async () => {
          let moved = 0;
          for (const filePath of oldLogFiles) {
            const destinationPath = destinationFromSourceRoot(filePath, MEMORY_LOG_ROOT, MEMORY_LOG_BACKUP_ROOT);
            await moveFile(filePath, destinationPath);
            moved += 1;
          }
          return moved;
        });

        await step.run("copy-current-slog", async () => {
          await runShell(
            `cp ${SLOG_PATH} ${slogDestinationPath}`,
            $`cp ${SLOG_PATH} ${slogDestinationPath}`.quiet().nothrow()
          );
        });

        metadata.month = monthStamp;
        metadata.movedLogs = movedLogs;
        metadata.slogDestinationPath = slogDestinationPath;

        return {
          month: monthStamp,
          movedLogs,
          slogDestinationPath,
        };
      }
    );
  }
);
