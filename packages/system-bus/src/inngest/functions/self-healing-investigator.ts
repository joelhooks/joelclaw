import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { restartWorker } from "../../observability/auto-fixes/restart-worker";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const INNGEST_BASE_URL = process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
const SELF_HEALING_REDIS_KEY_PREFIX = "self-healing:sdk-url:run:";
const SELF_HEALING_RUN_TTL_SECONDS = Number.parseInt(
  process.env.SELF_HEALING_RUN_TTL_SECONDS ?? "21600",
  10
);
const SELF_HEALING_DEFAULT_LOOKBACK_MINUTES = Number.parseInt(
  process.env.SELF_HEALING_LOOKBACK_MINUTES ?? "20",
  10
);
const SELF_HEALING_DEFAULT_MAX_RUNS = Number.parseInt(
  process.env.SELF_HEALING_MAX_RUNS ?? "40",
  10
);
const SELF_HEALING_MAX_DETAILS_PER_TICK = Number.parseInt(
  process.env.SELF_HEALING_MAX_DETAILS_PER_TICK ?? "12",
  10
);
const SELF_HEALING_FAILED_RUNS_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.SELF_HEALING_FAILED_RUNS_TIMEOUT_MS ?? "30000", 10)
);
const SELF_HEALING_FAILED_RUNS_RETRY_TIMEOUT_MS = Math.max(
  SELF_HEALING_FAILED_RUNS_TIMEOUT_MS,
  Number.parseInt(process.env.SELF_HEALING_FAILED_RUNS_RETRY_TIMEOUT_MS ?? "45000", 10)
);
const SDK_REACHABILITY_ERROR_REGEX = /Unable to reach SDK URL/iu;

type FailedRunNode = {
  id: string;
  status: string;
  function?: {
    name?: string | null;
    slug?: string | null;
  } | null;
  startedAt?: string | null;
};

type RunSummary = {
  id: string;
  functionName: string;
  functionSlug: string;
  startedAt: string;
};

type InvestigatorInput = {
  domain?: string;
  reason?: string;
  requestedBy?: string;
  lookbackMinutes?: number;
  maxRuns?: number;
  dryRun?: boolean;
};

type SelfHealingInvestigatorFlowContext = {
  flowContextKey: string;
  sourceEventId?: string;
  sourceEventName?: string;
  attempt: number;
  evidenceCount: number;
};

function buildInvestigatorFlowContext(input: {
  sourceFunction?: string;
  domain: string;
  targetComponent: string;
  eventId?: string;
  eventName?: string;
  attempt?: number;
  evidenceCount?: number;
}): SelfHealingInvestigatorFlowContext {
  const sourceFunction = toSafeText(input.sourceFunction, "system/self-healing.router");
  const domain = toSafeText(input.domain, "unknown");
  const target = toSafeText(input.targetComponent, "system/self-healing.investigator");
  const eventName = toSafeText(input.eventName, "system/self.healing.requested");
  const safeAttempt = Math.max(0, Math.floor(input.attempt ?? 0));
  const safeEvidenceCount = Math.max(0, Math.floor(input.evidenceCount ?? 0));
  return {
    flowContextKey: `${eventName}::${sourceFunction}::${domain}::${target}::a${safeAttempt}::e${safeEvidenceCount}`,
    sourceEventId: input.eventId,
    sourceEventName: eventName,
    attempt: safeAttempt,
    evidenceCount: safeEvidenceCount,
  };
}

function toSafeInt(value: unknown, fallback: number, min = 1, max = 500): number {
  const raw = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function lookbackFromIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function redisRunKey(runId: string): string {
  return `${SELF_HEALING_REDIS_KEY_PREFIX}${runId}`;
}

function trimForMetadata(value: string, max = 220): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(max - 3, 1))}...`;
}

function toSafeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return name === "AbortError" || /aborted|timed out/i.test(message);
}

function resolveFailedRunsQueryTimeoutMs(maxRuns: number): number {
  const safeRuns = Number.isFinite(maxRuns) ? Math.max(1, Math.floor(maxRuns)) : SELF_HEALING_DEFAULT_MAX_RUNS;
  if (safeRuns <= 20) return SELF_HEALING_FAILED_RUNS_TIMEOUT_MS;
  if (safeRuns <= 60) return Math.min(SELF_HEALING_FAILED_RUNS_RETRY_TIMEOUT_MS, SELF_HEALING_FAILED_RUNS_TIMEOUT_MS + 10_000);
  return SELF_HEALING_FAILED_RUNS_RETRY_TIMEOUT_MS;
}

async function fetchInngestGraphql(query: string, timeoutMs: number, retryTimeoutMs: number): Promise<Response> {
  const execute = (requestTimeoutMs: number) => fetch(`${INNGEST_BASE_URL}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  try {
    return await execute(timeoutMs);
  } catch (error) {
    if (retryTimeoutMs > timeoutMs && isAbortLikeError(error)) {
      return await execute(retryTimeoutMs);
    }
    throw error;
  }
}

async function listRecentFailedRuns(fromIso: string, maxRuns: number): Promise<RunSummary[]> {
  const query = `
    query {
      runs(
        first: ${Math.min(maxRuns, 200)}
        orderBy: [{ field: STARTED_AT, direction: DESC }]
        filter: { status: [FAILED], from: "${fromIso}" }
      ) {
        edges {
          node {
            id
            status
            startedAt
            function {
              name
              slug
            }
          }
        }
      }
    }
  `;

  const timeoutMs = resolveFailedRunsQueryTimeoutMs(maxRuns);
  const response = await fetchInngestGraphql(
    query,
    timeoutMs,
    Math.max(timeoutMs, SELF_HEALING_FAILED_RUNS_RETRY_TIMEOUT_MS),
  );

  if (!response.ok) {
    throw new Error(`failed-run query failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as {
    errors?: Array<{ message?: string }>;
    data?: {
      runs?: {
        edges?: Array<{ node?: FailedRunNode | null }>;
      };
    };
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message ?? "unknown error").join("; "));
  }

  const edges = json.data?.runs?.edges ?? [];
  const runs: RunSummary[] = [];

  for (const edge of edges) {
    const node = edge.node;
    if (!node?.id) continue;

    const functionSlug = node.function?.slug?.trim() ?? "";
    const isLegacyArchivedSlug =
      functionSlug.startsWith("system-bus-") && !functionSlug.startsWith("system-bus-host-");
    if (isLegacyArchivedSlug) continue;

    runs.push({
      id: node.id,
      functionName: node.function?.name?.trim() || "unknown",
      functionSlug,
      startedAt: node.startedAt ?? "",
    });
  }

  return runs;
}

async function loadRunOutputViaCli(runId: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const result = await Bun.$`joelclaw run ${runId}`.quiet().nothrow();
  const stdout = (await result.text()).trim();
  const stderr = Buffer.from(result.stderr ?? "").toString("utf8").trim();

  if (result.exitCode !== 0 || !stdout) {
    return {
      ok: false,
      output: "",
      error: stderr || `joelclaw run exited ${result.exitCode}`,
    };
  }

  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        run?: {
          output?: unknown;
        };
      };
    };
    const output = parsed.result?.run?.output;
    if (typeof output === "string") {
      return { ok: true, output };
    }
    if (output != null) {
      return { ok: true, output: JSON.stringify(output) };
    }
    return { ok: true, output: "" };
  } catch {
    return { ok: true, output: stdout };
  }
}

export const __selfHealingInvestigatorTestUtils = {
  isAbortLikeError,
  resolveFailedRunsQueryTimeoutMs,
};

export const selfHealingInvestigator = inngest.createFunction(
  {
    id: "system/self-healing.investigator",
    name: "Investigate SDK Reachability Failures",
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: "TZ=America/Los_Angeles */10 * * * *" }, { event: "system/self.healing.requested" }],
  async ({ event, step }) => {
    const data = (event.data ?? {}) as InvestigatorInput;
    const requestedDomain = typeof data.domain === "string" ? data.domain.trim().toLowerCase() : "";
    const sourceFunction = toSafeText((data as { sourceFunction?: string })?.sourceFunction, "system/self-healing.router");
    let flowContext = buildInvestigatorFlowContext({
      sourceFunction,
      domain: requestedDomain || "sdk-reachability",
      targetComponent: "system/self-healing.investigator",
      eventId: event.id,
      eventName: event.name,
      attempt: 0,
      evidenceCount: 0,
    });

    if (requestedDomain && requestedDomain !== "sdk-reachability" && requestedDomain !== "all") {
      await emitOtelEvent({
        level: "warn",
        source: "worker",
        component: "self-healing",
        action: "system.self-healing.sdk-reachability",
        success: false,
        error: `unsupported domain ${requestedDomain}`,
        metadata: {
          flowContext,
          request: {
            eventId: event.id,
            eventName: event.name,
            requestedDomain,
            requestedBy: toSafeText(data.requestedBy, "unknown"),
          },
          reason: "domain-mismatch",
        },
      });
      return {
        status: "skipped",
        reason: `unsupported domain ${requestedDomain}`,
      };
    }

    await emitOtelEvent({
      level: "info",
      source: "worker",
      component: "self-healing",
      action: "system.self-healing.sdk-reachability.scan.started",
      success: true,
      metadata: {
        flowContext,
        request: {
          eventId: event.id,
          eventName: event.name,
          requestedBy: toSafeText(data.requestedBy, "unknown"),
          lookbackMinutes: data.lookbackMinutes,
          maxRuns: data.maxRuns,
          dryRun: data.dryRun,
        },
      },
    });

    const lookbackMinutes = toSafeInt(
      data.lookbackMinutes,
      toSafeInt(SELF_HEALING_DEFAULT_LOOKBACK_MINUTES, 20, 5, 180),
      5,
      180
    );
    const maxRuns = toSafeInt(
      data.maxRuns,
      toSafeInt(SELF_HEALING_DEFAULT_MAX_RUNS, 40, 5, 120),
      5,
      120
    );
    const runBudget = toSafeInt(
      SELF_HEALING_MAX_DETAILS_PER_TICK,
      12,
      1,
      Math.max(1, maxRuns)
    );
    const dryRun = data.dryRun === true;

    const redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: getRedisPort(),
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 4000,
    });
    redis.on("error", () => {});

    try {
      await redis.connect();

      const fromIso = lookbackFromIso(lookbackMinutes);
      const failedRuns = await step.run("list-failed-runs", async () =>
        listRecentFailedRuns(fromIso, maxRuns)
      );

      const uncheckedRuns: RunSummary[] = [];
      for (const run of failedRuns) {
        const seen = await redis.exists(redisRunKey(run.id));
        if (seen > 0) continue;
        uncheckedRuns.push(run);
      }

      const toInspect = uncheckedRuns.slice(0, runBudget);
      const matches: Array<{ id: string; functionName: string; startedAt: string; output: string }> = [];
      const inspectErrors: Array<{ id: string; error: string }> = [];

      for (const run of toInspect) {
        const details = await loadRunOutputViaCli(run.id);
        await redis.set(redisRunKey(run.id), "1", "EX", toSafeInt(SELF_HEALING_RUN_TTL_SECONDS, 21600, 600, 86400));

        if (!details.ok) {
          inspectErrors.push({ id: run.id, error: details.error ?? "unable to load run details" });
          continue;
        }

        if (SDK_REACHABILITY_ERROR_REGEX.test(details.output)) {
          matches.push({
            id: run.id,
            functionName: run.functionName,
            startedAt: run.startedAt,
            output: trimForMetadata(details.output, 260),
          });
        }
      }

      const detectionCount = matches.length;
      let remediation: { fixed: boolean; detail: string } | null = null;

      flowContext = {
        ...flowContext,
        evidenceCount: matches.length,
      };

      if (detectionCount > 0 && !dryRun) {
        remediation = await restartWorker({
          id: "self-healing-sdk-reachability",
          timestamp: Date.now(),
          sessionId: "system/self-healing.investigator",
          systemId: "panda",
          level: "error",
          source: "worker",
          component: "self-healing",
          action: "system.self-healing.sdk-reachability",
          success: false,
          error: "Unable to reach SDK URL",
          metadata: {
            detector: "system/self-healing.investigator",
            runIds: matches.map((item) => item.id),
          },
        });
      }

      await emitOtelEvent({
        level: detectionCount > 0 ? "warn" : "info",
        source: "worker",
        component: "self-healing",
        action: "system.self-healing.sdk-reachability",
        success: detectionCount === 0
          ? true
          : dryRun
            ? true
            : (remediation?.fixed ?? false),
        error: detectionCount > 0 && !dryRun && remediation && !remediation.fixed
          ? remediation.detail
          : undefined,
        metadata: {
          flowContext,
          diagnostics: {
            eventId: event.id,
            eventName: event.name,
            requestDomain: requestedDomain || "sdk-reachability",
            request: {
              requestedBy: toSafeText(data.requestedBy, "unknown"),
              lookbackMinutes,
              maxRuns,
              dryRun,
            },
          },
          detector: "system/self-healing.investigator",
          trigger: event.name,
          reason: data.reason ?? null,
          requestedBy: data.requestedBy ?? null,
          lookbackMinutes,
          maxRuns,
          inspected: toInspect.length,
          failedRunCount: failedRuns.length,
          uncheckedRunCount: uncheckedRuns.length,
          sdkUnreachableCount: detectionCount,
          dryRun,
          matches: matches.slice(0, 5).map((match) => ({
            id: match.id,
            functionName: match.functionName,
          })),
          remediation,
          inspectErrors: inspectErrors.slice(0, 5),
          matchCount: matches.length,
          sampleRunIds: matches.map((item) => item.id).slice(0, 5),
        },
      });

      if (event.name === "system/self.healing.requested") {
        await step.sendEvent("emit-self-healing-completed", {
          name: "system/self.healing.completed",
          data: {
            domain: "sdk-reachability",
            status: detectionCount > 0
              ? dryRun
                ? "detected"
                : remediation?.fixed
                  ? "remediated"
                  : "detected"
              : "noop",
            detected: detectionCount,
            inspected: toInspect.length,
            dryRun,
            remediationDetail: remediation?.detail,
            sampleRunIds: matches.map((item) => item.id).slice(0, 5),
            context: {
              runContext: flowContext,
              eventName: event.name,
              eventId: event.id,
              detected: detectionCount,
              inspected: toInspect.length,
              remediation: remediation
                ? {
                    fixed: remediation.fixed,
                    detail: remediation.detail,
                  }
                : null,
            },
          },
        });
      }

      return {
        status: detectionCount > 0
          ? dryRun
            ? "detected"
            : remediation?.fixed
              ? "remediated"
              : "detected"
          : "noop",
        inspected: toInspect.length,
        detected: detectionCount,
        remediation,
      };
    } finally {
      redis.disconnect();
    }
  }
);
