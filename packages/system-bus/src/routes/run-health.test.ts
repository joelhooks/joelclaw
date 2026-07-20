import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type RunHealthDependencies, registerRunHealthRoute } from "./run-health";

const freshSearch = {
  ok: true,
  detail: "fresh projection",
  freshness: {
    observedAt: "2026-07-20T00:00:00.000Z",
    latestSourceAt: "2026-07-19T23:59:55.000Z",
    ageMs: 5_000,
    reportedAt: "2026-07-20T00:00:30.000Z",
    observationAgeMs: 30_000,
    stale: false,
  },
  provenance: {
    engine: "typesense" as const,
    index: "runs_dev",
    sourceOfTruth: "raw-run-jsonl" as const,
    runId: "run-1",
    sourceIdentity: "source-1",
    fromOffset: 0,
    toOffset: 100,
    jsonlSha256: "hash-1",
    jsonlPath: "/fixture/run-1.jsonl",
  },
};

function appWith(readRecovery: RunHealthDependencies["readRecovery"]): Hono {
  const app = new Hono();
  registerRunHealthRoute(app, {
    readRecovery,
    typesenseAuthConfigured: () => true,
    runStore: () => "/fixture/runs",
  });
  return app;
}

async function health(readRecovery: RunHealthDependencies["readRecovery"]) {
  const response = await appWith(readRecovery).request("/api/runs/health");
  return { response, body: await response.json() as Record<string, unknown> };
}

const recovery = (search: typeof freshSearch | null, startupBudget: {
  unavailableSince: number;
  alertedAt: number | null;
} | null = null) => ({ startupBudget, startupBudgetMs: 60_000, search });

describe("GET /api/runs/health", () => {
  test("reports a fresh projection healthy", async () => {
    const { response, body } = await health(async () => recovery(freshSearch));
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, recovery: { search: freshSearch } });
  });

  test("reports a stale projection unhealthy", async () => {
    const stale = {
      ...freshSearch,
      ok: false,
      freshness: { ...freshSearch.freshness, stale: true, observationAgeMs: 180_000 },
    };
    const { response, body } = await health(async () => recovery(stale));
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, recovery: { search: { freshness: { stale: true } } } });
  });

  test("reports empty monitor state unhealthy", async () => {
    const { response, body } = await health(async () => recovery(null));
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, recovery: { search: null } });
  });

  test("reports an active collection outage unhealthy", async () => {
    const { response, body } = await health(async () => recovery(
      { ...freshSearch, ok: false },
      { unavailableSince: 1_000, alertedAt: null },
    ));
    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      recovery: { startupBudget: { unavailableSince: 1_000 } },
    });
  });

  test("promotes monitor store errors to top-level failure", async () => {
    const { response, body } = await health(async () => {
      throw new Error("Redis unavailable");
    });
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, recovery: null });
    expect(body.error).toContain("Redis unavailable");
  });
});
