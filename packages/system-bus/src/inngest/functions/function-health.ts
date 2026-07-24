import { CronExpressionParser } from "cron-parser";
import {
  resolveHardAlert,
  sendHardAlert,
  stableAlertId,
} from "../../lib/search-maintenance";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import {
  type ExpectedFunctionSpec,
  getExpectedFunctions,
  getRegisteredFunctions,
  getTriggerAuditConfig,
  type RegisteredFunctionSpec,
} from "./trigger-audit";

const REGISTRATION_ATTEMPT_CAP = 3;
const REGISTRATION_BACKOFF_MS = 1_000;
const CRON_ALERT_QUIET_MS = 24 * 60 * 60_000;
const CRON_ALERT_ATTEMPT_CAP = 3;
const WORKER_REGISTRATION_URL =
  process.env.SYSTEM_BUS_REGISTRATION_URL ?? "http://127.0.0.1:3111/api/inngest";
const HEALTH_MONITOR_STARTED_AT = Date.now();

type ExpectedFunctionMap = Map<string, ExpectedFunctionSpec>;
type RegisteredFunctionMap = Map<string, RegisteredFunctionSpec>;

export type LastSuccessfulRun = {
  id: string;
  startedAt: string;
};

export type CronHealthFinding = {
  slug: string;
  name: string;
  cron: string;
  cadenceMs: number;
  staleAfterMs: number;
  lastSuccessfulRun: LastSuccessfulRun | null;
  ageMs: number | null;
  stale: boolean;
};

export interface FunctionHealthDependencies {
  expected: () => Promise<ExpectedFunctionMap>;
  registered: () => Promise<RegisteredFunctionMap>;
  register: () => Promise<void>;
  readLastSuccessfulRun: (
    fn: RegisteredFunctionSpec,
  ) => Promise<LastSuccessfulRun | null>;
  notifyDeadCron: (finding: CronHealthFinding) => Promise<boolean | void>;
  resolveDeadCron: (slug: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  monitorStartedAt: number;
  registrationAttemptCap: number;
  registrationBackoffMs: number;
}

export type FunctionHealthResult = {
  registration: {
    expected: number;
    registered: number;
    missingBefore: string[];
    missingAfter: string[];
    attempts: number;
    repaired: boolean;
    errors: string[];
  };
  cron: {
    checked: number;
    stale: CronHealthFinding[];
    healthy: CronHealthFinding[];
  };
};

function escapeGqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function inngestGraphqlUrl(): string {
  const base = process.env.INNGEST_URL ?? process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
  return `${base.replace(/\/$/u, "")}/v0/gql`;
}

async function gql(query: string): Promise<Record<string, unknown>> {
  const response = await fetch(inngestGraphqlUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(
      body.errors?.[0]?.message ?? `Inngest GraphQL failed with HTTP ${response.status}`,
    );
  }
  return body.data;
}

export async function readLastSuccessfulRun(
  fn: RegisteredFunctionSpec,
): Promise<LastSuccessfulRun | null> {
  const data = await gql(`{
    runs(
      filter: {
        from: "1970-01-01T00:00:00.000Z"
        status: [COMPLETED]
        functionIDs: ["${escapeGqlString(fn.id)}"]
      }
      orderBy: [{ field: STARTED_AT, direction: DESC }]
      first: 1
    ) {
      edges { node { id startedAt } }
    }
  }`);
  const runs = data.runs as
    | { edges?: Array<{ node?: { id?: unknown; startedAt?: unknown } }> }
    | undefined;
  const node = runs?.edges?.[0]?.node;
  return typeof node?.id === "string" && typeof node.startedAt === "string"
    ? { id: node.id, startedAt: node.startedAt }
    : null;
}

function splitCronExpression(cron: string): { expression: string; timezone?: string } {
  const trimmed = cron.trim();
  const match = /^(?:TZ|CRON_TZ)=([^\s]+)\s+(.+)$/u.exec(trimmed);
  return match && match[1] && match[2]
    ? { timezone: match[1], expression: match[2] }
    : { expression: trimmed };
}

export function cronScheduleCadenceMs(crons: string[], now: number): number {
  if (crons.length === 0) throw new Error("At least one cron expression is required");
  const schedules = crons.map((cron) => {
    const { expression, timezone } = splitCronExpression(cron);
    const interval = CronExpressionParser.parse(expression, {
      currentDate: new Date(now),
      ...(timezone ? { tz: timezone } : {}),
    });
    return { cron, interval, previous: interval.prev().getTime() };
  });
  const occurrences: number[] = [];

  // Merge each trigger's actual schedule. This handles one function with
  // several cron triggers without treating each trigger as an isolated job.
  for (let index = 0; index < 128; index += 1) {
    const latest = Math.max(...schedules.map((schedule) => schedule.previous));
    occurrences.push(latest);
    for (const schedule of schedules) {
      if (schedule.previous === latest) {
        schedule.previous = schedule.interval.prev().getTime();
      }
    }
  }

  let cadence = 0;
  for (let index = 1; index < occurrences.length; index += 1) {
    cadence = Math.max(cadence, occurrences[index - 1]! - occurrences[index]!);
  }
  if (!Number.isSafeInteger(cadence) || cadence <= 0) {
    throw new Error(`Unable to derive cadence for cron schedule: ${crons.join(", ")}`);
  }
  return cadence;
}

export function cronCadenceMs(cron: string, now: number): number {
  return cronScheduleCadenceMs([cron], now);
}

function cronExpressions(spec: ExpectedFunctionSpec): string[] {
  return spec.triggers
    .filter((trigger) => trigger.startsWith("CRON:"))
    .map((trigger) => trigger.slice("CRON:".length));
}

function missingFunctions(
  expected: ExpectedFunctionMap,
  registered: RegisteredFunctionMap,
): string[] {
  return [...expected.keys()].filter((slug) => !registered.has(slug)).sort();
}

export async function runFunctionHealthCheck(
  dependencies: FunctionHealthDependencies,
): Promise<FunctionHealthResult> {
  const expected = await dependencies.expected();
  let registered = await dependencies.registered();
  const missingBefore = missingFunctions(expected, registered);
  let missingAfter = missingBefore;
  let attempts = 0;
  const registrationErrors: string[] = [];

  while (missingAfter.length > 0 && attempts < dependencies.registrationAttemptCap) {
    attempts += 1;
    try {
      await dependencies.register();
      registered = await dependencies.registered();
      missingAfter = missingFunctions(expected, registered);
    } catch (error) {
      registrationErrors.push(String(error).slice(0, 300));
    }
    if (missingAfter.length > 0 && attempts < dependencies.registrationAttemptCap) {
      await dependencies.sleep(dependencies.registrationBackoffMs * 2 ** (attempts - 1));
    }
  }

  const now = dependencies.now();
  const stale: CronHealthFinding[] = [];
  const healthy: CronHealthFinding[] = [];

  for (const [slug, spec] of expected) {
    const crons = cronExpressions(spec);
    if (crons.length === 0) continue;
    const registeredFunction = registered.get(slug);
    if (!registeredFunction) continue;

    const cadenceMs = cronScheduleCadenceMs(crons, now);
    const cron = crons.join(" | ");
    const staleAfterMs = cadenceMs * 2;
    const lastSuccessfulRun = await dependencies.readLastSuccessfulRun(
      registeredFunction,
    );
    const lastRunMs = lastSuccessfulRun
      ? Date.parse(lastSuccessfulRun.startedAt)
      : Number.NaN;
    const ageMs = Number.isFinite(lastRunMs) ? Math.max(0, now - lastRunMs) : null;
    const finding: CronHealthFinding = {
      slug,
      name: spec.name,
      cron,
      cadenceMs,
      staleAfterMs,
      lastSuccessfulRun,
      ageMs,
      stale: ageMs === null
        ? now - dependencies.monitorStartedAt > staleAfterMs
        : ageMs > staleAfterMs,
    };

    if (finding.stale) {
      stale.push(finding);
      await dependencies.notifyDeadCron(finding);
    } else {
      healthy.push(finding);
      await dependencies.resolveDeadCron(slug);
    }
  }

  return {
    registration: {
      expected: expected.size,
      registered: registered.size,
      missingBefore,
      missingAfter,
      attempts,
      repaired: missingBefore.length > 0 && missingAfter.length === 0,
      errors: registrationErrors,
    },
    cron: { checked: stale.length + healthy.length, stale, healthy },
  };
}

async function registerWorker(): Promise<void> {
  const response = await fetch(WORKER_REGISTRATION_URL, {
    method: "PUT",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Worker registration PUT failed with HTTP ${response.status}`);
  }
}

async function notifyDeadCron(finding: CronHealthFinding): Promise<boolean> {
  const lastRun = finding.lastSuccessfulRun?.startedAt ?? "never";
  const eventId = stableAlertId(
    `inngest-dead-cron:${finding.slug}:${finding.lastSuccessfulRun?.startedAt ?? "never"}`,
  );
  const receipt = await sendHardAlert({
    eventId,
    source: "inngest-function-health",
    latchKey: `inngest:function-health:dead-cron:${finding.slug}`,
    quietWindowMs: CRON_ALERT_QUIET_MS,
    attemptCap: CRON_ALERT_ATTEMPT_CAP,
    message: [
      "🚨 Inngest cron has stopped completing runs",
      `Function: ${finding.name}`,
      `Slug: ${finding.slug}`,
      `Cron: ${finding.cron}`,
      `Last successful run: ${lastRun}`,
      `Expected cadence: ${Math.floor(finding.cadenceMs / 60_000)} minutes`,
      "Registration exists, but run recency failed. Inspect the Inngest runtime and queue binding.",
    ].join("\n"),
  });
  return receipt.sent;
}

export function productionFunctionHealthDependencies(): FunctionHealthDependencies {
  const config = getTriggerAuditConfig();
  return {
    expected: () => getExpectedFunctions(config),
    registered: () => getRegisteredFunctions(config.appId),
    register: registerWorker,
    readLastSuccessfulRun,
    notifyDeadCron,
    resolveDeadCron: async (slug) => {
      await resolveHardAlert({ latchKey: `inngest:function-health:dead-cron:${slug}` });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    monitorStartedAt: HEALTH_MONITOR_STARTED_AT,
    registrationAttemptCap: REGISTRATION_ATTEMPT_CAP,
    registrationBackoffMs: REGISTRATION_BACKOFF_MS,
  };
}

export async function runProductionFunctionHealthCheck(): Promise<FunctionHealthResult> {
  const result = await runFunctionHealthCheck(productionFunctionHealthDependencies());
  await emitOtelEvent({
    level: result.registration.missingAfter.length > 0 || result.cron.stale.length > 0
      ? "fatal"
      : "info",
    source: "system-bus",
    component: "inngest-function-health",
    action: "inngest.function_health.checked",
    success: result.registration.missingAfter.length === 0 && result.cron.stale.length === 0,
    metadata: result,
  });
  return result;
}

export const functionRegistrationAndRunHealth = inngest.createFunction(
  {
    id: "check/function-registration-and-runs",
    concurrency: { limit: 1 },
  },
  [
    { cron: "0 * * * *" },
    { event: "inngest/function-health.requested" },
  ],
  async ({ step }) =>
    step.run("assert-function-registration-and-runs", runProductionFunctionHealthCheck),
);

export const __functionHealthTestUtils = {
  CRON_ALERT_ATTEMPT_CAP,
  CRON_ALERT_QUIET_MS,
  REGISTRATION_ATTEMPT_CAP,
  REGISTRATION_BACKOFF_MS,
  splitCronExpression,
};
