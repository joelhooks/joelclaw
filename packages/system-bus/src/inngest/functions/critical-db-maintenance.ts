import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { getRedisClient } from "../../lib/redis";
import { sendHardAlert, stableAlertId } from "../../lib/search-maintenance";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const DEFAULT_DB_PATH = resolve(process.env.JOELCLAW_CRITICAL_DB || `${process.env.HOME}/.joelclaw/search/critical.db`);
const CRITICAL_DB_FRESHNESS_STATE_KEY = "search-maintenance:critical-db:freshness-incident";
const CRITICAL_DB_REBUILD_STATE_KEY = "search-maintenance:critical-db:rebuild-incident";
const REQUIRED_SOURCES = [
  "files:observations",
  "files:brain",
  "files:vault",
  "files:knowledge",
  "archive:memory_observations",
] as const;
const CRITICAL_DB_BUILD_BUDGET_MS = parseBudget(
  "CRITICAL_DB_BUILD_STALENESS_BUDGET_MS",
  8 * 60 * 60_000,
);
const CRITICAL_DB_OBSERVATION_BUDGET_MS = parseBudget(
  "CRITICAL_DB_OBSERVATION_STALENESS_BUDGET_MS",
  24 * 60 * 60_000,
);
const SOURCE_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
const INCIDENT_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_SUBPROCESS_OUTPUT = 8_000;
const BUILDER_TIMEOUT_MS = 30 * 60_000;

export interface CriticalDbStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CriticalDbSourceFreshness = {
  status: string;
  highWaterAt: string | null;
  ageMs: number | null;
  freshness: string;
};

export interface CriticalDbFreshness {
  available: boolean;
  checkedAt: string;
  dbPath: string;
  builtAt: string | null;
  builtAgeMs: number | null;
  buildBudgetMs: number;
  observationHighWaterAt: string | null;
  observationAgeMs: number | null;
  observationBudgetMs: number;
  sourceStaleAfterMs: number;
  degradedOverride: boolean;
  portStatus: "ok" | "stale" | "degraded";
  sources: Record<string, CriticalDbSourceFreshness>;
  stale: boolean;
  reasons: string[];
}

type StoredIncident = {
  eventId: string;
  startedAt: number;
  confirmedAt: number | null;
};

export interface CriticalDbFreshnessDependencies {
  store: CriticalDbStateStore;
  inspect: () => Promise<CriticalDbFreshness>;
  notify: (freshness: CriticalDbFreshness, eventId: string) => Promise<void>;
  now: () => number;
}

export interface CriticalDbRebuildFailureDependencies {
  store: CriticalDbStateStore;
  notify: (detail: string, eventId: string) => Promise<void>;
  now: () => number;
}

export interface CriticalDbScheduledRebuildDependencies {
  runBuilder: () => Promise<{ stdout: string; stderr: string }>;
  store: () => CriticalDbStateStore;
  notifyFailure: (detail: string, eventId: string) => Promise<void>;
  emitFailure: (detail: string, alerted: boolean) => Promise<unknown>;
  emitCompleted: (stdout: string) => Promise<unknown>;
  now: () => number;
}

function parseBudget(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function stateStore(): CriticalDbStateStore {
  const redis = getRedisClient();
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      if (ttlSeconds === undefined) await redis.set(key, value);
      else await redis.set(key, value, "EX", ttlSeconds);
    },
    delete: async (key) => {
      await redis.del(key);
    },
  };
}

function parseIncident(value: string | null): StoredIncident | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredIncident>;
    if (
      typeof parsed.eventId === "string" &&
      typeof parsed.startedAt === "number" &&
      (typeof parsed.confirmedAt === "number" || parsed.confirmedAt === null)
    ) {
      return parsed as StoredIncident;
    }
  } catch {
    // A malformed incident must not suppress a fresh alert.
  }
  return null;
}

function ageMs(timestamp: string | null, now: number): number | null {
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? Math.max(0, now - value) : null;
}

export function inspectCriticalDbFreshness(input: {
  dbPath: string;
  now: number;
  buildBudgetMs: number;
  observationBudgetMs: number;
  sourceStaleAfterMs?: number;
}): CriticalDbFreshness {
  const dbPath = resolve(input.dbPath);
  const sourceStaleAfterMs = input.sourceStaleAfterMs ?? SOURCE_STALE_AFTER_MS;
  const base = {
    checkedAt: new Date(input.now).toISOString(),
    dbPath,
    buildBudgetMs: input.buildBudgetMs,
    observationBudgetMs: input.observationBudgetMs,
    sourceStaleAfterMs,
  };
  try {
    const db = new Database(dbPath, { readonly: true, strict: true });
    try {
      const rows = db.query("SELECT key, value FROM metadata").all() as Array<{
        key: string;
        value: string;
      }>;
      const metadata = new Map(rows.map((row) => [row.key, row.value]));
      if (metadata.get("schema_version") !== "2") {
        throw new Error(`critical.db schema mismatch: ${metadata.get("schema_version") ?? "missing"}`);
      }
      const builtAt = metadata.get("built_at") ?? null;
      const rawSources = JSON.parse(metadata.get("sources_json") ?? "{}") as Record<
        string,
        { highWaterAt?: unknown; status?: unknown }
      >;
      const sources = Object.fromEntries(Object.entries(rawSources).map(([key, source]) => {
        const highWaterAt = typeof source.highWaterAt === "string" ? source.highWaterAt : null;
        const sourceAgeMs = ageMs(highWaterAt, input.now);
        const status = typeof source.status === "string" ? source.status : "unknown";
        const freshness = status !== "ok"
          ? status
          : sourceAgeMs !== null && sourceAgeMs > sourceStaleAfterMs
            ? "stale"
            : "fresh";
        return [key, { status, highWaterAt, ageMs: sourceAgeMs, freshness }];
      })) as Record<string, CriticalDbSourceFreshness>;
      const required = REQUIRED_SOURCES.map((source) => sources[source]);
      const degradedOverride = metadata.get("degraded_override") === "true";
      const portStatus = degradedOverride || required.some((source) => !source || source.status !== "ok")
        ? "degraded"
        : required.some((source) => source.freshness === "stale")
          ? "stale"
          : "ok";
      const observationSource = sources["files:observations"];
      const builtAgeMs = ageMs(builtAt, input.now);
      const observationHighWaterAt = observationSource?.highWaterAt ?? null;
      const observationAgeMs = observationSource?.ageMs ?? null;
      const reasons: string[] = [];
      if (builtAgeMs === null) reasons.push("critical.db has no valid built_at metadata");
      else if (builtAgeMs > input.buildBudgetMs) {
        reasons.push(`critical.db build age ${builtAgeMs}ms exceeds ${input.buildBudgetMs}ms`);
      }
      if (observationAgeMs === null) reasons.push("files:observations has no valid high-water timestamp");
      else if (observationAgeMs > input.observationBudgetMs) {
        reasons.push(`observation high-water age ${observationAgeMs}ms exceeds ${input.observationBudgetMs}ms`);
      }
      if (degradedOverride) reasons.push("critical.db was published with degraded_override=true");
      for (const sourceName of REQUIRED_SOURCES) {
        const source = sources[sourceName];
        if (!source) reasons.push(`${sourceName} is missing`);
        else if (source.status !== "ok") reasons.push(`${sourceName} status is ${source.status}`);
        else if (source.freshness === "stale") {
          reasons.push(`${sourceName} high-water age ${source.ageMs}ms exceeds ${sourceStaleAfterMs}ms`);
        }
      }
      return {
        ...base,
        available: true,
        builtAt,
        builtAgeMs,
        observationHighWaterAt,
        observationAgeMs,
        degradedOverride,
        portStatus,
        sources,
        stale: reasons.length > 0,
        reasons,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ...base,
      available: false,
      builtAt: null,
      builtAgeMs: null,
      observationHighWaterAt: null,
      observationAgeMs: null,
      degradedOverride: false,
      portStatus: "degraded",
      sources: {},
      stale: true,
      reasons: [`critical.db inspection failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function processStoredIncident(input: {
  key: string;
  store: CriticalDbStateStore;
  notify: (eventId: string) => Promise<void>;
  now: number;
  eventSeed: string;
}): Promise<boolean> {
  const existing = parseIncident(await input.store.get(input.key));
  const incident = existing ?? {
    eventId: stableAlertId(`${input.eventSeed}:${input.now}`),
    startedAt: input.now,
    confirmedAt: null,
  };
  await input.store.set(input.key, JSON.stringify(incident), INCIDENT_TTL_SECONDS);
  if (incident.confirmedAt !== null) return false;
  await input.notify(incident.eventId);
  await input.store.set(
    input.key,
    JSON.stringify({ ...incident, confirmedAt: input.now }),
    INCIDENT_TTL_SECONDS,
  );
  return true;
}

export async function processCriticalDbFreshness(
  dependencies: CriticalDbFreshnessDependencies,
): Promise<{ freshness: CriticalDbFreshness; alerted: boolean }> {
  const freshness = await dependencies.inspect();
  if (!freshness.stale) {
    await dependencies.store.delete(CRITICAL_DB_FRESHNESS_STATE_KEY);
    return { freshness, alerted: false };
  }
  const alerted = await processStoredIncident({
    key: CRITICAL_DB_FRESHNESS_STATE_KEY,
    store: dependencies.store,
    notify: (eventId) => dependencies.notify(freshness, eventId),
    now: dependencies.now(),
    eventSeed: "critical-db-stale",
  });
  return { freshness, alerted };
}

export async function processCriticalDbRebuildFailure(
  detail: string,
  dependencies: CriticalDbRebuildFailureDependencies,
): Promise<{ alerted: boolean }> {
  const alerted = await processStoredIncident({
    key: CRITICAL_DB_REBUILD_STATE_KEY,
    store: dependencies.store,
    notify: (eventId) => dependencies.notify(detail, eventId),
    now: dependencies.now(),
    eventSeed: "critical-db-rebuild-failure",
  });
  return { alerted };
}

export async function clearCriticalDbRebuildFailure(store: CriticalDbStateStore): Promise<void> {
  await store.delete(CRITICAL_DB_REBUILD_STATE_KEY);
}

async function notifyCriticalDbStale(
  freshness: CriticalDbFreshness,
  eventId: string,
): Promise<void> {
  const message = [
    "🚨 Critical search database is stale",
    `Database: ${freshness.dbPath}`,
    `Port status: ${freshness.portStatus}`,
    `Built: ${freshness.builtAt ?? "unknown"} (budget ${Math.floor(freshness.buildBudgetMs / 3_600_000)}h)`,
    `Observation high-water: ${freshness.observationHighWaterAt ?? "unknown"} (budget ${Math.floor(freshness.observationBudgetMs / 3_600_000)}h)`,
    ...freshness.reasons.map((reason) => `Reason: ${reason}`),
    "The scheduled builder never uses --allow-degraded-sources. Inspect and repair the source before replacing critical.db.",
  ].join("\n");
  await sendHardAlert({
    eventId,
    source: "critical-db-staleness",
    message,
  });
}

async function notifyCriticalDbRebuildFailure(detail: string, eventId: string): Promise<void> {
  await sendHardAlert({
    eventId,
    source: "critical-db-rebuild-failure",
    message: [
      "🚨 Scheduled critical.db rebuild failed",
      detail,
      "The existing database was not replaced. The builder source gate is intentional; do not use --allow-degraded-sources automatically.",
    ].join("\n"),
  });
}

export async function runCriticalDbBuilder(options: {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
} = {}): Promise<{ stdout: string; stderr: string }> {
  const command = ["bun", resolve(REPO_ROOT, "scripts/build-critical-search-db.ts")];
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = options.timeoutMs ?? BUILDER_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  const detail = stderr.trim().slice(-MAX_SUBPROCESS_OUTPUT) || stdout.trim().slice(-MAX_SUBPROCESS_OUTPUT);
  if (timedOut) {
    throw new Error(`critical.db builder timed out after ${timeoutMs}ms: ${detail || "no output"}`);
  }
  if (exitCode !== 0) {
    throw new Error(`critical.db builder exited ${exitCode}: ${detail || "no output"}`);
  }
  return {
    stdout: stdout.trim().slice(-MAX_SUBPROCESS_OUTPUT),
    stderr: stderr.trim().slice(-MAX_SUBPROCESS_OUTPUT),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const defaultScheduledDependencies: CriticalDbScheduledRebuildDependencies = {
  runBuilder: runCriticalDbBuilder,
  store: stateStore,
  notifyFailure: notifyCriticalDbRebuildFailure,
  emitFailure: (detail, alerted) => emitOtelEvent({
    level: "fatal",
    source: "system-bus",
    component: "critical-db-maintenance",
    action: "search.critical_db.rebuild.failed",
    success: false,
    error: detail,
    metadata: { alerted },
  }),
  emitCompleted: (stdout) => emitOtelEvent({
    level: "info",
    source: "system-bus",
    component: "critical-db-maintenance",
    action: "search.critical_db.rebuild.completed",
    success: true,
    metadata: { cadence: "17 */6 * * *", stdout },
  }),
  now: Date.now,
};

export function createCriticalDbScheduledRebuildFunction(
  dependencies: CriticalDbScheduledRebuildDependencies = defaultScheduledDependencies,
) {
  return inngest.createFunction(
    {
      id: "search/critical-db-rebuild",
      concurrency: { limit: 1 },
      onFailure: async ({ error, step }) => {
        const detail = errorText(error).slice(0, MAX_SUBPROCESS_OUTPUT);
        await step.run("alert-critical-db-rebuild-failed", async () => {
          const result = await processCriticalDbRebuildFailure(detail, {
            store: dependencies.store(),
            notify: dependencies.notifyFailure,
            now: dependencies.now,
          });
          await dependencies.emitFailure(detail, result.alerted);
          return result;
        });
      },
    },
    { cron: "17 */6 * * *" },
    async ({ step }) => {
      const result = await step.run("run-hardened-critical-db-builder", dependencies.runBuilder);
      await step.run("clear-critical-db-rebuild-failure", () =>
        clearCriticalDbRebuildFailure(dependencies.store())
      );
      await step.run("emit-critical-db-rebuild-completed", () =>
        dependencies.emitCompleted(result.stdout)
      );
      return result;
    },
  );
}

export const criticalDbScheduledRebuild = createCriticalDbScheduledRebuildFunction();

export const criticalDbStalenessCheck = inngest.createFunction(
  { id: "search/critical-db-staleness", concurrency: { limit: 1 } },
  { cron: "7 * * * *" },
  async ({ step }) => {
    const result = await step.run("check-critical-db-source-high-water", () =>
      processCriticalDbFreshness({
        store: stateStore(),
        inspect: async () => inspectCriticalDbFreshness({
          dbPath: DEFAULT_DB_PATH,
          now: Date.now(),
          buildBudgetMs: CRITICAL_DB_BUILD_BUDGET_MS,
          observationBudgetMs: CRITICAL_DB_OBSERVATION_BUDGET_MS,
        }),
        notify: notifyCriticalDbStale,
        now: Date.now,
      })
    );
    await step.run("emit-critical-db-freshness-checked", () =>
      emitOtelEvent({
        level: result.freshness.stale ? "fatal" : "info",
        source: "system-bus",
        component: "critical-db-maintenance",
        action: "search.critical_db.freshness.checked",
        success: !result.freshness.stale,
        metadata: result,
      })
    );
    return result;
  },
);

export const __criticalDbMaintenanceTestUtils = {
  CRITICAL_DB_FRESHNESS_STATE_KEY,
  CRITICAL_DB_REBUILD_STATE_KEY,
  REQUIRED_SOURCES,
  SOURCE_STALE_AFTER_MS,
};
