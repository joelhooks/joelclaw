import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __memoryReviewAdapterTestUtils,
  collectOtel,
  collectSessionsFromDatabase,
} from "./adapters";

describe("memory review adapters", () => {
  test("excludes the current request and returns one latest receipt per conversation", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-review-sessions-"));
    const path = join(directory, "sessions.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        machine_id TEXT NOT NULL,
        agent_runtime TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL
      );
    `);
    const insert = db.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("current-1", "current-session", "flagg", "pi", 2_000, 2_001, 2);
    insert.run("past-1", "past-session", "flagg", "claude", 1_500, 1_501, 4);
    insert.run("past-2", "past-session", "panda", "claude", 1_800, 1_801, 6);
    db.close();

    try {
      const result = collectSessionsFromDatabase(path, {
        cutoffMs: 1_000,
        currentSessionIds: ["current-session"],
        limit: 20,
      });
      expect(result.total).toBe(1);
      expect(result.excludedCurrent).toBe(1);
      expect(result.sessions.map((session) => session.runId)).toEqual(["past-2"]);
      expect(result.byHost).toEqual({ panda: 1 });
      expect(result.lastVerifiedByHost).toEqual({
        flagg: new Date(2_000).toISOString(),
        panda: new Date(1_800).toISOString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not present unscoped session metadata as project-filtered evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-review-scoped-sessions-"));
    const path = join(directory, "sessions.db");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, conversation_id TEXT, machine_id TEXT, agent_runtime TEXT, ended_at INTEGER, captured_at INTEGER, turn_count INTEGER);",
    );
    db.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "run-1",
      "session-1",
      "flagg",
      "pi",
      2_000,
      2_001,
      2,
    );
    db.close();

    try {
      const result = collectSessionsFromDatabase(path, {
        cutoffMs: 1_000,
        currentSessionIds: [],
        limit: 20,
        project: "joelhooks.joelclaw",
        workstream: "main",
      });
      expect(result.status).toBe("partial");
      expect(result.total).toBe(0);
      expect(result.sessions).toEqual([]);
      expect(result.issues[0]?.code).toBe("scope_filter_unavailable");
      expect(result.lastVerifiedByHost.flagg).toBe(new Date(2_000).toISOString());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("filtered OTEL review fails closed without querying untrusted text fields", async () => {
    const result = await collectOtel({
      sinceHours: 48,
      project: "joelhooks.joelclaw",
      workstream: "main",
      currentSessionIds: [],
      limit: 20,
    });
    expect(result.status).toBe("partial");
    expect(result.total).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.issues[0]?.code).toBe("scope_filter_unavailable");
  });

  test("requires all flowing status counts", () => {
    expect(
      __memoryReviewAdapterTestUtils.hasCompleteStatus(
        "records: 1\nactive jobs: 0\nblocked jobs: 0",
      ),
    ).toBe(true);
    expect(__memoryReviewAdapterTestUtils.hasCompleteStatus("records: 1\nblocked jobs: 0")).toBe(
      false,
    );
    expect(
      __memoryReviewAdapterTestUtils.hasCompleteStatus(
        "records: NaN\nactive jobs: 0\nblocked jobs: 0",
      ),
    ).toBe(false);
    expect(
      __memoryReviewAdapterTestUtils.hasCompleteStatus(
        "records: -1\nactive jobs: 0\nblocked jobs: 0",
      ),
    ).toBe(false);
  });

  test("parses only bounded status counts", () => {
    expect(
      __memoryReviewAdapterTestUtils.parseStatus(
        ["postgres: running", "active jobs: 1", "blocked jobs: 2", "records: 110"].join("\n"),
      ),
    ).toEqual({ records: 110, activeJobs: 1, blockedJobs: 2 });
  });

  test("Git scan makes unsupported remotes opaque and filters project/workstream exactly", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-review-git-"));
    const repo = join(home, "Code", "owner", "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    expect(git("init", "-b", "main").status).toBe(0);
    expect(git("config", "user.email", "test@example.com").status).toBe(0);
    expect(git("config", "user.name", "Test").status).toBe(0);
    writeFileSync(join(repo, "README.md"), "test\n");
    expect(git("add", "README.md").status).toBe(0);
    expect(git("commit", "-m", "test commit").status).toBe(0);
    expect(git("remote", "add", "origin", "file:///private/operator/repo.git").status).toBe(0);

    const scan = (project = "-", workstream = "-") =>
      spawnSync(
        "bash",
        ["-s", "--", String(Math.floor(Date.now() / 1000) - 3_600), project, workstream, "20"],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home },
          input: __memoryReviewAdapterTestUtils.GIT_SCAN_SCRIPT,
        },
      );

    try {
      const opaque = scan();
      expect(opaque.status).toBe(0);
      expect(opaque.stdout).toMatch(/^local\/[a-f0-9]{16}\x1fall\x1f/u);
      expect(opaque.stdout).not.toContain("private/operator");

      expect(git("remote", "set-url", "origin", "git@github.com:other/joelclaw.git").status).toBe(
        0,
      );
      expect(scan("joelhooks.joelclaw").stdout).toBe("");
      expect(scan("-", "mai").stdout).toBe("");

      expect(git("switch", "-c", "memory-review").status).toBe(0);
      writeFileSync(join(repo, "branch.txt"), "branch work\n");
      expect(git("add", "branch.txt").status).toBe(0);
      expect(git("commit", "-m", "branch commit").status).toBe(0);
      const branchHash = git("rev-parse", "HEAD").stdout.trim();
      expect(git("switch", "main").status).toBe(0);
      const branchEvidence = scan("-", "memory-review").stdout;
      expect(branchEvidence).toContain(`\x1fmemory-review\x1f${branchHash}\x1f`);
      expect(branchEvidence).toContain("branch commit");

      const broken = join(home, "Code", "broken", "repo", ".git");
      mkdirSync(broken, { recursive: true });
      expect(__memoryReviewAdapterTestUtils.gitIssueCount(scan().stdout)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("parses git receipts without repository paths", () => {
    const rows = __memoryReviewAdapterTestUtils.parseGitEvidence(
      "panda",
      "joelhooks/joelclaw\u001fmain\u001fabc123\u001f2026-08-24T08:00:00.000Z\u001ffix: bounded review\n",
    );
    expect(rows).toEqual([
      {
        host: "panda",
        repository: "joelhooks/joelclaw",
        branch: "main",
        hash: "abc123",
        at: "2026-08-24T08:00:00.000Z",
        subject: "fix: bounded review",
      },
    ]);
  });

  test("keeps flowing reflection and observation lanes separate and drops bodies", () => {
    const result = __memoryReviewAdapterTestUtils.flowingItems({
      composed: {
        lanes: {
          flowingReflections: {
            _tag: "RecallLaneAvailableV1",
            health: { _tag: "Healthy" },
            items: [
              { id: "r1", kind: "reflection", rank: 1, title: "Decision", summary: "private body" },
            ],
          },
          flowingObservations: {
            _tag: "RecallLaneAvailableV1",
            health: { _tag: "Stale" },
            items: [
              {
                id: "o1",
                kind: "observation",
                rank: 1,
                title: "Evidence",
                summary: "private body",
              },
            ],
          },
        },
      },
    });

    expect(result.issues.map((entry) => entry.code)).toEqual(["flowing_health_stale"]);
    expect(result.items).toEqual([
      {
        health: "Healthy",
        id: "r1",
        kind: "reflection",
        lane: "flowing-reflections",
        rank: 1,
        title: "Decision",
      },
      {
        health: "Stale",
        id: "o1",
        kind: "observation",
        lane: "flowing-observations",
        rank: 1,
        title: "Evidence",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private body");
  });

  test("drops malformed flowing ranks and malformed OTEL facet counts", () => {
    const result = __memoryReviewAdapterTestUtils.flowingItems({
      composed: {
        lanes: {
          flowingReflections: {
            _tag: "RecallLaneAvailableV1",
            health: { _tag: "Healthy" },
            items: [{ id: "bad", kind: "reflection", rank: Number.NaN, title: "Bad" }],
          },
          flowingObservations: {
            _tag: "RecallLaneAvailableV1",
            health: { _tag: "Healthy" },
            items: [],
          },
        },
      },
    });
    expect(result.items).toEqual([]);
    expect(result.issues.map((entry) => entry.code)).toEqual(["flowing_item_invalid"]);
    expect(
      __memoryReviewAdapterTestUtils.otelErrors([
        { field_name: "level", counts: [{ value: "error", count: Number.NaN }] },
      ]),
    ).toBe(0);
  });

  test("reports a missing flowing lane instead of silently accepting it", () => {
    const result = __memoryReviewAdapterTestUtils.flowingItems({
      composed: {
        lanes: {
          flowingReflections: {
            _tag: "RecallLaneAvailableV1",
            health: { _tag: "Healthy" },
            items: [],
          },
        },
      },
    });
    expect(result.issues.map((entry) => entry.code)).toEqual(["flowing_lane_missing"]);
  });

  test("reports typed flowing lane unavailability", () => {
    const result = __memoryReviewAdapterTestUtils.flowingItems({
      composed: {
        lanes: {
          flowingReflections: {
            _tag: "RecallLaneUnavailableV1",
            code: "timeout",
            message: "timed out",
          },
          flowingObservations: {
            _tag: "RecallLaneUnavailableV1",
            code: "store-unavailable",
            message: "store unavailable",
          },
        },
      },
    });

    expect(result.items).toEqual([]);
    expect(result.issues.map((entry) => entry.code)).toEqual([
      "flowing_lane_unavailable",
      "flowing_lane_unavailable",
    ]);
    expect(JSON.stringify(result.issues)).not.toContain("timed out");
    expect(JSON.stringify(result.issues)).not.toContain("store unavailable");
  });

  test("matches Brain projects by exact owner and repository", () => {
    expect(
      __memoryReviewAdapterTestUtils.matchesBrainProject(
        "joelhooks/joelclaw",
        "joelhooks.joelclaw",
      ),
    ).toBe(true);
    expect(
      __memoryReviewAdapterTestUtils.matchesBrainProject("joelhooks/joelclaw", "other.joelclaw"),
    ).toBe(false);
    expect(
      __memoryReviewAdapterTestUtils.matchesBrainProject("joelhooks/joelclaw", "joelclaw"),
    ).toBe(false);
  });

  test("parses simple Brain frontmatter without exposing page bodies", () => {
    expect(
      __memoryReviewAdapterTestUtils.frontmatter(
        [
          "---",
          "title: Recent Memory",
          "privacy: private",
          "workstream: gateway-recovery",
          "---",
          "secret body",
        ].join("\n"),
      ),
    ).toEqual({
      title: "Recent Memory",
      privacy: "private",
      workstream: "gateway-recovery",
    });
  });
});
