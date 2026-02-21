/**
 * Trigger Drift Auditor
 *
 * Compares Inngest server's registered triggers against what the code defines.
 * Detects silent trigger drift — when a function's triggers change in code but
 * the Inngest server keeps the old registration (same function ID, stale config).
 *
 * Root cause: Inngest server caches function configs by ID. Worker restarts
 * re-announce functions but don't always force trigger updates. Only a full
 * app delete + re-register (joelclaw refresh) clears stale configs.
 *
 * Usage:
 *   - Called by heartbeat cron to detect drift
 *   - Called by `joelclaw functions --verify` for manual checks
 *   - Returns actionable diff for auto-refresh decisions
 */

import { createHash } from "node:crypto";

const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const GQL = `${INNGEST_URL}/v0/gql`;

type WorkerRole = "host" | "cluster";
type TriggerSpec = { type: string; value: string; condition?: string };
type FunctionSpec = { id: string; slug: string; name: string; triggers: TriggerSpec[] };
type AppSpec = { name: string; functions: FunctionSpec[] };
type DriftResult = {
  ok: boolean;
  checked: number;
  drifted: DriftEntry[];
  missing: string[];
  extra: string[];
  changed: boolean;
  hash: string;
  appId: string;
  workerRole: WorkerRole;
};
type DriftEntry = {
  slug: string;
  name: string;
  expected: string[];
  registered: string[];
};
type AuditConfig = {
  appId: string;
  workerRole: WorkerRole;
  baseUrl: URL;
};
type InngestFunctionConfig = {
  id: string;
  name: string;
  triggers?: Record<string, unknown>[];
};
type ConfigurableInngestFunction = {
  getConfig: (opts: { baseUrl: URL; appPrefix: string }) => InngestFunctionConfig[];
};

let lastAuditHash: string | null = null;

async function gql(query: string) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { errors?: Array<{ message: string }>; data: any };
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Inngest GQL error");
  return json.data;
}

/** Normalize a trigger to a comparable string: "EVENT:foo/bar" or "CRON:..." */
function normalizeTrigger(t: TriggerSpec): string {
  const expr = t.condition ? `[${t.condition}]` : "";
  return `${t.type}:${t.value}${expr}`;
}

/** Normalize trigger from code format: { event: "x" } → "EVENT:x" */
function normalizeCodeTrigger(t: Record<string, unknown>): string {
  if (t.event) {
    const expr = t.expression || t.if ? `[${t.expression || t.if}]` : "";
    return `EVENT:${t.event}${expr}`;
  }
  if (t.cron) return `CRON:${t.cron}`;
  return `UNKNOWN:${JSON.stringify(t)}`;
}

function parseWorkerRole(value: string | undefined): WorkerRole {
  const normalized = (value ?? "host").trim().toLowerCase();
  return normalized === "cluster" ? "cluster" : "host";
}

function getConfig(): AuditConfig {
  const workerRole = parseWorkerRole(process.env.WORKER_ROLE);
  const explicitAppId = process.env.INNGEST_APP_ID?.trim();
  const appId = explicitAppId && explicitAppId.length > 0
    ? explicitAppId
    : `system-bus-${workerRole}`;
  return {
    appId,
    workerRole,
    baseUrl: new URL("http://localhost:3111"),
  };
}

function escapeGqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function getApps(appId: string): Promise<AppSpec[]> {
  const escapedAppId = escapeGqlString(appId);

  try {
    const filtered = await gql(`{
      apps(name: "${escapedAppId}") {
        name
        functions {
          id slug name
          triggers { type value condition }
        }
      }
    }`);
    if (Array.isArray(filtered.apps)) {
      return filtered.apps as AppSpec[];
    }
  } catch {
    // Older Inngest builds may not support apps(name: "...").
  }

  const unfiltered = await gql(`{
    apps {
      name
      functions {
        id slug name
        triggers { type value condition }
      }
    }
  }`);

  return Array.isArray(unfiltered.apps) ? (unfiltered.apps as AppSpec[]) : [];
}

/** Get registered functions for this worker app from Inngest server via GraphQL */
async function getRegistered(appId: string): Promise<Map<string, FunctionSpec>> {
  const apps = await getApps(appId);
  const app = apps.find((candidate) => candidate.name === appId);

  const map = new Map<string, FunctionSpec>();
  for (const fn of app?.functions ?? []) {
    map.set(fn.slug, fn);
  }
  return map;
}

function isConfigurableInngestFunction(fn: unknown): fn is ConfigurableInngestFunction {
  return typeof fn === "object"
    && fn !== null
    && typeof (fn as { getConfig?: unknown }).getConfig === "function";
}

async function getRoleFunctionDefinitions(workerRole: WorkerRole): Promise<unknown[]> {
  if (workerRole === "cluster") {
    const mod = await import("./index.cluster");
    return mod.clusterFunctionDefinitions;
  }

  const mod = await import("./index.host");
  return mod.hostFunctionDefinitions;
}

/** Get expected functions from worker code for the current worker role */
async function getExpected(config: AuditConfig): Promise<Map<string, { name: string; triggers: string[] }>> {
  const roleFunctions = await getRoleFunctionDefinitions(config.workerRole);

  const map = new Map<string, { name: string; triggers: string[] }>();
  for (const fn of roleFunctions) {
    if (!isConfigurableInngestFunction(fn)) continue;

    try {
      const configs = fn.getConfig({
        baseUrl: config.baseUrl,
        appPrefix: config.appId,
      });

      for (const c of configs) {
        map.set(c.id, {
          name: c.name,
          triggers: (c.triggers ?? []).map(normalizeCodeTrigger).sort(),
        });
      }
    } catch {
      // skip functions that can't generate config
    }
  }
  return map;
}

function hashDriftState(drifted: DriftEntry[], missing: string[], extra: string[]): string {
  const normalized = {
    drifted: drifted
      .map((entry) => ({
        ...entry,
        expected: [...entry.expected].sort(),
        registered: [...entry.registered].sort(),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    missing: [...missing].sort(),
    extra: [...extra].sort(),
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Compare registered vs expected triggers. Returns drift report. */
export async function auditTriggers(): Promise<DriftResult> {
  const config = getConfig();
  const registered = await getRegistered(config.appId);
  const expected = await getExpected(config);

  const drifted: DriftEntry[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  // Check each expected function
  for (const [slug, exp] of expected) {
    const reg = registered.get(slug);
    if (!reg) {
      missing.push(slug);
      continue;
    }

    const regTriggers = reg.triggers.map(normalizeTrigger).sort();
    const expTriggers = exp.triggers;

    if (JSON.stringify(regTriggers) !== JSON.stringify(expTriggers)) {
      drifted.push({
        slug,
        name: exp.name,
        expected: expTriggers,
        registered: regTriggers,
      });
    }
  }

  // Check for extra registered functions not in code
  for (const slug of registered.keys()) {
    if (!expected.has(slug)) {
      extra.push(slug);
    }
  }

  drifted.sort((a, b) => a.slug.localeCompare(b.slug));
  missing.sort();
  extra.sort();

  const hash = hashDriftState(drifted, missing, extra);
  const changed = hash !== lastAuditHash;
  lastAuditHash = hash;

  return {
    ok: drifted.length === 0 && missing.length === 0,
    checked: expected.size,
    drifted,
    missing,
    extra,
    changed,
    hash,
    appId: config.appId,
    workerRole: config.workerRole,
  };
}
