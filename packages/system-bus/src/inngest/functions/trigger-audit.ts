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

const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const GQL = `${INNGEST_URL}/v0/gql`;

type TriggerSpec = { type: string; value: string; condition?: string };
type FunctionSpec = { id: string; slug: string; name: string; triggers: TriggerSpec[] };
type DriftResult = {
  ok: boolean;
  checked: number;
  drifted: DriftEntry[];
  missing: string[];
  extra: string[];
};
type DriftEntry = {
  slug: string;
  name: string;
  expected: string[];
  registered: string[];
};

async function gql(query: string) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { errors?: Array<{ message: string }>; data: any };
  if (json.errors?.length) throw new Error(json.errors[0].message);
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

/** Get registered functions from Inngest server via GraphQL */
async function getRegistered(): Promise<Map<string, FunctionSpec>> {
  const data = await gql(`{
    functions {
      id slug name
      triggers { type value condition }
    }
  }`);
  const map = new Map<string, FunctionSpec>();
  for (const fn of data.functions as FunctionSpec[]) {
    map.set(fn.slug, fn);
  }
  return map;
}

/** Get expected functions from worker code */
async function getExpected(): Promise<Map<string, { name: string; triggers: string[] }>> {
  const fns = await import("./index");
  const allFunctions = Object.values(fns)
    .flat()
    .filter((f): f is any => f && typeof (f as any).getConfig === "function");

  const map = new Map<string, { name: string; triggers: string[] }>();
  for (const fn of allFunctions) {
    try {
      const configs = fn.getConfig({
        baseUrl: new URL("http://localhost:3111"),
        appPrefix: "system-bus",
      });
      for (const c of configs) {
        map.set(c.id, {
          name: c.name,
          triggers: (c.triggers as Record<string, unknown>[]).map(normalizeCodeTrigger).sort(),
        });
      }
    } catch {
      // skip functions that can't generate config
    }
  }
  return map;
}

/** Compare registered vs expected triggers. Returns drift report. */
export async function auditTriggers(): Promise<DriftResult> {
  const registered = await getRegistered();
  const expected = await getExpected();

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

  return {
    ok: drifted.length === 0 && missing.length === 0,
    checked: expected.size,
    drifted,
    missing,
    extra,
  };
}
