import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import { readFreshness } from "../../../../cli/src/lib/critical-search";
import {
  __criticalDbMaintenanceTestUtils,
  type CriticalDbFreshness,
  type CriticalDbScheduledRebuildDependencies,
  clearCriticalDbRebuildFailure,
  createCriticalDbScheduledRebuildFunction,
  inspectCriticalDbFreshness,
  processCriticalDbFreshness,
  processCriticalDbRebuildFailure,
  runCriticalDbBuilder,
} from "./critical-db-maintenance";

const fixtureRoots: string[] = [];
const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function freshness(overrides: Partial<CriticalDbFreshness> = {}): CriticalDbFreshness {
  return {
    available: true,
    checkedAt: new Date(NOW).toISOString(),
    dbPath: "/fixture/critical.db",
    builtAt: new Date(NOW - 2 * HOUR).toISOString(),
    builtAgeMs: 2 * HOUR,
    buildBudgetMs: 8 * HOUR,
    observationHighWaterAt: new Date(NOW - HOUR).toISOString(),
    observationAgeMs: HOUR,
    observationBudgetMs: DAY,
    sourceStaleAfterMs: 7 * DAY,
    degradedOverride: false,
    portStatus: "ok",
    sources: {},
    stale: false,
    reasons: [],
    ...overrides,
  };
}

function sourceReports(
  highWaterAt: string,
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(__criticalDbMaintenanceTestUtils.REQUIRED_SOURCES.map((source) => [
    source,
    { count: 10, status: "ok", highWaterAt, ...overrides[source] },
  ]));
}

async function fixtureDb(input: {
  builtAt: string;
  sources: Record<string, unknown>;
  degradedOverride?: boolean;
}): Promise<string> {
  const root = join("/tmp", `critical-db-maintenance-${crypto.randomUUID()}`);
  fixtureRoots.push(root);
  await mkdir(root, { recursive: true });
  const path = join(root, "critical.db");
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    db.exec("CREATE TABLE documents (source_updated_at INTEGER)");
    db.prepare("INSERT INTO documents (source_updated_at) VALUES (?)").run(Math.floor(NOW / 1_000));
    const insert = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    insert.run("schema_version", "2");
    insert.run("built_at", input.builtAt);
    insert.run("sources_json", JSON.stringify(input.sources));
    insert.run("degraded_override", String(input.degradedOverride ?? false));
    insert.run("document_count", "1");
    insert.run("coverage_gaps_json", "[]");
  } finally {
    db.close();
  }
  return path;
}

function inspect(path: string): CriticalDbFreshness {
  return inspectCriticalDbFreshness({
    dbPath: path,
    now: NOW,
    buildBudgetMs: 8 * HOUR,
    observationBudgetMs: DAY,
  });
}

describe("critical.db freshness contract", () => {
  test.each([
    { label: "7h59m build", builtAge: 7 * HOUR + 59 * 60_000, observationAge: HOUR, stale: false },
    { label: "8h01m build", builtAge: 8 * HOUR + 60_000, observationAge: HOUR, stale: true },
    { label: "23h59m observation", builtAge: HOUR, observationAge: 23 * HOUR + 59 * 60_000, stale: false },
    { label: "24h01m observation", builtAge: HOUR, observationAge: DAY + 60_000, stale: true },
  ])("classifies $label at the requested boundary", async ({ builtAge, observationAge, stale }) => {
    const current = new Date(NOW).toISOString();
    const path = await fixtureDb({
      builtAt: new Date(NOW - builtAge).toISOString(),
      sources: sourceReports(current, {
        "files:observations": { highWaterAt: new Date(NOW - observationAge).toISOString() },
      }),
    });
    expect(inspect(path).stale).toBe(stale);
  });

  test.each(__criticalDbMaintenanceTestUtils.REQUIRED_SOURCES)(
    "matches the port when %s passes the seven-day threshold",
    async (source) => {
      const current = new Date(NOW).toISOString();
      const path = await fixtureDb({
        builtAt: new Date(NOW - HOUR).toISOString(),
        sources: sourceReports(current, {
          [source]: { highWaterAt: new Date(NOW - 7 * DAY - 60_000).toISOString() },
        }),
      });
      const alert = inspect(path);
      expect(alert.portStatus).toBe(readFreshness(path, new Date(NOW)).status);
      expect(alert).toMatchObject({ portStatus: "stale", stale: true });
      expect(alert.reasons).toContainEqual(expect.stringContaining(`${source} high-water age`));
    },
  );

  test.each(__criticalDbMaintenanceTestUtils.REQUIRED_SOURCES)(
    "matches the port when %s is degraded",
    async (source) => {
      const current = new Date(NOW).toISOString();
      const path = await fixtureDb({
        builtAt: new Date(NOW - HOUR).toISOString(),
        sources: sourceReports(current, { [source]: { status: "error" } }),
      });
      const alert = inspect(path);
      expect(alert.portStatus).toBe(readFreshness(path, new Date(NOW)).status);
      expect(alert).toMatchObject({ portStatus: "degraded", stale: true });
      expect(alert.reasons).toContain(`${source} status is error`);
    },
  );

  test("matches the port for degraded_override", async () => {
    const current = new Date(NOW).toISOString();
    const degradedOverridePath = await fixtureDb({
      builtAt: new Date(NOW - HOUR).toISOString(),
      sources: sourceReports(current),
      degradedOverride: true,
    });
    const overrideAlert = inspect(degradedOverridePath);
    expect(overrideAlert.portStatus).toBe(readFreshness(degradedOverridePath, new Date(NOW)).status);
    expect(overrideAlert).toMatchObject({ portStatus: "degraded", stale: true });
  });

  test("delegates stale observations to the latch adapter and resolves on recovery", async () => {
    const eventIds: string[] = [];
    let resolutions = 0;
    let current = freshness({ stale: true, reasons: ["source stale"], portStatus: "stale" });
    let now = 100;
    const dependencies = {
      inspect: async () => current,
      notify: async (_snapshot: CriticalDbFreshness, eventId: string) => {
        eventIds.push(eventId);
        return eventIds.length === 1;
      },
      resolve: async () => {
        resolutions += 1;
      },
      now: () => now,
    };

    expect((await processCriticalDbFreshness(dependencies)).alerted).toBe(true);
    now = 200;
    expect((await processCriticalDbFreshness(dependencies)).alerted).toBe(false);
    current = freshness();
    await processCriticalDbFreshness(dependencies);
    expect(resolutions).toBe(1);
    expect(eventIds).toHaveLength(2);
  });

  test("keeps a freshness incident pending when delivery fails", async () => {
    let attempts = 0;
    const dependencies = {
      inspect: async () => freshness({ stale: true, reasons: ["source stale"], portStatus: "stale" }),
      notify: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("delivery interrupted");
      },
      now: () => 100,
    };
    await expect(processCriticalDbFreshness(dependencies)).rejects.toThrow("delivery interrupted");
    expect((await processCriticalDbFreshness(dependencies)).alerted).toBe(true);
    expect(attempts).toBe(2);
  });

  test("treats a missing database as degraded and stale", () => {
    const result = inspectCriticalDbFreshness({
      dbPath: `/tmp/missing-critical-${crypto.randomUUID()}.db`,
      now: NOW,
      buildBudgetMs: 8 * HOUR,
      observationBudgetMs: DAY,
    });
    expect(result).toMatchObject({ available: false, portStatus: "degraded", stale: true });
    expect(result.reasons[0]).toContain("inspection failed");
  });
});

describe("critical.db scheduled rebuild failures", () => {
  test("held builder lock produces builder exit 1", async () => {
    const root = join("/tmp", `critical-db-lock-${crypto.randomUUID()}`);
    fixtureRoots.push(root);
    await mkdir(root, { recursive: true });
    const dbPath = join(root, "critical.db");
    await mkdir(`${dbPath}.build-lock`);
    await expect(runCriticalDbBuilder({
      env: { ...process.env, JOELCLAW_CRITICAL_DB: dbPath },
      timeoutMs: 30_000,
    })).rejects.toThrow(/builder exited 1:.*builder lock is held/u);
  });

  test("delegates rebuild failures and recovery to the latch adapter", async () => {
    const eventIds: string[] = [];
    let resolved = false;
    let now = 100;
    const dependencies = {
      notify: async (_detail: string, eventId: string) => {
        eventIds.push(eventId);
        return eventIds.length === 1;
      },
      now: () => now,
    };
    expect((await processCriticalDbRebuildFailure("first path", dependencies)).alerted).toBe(true);
    now = 200;
    expect((await processCriticalDbRebuildFailure("different count", dependencies)).alerted).toBe(false);
    expect(eventIds).toHaveLength(2);

    await clearCriticalDbRebuildFailure(async () => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  test("a successful scheduled rebuild clears the prior failure incident", async () => {
    const completed: string[] = [];
    let resolved = false;
    const fn = createCriticalDbScheduledRebuildFunction({
      runBuilder: async () => ({ stdout: "published", stderr: "" }),
      notifyFailure: async () => undefined,
      resolveFailure: async () => {
        resolved = true;
      },
      emitFailure: async () => undefined,
      emitCompleted: async (stdout) => {
        completed.push(stdout);
      },
      now: () => 100,
    });
    const execution = await new InngestTestEngine({
      function: fn as any,
      events: [{ name: "inngest/scheduled.timer", data: { cron: "17 */6 * * *" } } as any],
    }).execute();
    expect(execution.result).toEqual({ stdout: "published", stderr: "" });
    expect(completed).toEqual(["published"]);
    expect(resolved).toBe(true);
  });

  test("keeps a rebuild incident pending when delivery fails", async () => {
    let attempts = 0;
    const dependencies = {
      notify: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("delivery interrupted");
      },
      now: () => 100,
    };
    await expect(processCriticalDbRebuildFailure("builder exited 1", dependencies)).rejects.toThrow(
      "delivery interrupted",
    );
    expect((await processCriticalDbRebuildFailure("detail drift", dependencies)).alerted).toBe(true);
    expect(attempts).toBe(2);
  });

  test("terminal onFailure invokes the stored incident and hard-alert adapter", async () => {
    const alerts: Array<{ detail: string; eventId: string }> = [];
    const failures: Array<{ detail: string; alerted: boolean }> = [];
    const dependencies: CriticalDbScheduledRebuildDependencies = {
      runBuilder: async () => {
        throw new Error("builder exited 1");
      },
      notifyFailure: async (detail, eventId) => {
        alerts.push({ detail, eventId });
      },
      resolveFailure: async () => undefined,
      emitFailure: async (detail, alerted) => {
        failures.push({ detail, alerted });
      },
      emitCompleted: async () => undefined,
      now: () => 100,
    };
    const fn = createCriticalDbScheduledRebuildFunction(dependencies) as any;
    expect(fn.opts.triggers).toEqual([{ cron: "17 */6 * * *" }]);
    await fn.opts.onFailure({
      error: new Error("builder exited 1: critical.db builder lock is held"),
      step: { run: async (_name: string, callback: () => Promise<unknown>) => callback() },
    });
    expect(alerts).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("builder exited 1") }),
    ]);
    expect(failures).toEqual([
      expect.objectContaining({ alerted: true, detail: expect.stringContaining("builder exited 1") }),
    ]);
  });
});
