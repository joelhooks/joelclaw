import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { type MemoryReviewHost, MemoryReviewResultV1Schema } from "./contract";
import { buildMemoryReview, type MemoryReviewDependencies, parseSince } from "./review";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function dependencies(overrides: Partial<MemoryReviewDependencies> = {}): MemoryReviewDependencies {
  const hosts: MemoryReviewHost[] = [
    {
      alias: "flagg",
      current: true,
      lastVerifiedAt: "2026-08-24T11:50:00.000Z",
      status: "available",
    },
    {
      alias: "panda",
      current: true,
      lastVerifiedAt: "2026-08-24T11:00:00.000Z",
      status: "available",
    },
    {
      alias: "blaine",
      current: false,
      lastVerifiedAt: "2026-08-13T04:00:00.000Z",
      status: "unavailable",
    },
  ];
  return {
    now: () => NOW,
    currentSessionIds: () => ["current-session"],
    collectSessions: async () => ({
      status: "available",
      issues: [],
      sessions: [
        {
          runId: "run-1",
          conversationId: "past-session",
          host: "flagg",
          runtime: "pi",
          endedAt: "2026-08-24T10:00:00.000Z",
          turnCount: 8,
        },
      ],
      total: 3,
      excludedCurrent: 1,
      byHost: { flagg: 2, panda: 1 },
      lastVerifiedByHost: {
        flagg: "2026-08-24T11:50:00.000Z",
        panda: "2026-08-24T11:00:00.000Z",
        blaine: "2026-08-13T04:00:00.000Z",
      },
    }),
    collectHosts: async () => hosts,
    collectGit: async () => ({
      status: "available",
      issues: [],
      commits: [
        {
          host: "flagg",
          repository: "joelhooks/joelclaw",
          branch: "main",
          hash: "abc123",
          at: "2026-08-24T09:00:00.000Z",
          subject: "fix memory",
        },
      ],
      total: 1,
      repositories: 1,
    }),
    collectBrain: async () => ({
      status: "available",
      issues: [],
      pages: [
        {
          root: "joelclaw",
          ref: "brain:joelclaw:abc123",
          title: "Memory",
          privacy: "private",
          modifiedAt: "2026-08-24T08:00:00.000Z",
        },
      ],
      total: 1,
      omittedSensitive: 1,
    }),
    collectOtel: async () => ({
      status: "available",
      issues: [],
      events: [
        {
          action: "memory.recall.completed",
          component: "recall-cli",
          host: "flagg",
          level: "info",
          success: true,
          timestamp: "2026-08-24T07:00:00.000Z",
        },
      ],
      total: 10,
      errors: 2,
    }),
    collectFlowing: async () => ({
      status: "partial",
      issues: [
        {
          source: "flowing",
          code: "flowing_jobs_blocked",
          host: null,
          message: "2 jobs are blocked",
        },
      ],
      items: [],
      records: 110,
      activeJobs: 0,
      blockedJobs: 2,
    }),
    ...overrides,
  };
}

describe("parseSince", () => {
  test("parses a bounded relative duration", () => {
    expect(parseSince("48h", NOW)).toEqual({ cutoffMs: NOW - 48 * 3_600_000, requested: "48h" });
  });

  test("rejects future and malformed values", () => {
    expect(() => parseSince("later", NOW)).toThrow("past ISO instant");
    expect(() => parseSince("2026-08-25T00:00:00.000Z", NOW)).toThrow("past ISO instant");
  });
});

describe("buildMemoryReview", () => {
  test("keeps evidence lanes separate and reports offline hosts without presenting them as current", async () => {
    const result = await buildMemoryReview({ since: "48h", limit: 20 }, dependencies());

    expect(() => Schema.decodeUnknownSync(MemoryReviewResultV1Schema)(result)).not.toThrow();
    expect(result.scope).toEqual({ mode: "fleet", project: null, workstream: null });
    expect(result.currentRequestExcluded).toBe(true);
    expect(result.lanes.sessions.excludedCurrent).toBe(1);
    expect(result.lanes.git.commits).toHaveLength(1);
    expect(result.lanes.brain.pages).toHaveLength(1);
    expect(JSON.stringify(result.lanes.brain.pages)).not.toContain(".svx");
    expect(JSON.stringify(result.lanes.brain.pages)).not.toContain("/projects/");
    expect(result.lanes.otel.events).toHaveLength(1);
    expect(result.lanes.flowing.items).toHaveLength(0);
    expect(result.hosts.find((host) => host.alias === "blaine")).toEqual({
      alias: "blaine",
      current: false,
      lastVerifiedAt: "2026-08-13T04:00:00.000Z",
      status: "unavailable",
    });
    expect(result.summary.join(" ")).toContain("blaine is unavailable; last verified activity");
    expect(result.summary.join(" ")).toContain("Source warnings: flowing=partial");
  });

  test("keeps the current invocation excluded even outside an agent session", async () => {
    const result = await buildMemoryReview(
      { since: "48h", limit: 20 },
      dependencies({
        currentSessionIds: () => [],
      }),
    );
    expect(result.currentRequestExcluded).toBe(true);
  });

  test("rejects non-finite numbers before JSON serialization", async () => {
    const result = await buildMemoryReview({ since: "48h", limit: 20 }, dependencies());
    const malformed = {
      ...result,
      lanes: {
        ...result.lanes,
        otel: { ...result.lanes.otel, total: Number.NaN },
      },
    };
    expect(() => Schema.decodeUnknownSync(MemoryReviewResultV1Schema)(malformed)).toThrow(
      "finite non-negative integer",
    );
  });

  test("makes fleet availability failure visible instead of dropping host state", async () => {
    const result = await buildMemoryReview(
      { since: "48h", limit: 20 },
      dependencies({
        collectHosts: async () => {
          throw new Error("manifest missing");
        },
      }),
    );
    expect(result.hosts).toEqual([
      { alias: "fleet", current: false, lastVerifiedAt: null, status: "failed" },
    ]);
    expect(result.summary.join(" ")).toContain("fleet is failed");
  });

  test("survives one collector failure and preserves the other lanes", async () => {
    const result = await buildMemoryReview(
      { since: "48h", limit: 20 },
      dependencies({
        collectGit: async () => {
          throw new Error("git exploded");
        },
      }),
    );

    expect(result.lanes.git.status).toBe("failed");
    expect(result.lanes.git.issues[0]?.code).toBe("collector_failed");
    expect(JSON.stringify(result.lanes.git.issues)).not.toContain("git exploded");
    expect(result.lanes.sessions.total).toBe(3);
    expect(result.lanes.brain.total).toBe(1);
    expect(result.summary.join(" ")).toContain("git=failed");
  });

  test("finishes OTEL collection before a scoped flowing read can emit request telemetry", async () => {
    let otelFinished = false;
    const base = dependencies();
    await buildMemoryReview(
      { since: "48h", project: "joelhooks.joelclaw", workstream: "main", limit: 5 },
      dependencies({
        collectOtel: async (input) => {
          await Bun.sleep(10);
          otelFinished = true;
          return base.collectOtel(input);
        },
        collectFlowing: async (input) => {
          expect(otelFinished).toBe(true);
          return base.collectFlowing(input);
        },
      }),
    );
  });

  test("passes optional filters to every source without inventing an implicit flowing scope", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const base = dependencies();
    const result = await buildMemoryReview(
      {
        since: "2d",
        project: "joelhooks.joelclaw",
        workstream: "gateway-recovery",
        limit: 7,
      },
      dependencies({
        collectSessions: async (input) => {
          seen.push({ source: "sessions", ...input });
          return base.collectSessions(input);
        },
        collectGit: async (input) => {
          seen.push({ source: "git", ...input });
          return base.collectGit(input);
        },
        collectBrain: async (input) => {
          seen.push({ source: "brain", ...input });
          return base.collectBrain(input);
        },
        collectOtel: async (input) => {
          seen.push({ source: "otel", ...input });
          return base.collectOtel(input);
        },
        collectFlowing: async (input) => {
          seen.push({ source: "flowing", ...input });
          return base.collectFlowing(input);
        },
      }),
    );

    expect(result.scope).toEqual({
      mode: "filtered",
      project: "joelhooks.joelclaw",
      workstream: "gateway-recovery",
    });
    expect(seen).toHaveLength(5);
    expect(seen.map((input) => input.source)).toEqual([
      "sessions",
      "git",
      "brain",
      "otel",
      "flowing",
    ]);
    for (const input of seen) {
      expect(input.project).toBe("joelhooks.joelclaw");
      expect(input.workstream).toBe("gateway-recovery");
      expect(input.limit).toBe(7);
    }
  });
});
