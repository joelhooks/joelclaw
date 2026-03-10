import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSuccessEnvelope } from "../response";
import { __workloadTestUtils, workloadCmd } from "./workload";

const tempDirs: string[] = [];

const rememberTempDir = (dir: string) => {
  tempDirs.push(dir);
  return dir;
};

const runGit = (repoDir: string, args: string[]) => {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `git failed: ${args.join(" ")}`,
    );
  }

  return result.stdout.trim();
};

const writeRepoFile = (
  repoDir: string,
  relativePath: string,
  content: string,
) => {
  const target = join(repoDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
};

const makeTempGitRepo = () => {
  const repoDir = rememberTempDir(
    mkdtempSync(join(tmpdir(), "workload-plan-")),
  );
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.name", "Panda"]);
  runGit(repoDir, ["config", "user.email", "panda@example.com"]);

  writeRepoFile(repoDir, "README.md", "# temp repo\n");
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "init"]);

  writeRepoFile(
    repoDir,
    "packages/core/skills/published.ts",
    "export const core = true\n",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "add core skill"]);

  writeRepoFile(
    repoDir,
    "packages/db/intent.ts",
    "export const dbIntent = true\n",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "add db intent"]);

  writeRepoFile(
    repoDir,
    "packages/sdk/intent.ts",
    "export const sdkIntent = true\n",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "add sdk intent"]);

  return repoDir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("workload CLI command", () => {
  it("wires the workload command with the expected subcommands", () => {
    expect(workloadCmd).toBeDefined();
    expect(workloadCmd.descriptor._tag).toBe("Subcommands");

    const subcommandNames = workloadCmd.descriptor.children.map((child) => {
      const command = child.command as {
        command?: { name?: string };
        name?: string;
        parent?: { command?: { name?: string } };
      };
      return (
        command.command?.name ?? command.name ?? command.parent?.command?.name
      );
    });

    expect(subcommandNames).toEqual(["plan", "dispatch", "run"]);
  });

  it("plans docs/truth work as serial inline host work by default", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "groom ADR-0217 truth and docs",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:40:00Z"),
    );

    expect(plan.request.kind).toBe("repo.docs");
    expect(plan.request.shape).toBe("serial");
    expect(plan.plan.mode).toBe("inline");
    expect(plan.plan.backend).toBe("host");
    expect(plan.request.artifacts).toContain("docs");
    expect(plan.plan.workloadId).toBe("WL_20260308_164000");
    expect(plan.warnings).toContain(
      "no explicit acceptance criteria were provided; the planner inferred defaults",
    );
  });

  it("plans runtime proof work as durable restate work with proof artifacts", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "run a supervised canary and soak for the queue observer",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "canary",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:41:00Z"),
    );

    expect(plan.request.kind).toBe("runtime.proof");
    expect(plan.request.shape).toBe("serial");
    expect(plan.plan.mode).toBe("durable");
    expect(plan.plan.backend).toBe("restate");
    expect(plan.request.risk).toContain("human-signoff");
    expect(plan.request.artifacts).toContain("telemetry-proof");
    expect(plan.request.artifacts).toContain("rollback-plan");
  });

  it("plans research spikes as parallel work with comparison output", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "compare two sandbox approaches for agent coding work",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:42:00Z"),
    );

    expect(plan.request.kind).toBe("research.spike");
    expect(plan.request.shape).toBe("parallel");
    expect(plan.plan.stages.map((stage) => stage.id)).toEqual([
      "stage-1a",
      "stage-1b",
      "stage-2",
    ]);
    expect(plan.request.artifacts).toContain("comparison");
  });

  it("does not force sandbox mode when sandbox is only the subject of research", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "compare local sandbox vs k8s sandbox vs loop ergonomics for agent coding work",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:42:30Z"),
    );

    expect(plan.request.kind).toBe("research.spike");
    expect(plan.request.risk).not.toContain("sandbox-required");
    expect(plan.plan.mode).toBe("inline");
    expect(plan.plan.backend).toBe("host");
  });

  it("prefers repo.refactor over repo.docs when implementation work includes docs follow-through", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "refactor workload planner heuristics, verify with tests, then update docs",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:42:45Z"),
    );

    expect(plan.request.kind).toBe("repo.refactor");
    expect(plan.request.shape).toBe("chained");
    expect(plan.request.artifacts).toEqual(
      expect.arrayContaining(["patch", "tests", "docs", "handoff"]),
    );
  });

  it("treats extend-plus-verify skill work as implementation instead of review", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "extend ADR-037 published skill coverage to packages/db and packages/sdk, verify with intent validation, then update README",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/badass-courses/gremlin",
        pathsText: "packages/db,packages/sdk,README.md",
      },
      new Date("2026-03-08T16:42:50Z"),
    );

    expect(plan.request.kind).toBe("repo.refactor");
    expect(plan.request.shape).toBe("chained");
    expect(plan.request.risk).not.toContain("deploy-allowed");
    expect(plan.request.artifacts).toEqual(
      expect.arrayContaining(["patch", "verification", "docs", "handoff"]),
    );
  });

  it("honors explicit shape overrides while preserving the chosen kind", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "refactor the queue planner internals",
        kind: "auto",
        shape: "serial",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
      },
      new Date("2026-03-08T16:43:00Z"),
    );

    expect(plan.request.kind).toBe("repo.refactor");
    expect(plan.request.shape).toBe("serial");
    expect(plan.inference.shape.inferred).toBe(false);
    expect(plan.inference.shape.reason).toContain("pinned by caller");
  });

  it("preserves acceptance embedded in intent and keeps supervised repo.patch canaries inline", () => {
    const intent =
      "Improve the agent-workloads planner based on gremlin dogfood evidence. Goal: fix misclassification of mixed code+docs+verification cleanup as repo.docs; ensure chained workloads can express an explicit reflection and plan-update milestone; repair the canonical docs/workloads.md truth source or update the skill if the path moved; and make planner output better at preserving file scope, proof posture, and stage boundaries for supervised repo.patch work. Acceptance: planner no longer collapses this class of work into repo.docs by default; chained plans can include reflection/update stages; canonical workload docs and skill references agree; and the gremlin cleanup prompt yields a materially better plan on rerun. If these changes alter canonical workload vocabulary or architecture, stop and capture the ADR/update before implementation.";

    const plan = __workloadTestUtils.planWorkload(
      {
        intent,
        kind: "repo.patch",
        shape: "chained",
        autonomy: "supervised",
        proof: "canary",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/joelhooks/joelclaw",
        pathsText:
          "docs/workloads.md,skills/agent-workloads,packages/cli,packages/sdk,docs,tests",
      },
      new Date("2026-03-08T18:42:28Z"),
    );

    expect(plan.request.acceptance).toEqual([
      "planner no longer collapses this class of work into repo.docs by default",
      "chained plans can include reflection/update stages",
      "canonical workload docs and skill references agree",
      "and the gremlin cleanup prompt yields a materially better plan on rerun",
    ]);
    expect(plan.plan.mode).toBe("inline");
    expect(plan.plan.backend).toBe("host");
    expect(plan.warnings).not.toContain(
      "no explicit acceptance criteria were provided; the planner inferred defaults",
    );
    expect(plan.plan.stages.map((stage) => stage.name)).toContain(
      "reflect and update plan",
    );
    expect(plan.plan.stages.length).toBeGreaterThan(4);
    expect(
      plan.plan.stages.some((stage) =>
        stage.reservedPaths?.includes("packages/cli"),
      ),
    ).toBe(true);
  });

  it("seeds path scope from recent commits when asked", () => {
    const repoDir = makeTempGitRepo();

    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "extend skill coverage and then verify the result",
        kind: "auto",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: repoDir,
        pathsFromText: "recent:2",
      },
      new Date("2026-03-08T18:50:00Z"),
    );

    expect(plan.inference.target.scope).toEqual({
      source: "git-recent",
      detail: "recent:2",
      pathCount: 2,
    });
    expect(plan.inference.target.value.paths).toEqual([
      "packages/db/intent.ts",
      "packages/sdk/intent.ts",
    ]);
  });

  it("pulls the fresh Gremlin MCP ADR cluster into adrCoverage when the slice materially points at it", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "add a gremlin MCP adapter over the operator knowledge plane with budget guards and streamable HTTP discovery",
        kind: "repo.refactor",
        shape: "chained",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/badass-courses/gremlin",
        pathsText:
          "apps/gremlin-cms/app/api/gremlin/knowledge/route.ts,apps/gremlin-cms/app/api/gremlin/mcp/route.ts,packages/gremlin/src/rate-limit.ts,docs/adr/0044-pluggable-mcp-adapters-over-canonical-gremlin-contracts.md",
      },
      new Date("2026-03-08T18:51:00Z"),
    );

    expect(plan.guidance.adrCoverage.records).toEqual(
      expect.arrayContaining([
        "ADR-0038",
        "ADR-0039",
        "ADR-0042",
        "ADR-0043",
        "ADR-0044",
      ]),
    );
    expect(plan.guidance.adrCoverage.note).toContain(
      "live repo-local ADR cluster",
    );
  });

  it("returns operator guidance and coding workload examples for bounded inline work", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "tighten workload CLI guidance so operators know when to execute inline and when to dispatch",
        kind: "repo.docs",
        shape: "serial",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/joelhooks/joelclaw",
        pathsText:
          "packages/cli/src/commands/workload.ts,docs/cli.md,docs/skills.md,skills/agent-workloads/SKILL.md",
      },
      new Date("2026-03-08T18:52:00Z"),
    );

    expect(plan.guidance.recommendedExecution).toBe("execute-inline-now");
    expect(plan.guidance.operatorSummary).toContain("Execute inline now");
    expect(plan.guidance.adrCoverage.records).toContain("ADR-0217");
    expect(plan.guidance.recommendedSkills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining([
        "workflow-rig",
        "cli-design",
        "skill-review",
      ]),
    );
    expect(plan.guidance.executionExamples.map((example) => example.shape)).toEqual(
      ["serial", "parallel", "chained"],
    );
    expect(plan.guidance.executionExamples[2]?.exampleCommand).toContain(
      "--shape chained",
    );
    expect(plan.guidance.executionLoop.approvalPrompt).toContain("approved?");
    expect(plan.guidance.executionLoop.approvedNextStep).toContain(
      "reserve the scoped files and execute the bounded slice directly",
    );
    expect(plan.guidance.executionLoop.progressUpdateExpectation).toContain(
      "pi extension/TUI",
    );
    expect(plan.guidance.executionLoop.completionExpectation).toContain(
      "commit pushed",
    );

    const nextActions = __workloadTestUtils.buildPlanNextActions(
      {
        intent:
          "tighten workload CLI guidance so operators know when to execute inline and when to dispatch",
        kind: "repo.docs",
        shape: "serial",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/joelhooks/joelclaw",
        pathsText:
          "packages/cli/src/commands/workload.ts,docs/cli.md,docs/skills.md,skills/agent-workloads/SKILL.md",
      },
      plan,
    );

    expect(
      nextActions.some((action) => action.command.includes("skills ensure")),
    ).toBe(true);
    expect(
      nextActions.some((action) => action.command.includes("mail reserve")),
    ).toBe(true);
  });

  it("recommends tightening scope before execution when the workload is still repo-wide", () => {
    const plan = __workloadTestUtils.planWorkload(
      {
        intent: "audit the current workload guidance and clean up what is stale",
        kind: "repo.review",
        shape: "auto",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/joelhooks/joelclaw",
      },
      new Date("2026-03-08T18:53:00Z"),
    );

    expect(plan.guidance.recommendedExecution).toBe("tighten-scope-first");
    expect(plan.guidance.operatorSummary).toContain("Tighten the path scope");
  });

  it("writes a reusable plan artifact when given a directory target", () => {
    const outputDir = rememberTempDir(
      mkdtempSync(join(tmpdir(), "workload-plan-artifact-")),
    );

    const targetPath = __workloadTestUtils.resolvePlanArtifactPath(
      `${outputDir}/`,
      "WL_20260308_185500",
    );
    const artifact = __workloadTestUtils.writePlanArtifact(
      targetPath,
      buildSuccessEnvelope("workload plan", { hello: "world" }, []),
    );

    expect(artifact.path).toBe(join(outputDir, "WL_20260308_185500.json"));
    expect(existsSync(artifact.path)).toBe(true);
    expect(readFileSync(artifact.path, "utf8")).toContain('"hello": "world"');
  });

  it("turns a saved plan artifact into a dispatch contract", () => {
    const artifactDir = rememberTempDir(
      mkdtempSync(join(tmpdir(), "workload-dispatch-")),
    );
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "Clean up the ADR-037 TanStack Intent rollout in gremlin. Goal: do the docs truth pass; wire package/db skill publishing; wire package/sdk skill publishing; verify intent validation; clean up remaining vitest fallout; and leave the Better Auth tail explicit for follow-up. Acceptance: the plan keeps these stages separate; file scope stays bounded to the active rollout paths; and the result is reusable as a handoff artifact.",
        kind: "repo.patch",
        shape: "chained",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/badass-courses/gremlin",
        pathsText: "README.md,packages/db,packages/sdk,vitest.config.ts",
      },
      new Date("2026-03-08T19:00:00Z"),
    );

    const planPath = __workloadTestUtils.resolvePlanArtifactPath(
      `${artifactDir}/`,
      plan.plan.workloadId,
    );
    __workloadTestUtils.writePlanArtifact(
      planPath,
      buildSuccessEnvelope("workload plan", plan, []),
    );

    const parsed = __workloadTestUtils.parseWorkloadPlanArtifact(planPath);
    const dispatch = __workloadTestUtils.buildDispatchContract({
      sourcePlanPath: parsed.absolutePath,
      result: parsed.result,
      stageId: "stage-2",
      from: "MaroonReef",
      to: "BlueFox",
      now: new Date("2026-03-08T19:00:30Z"),
    });

    expect(dispatch.dispatchId).toBe("WD_20260308_190030");
    expect(dispatch.selectedStage.id).toBe("stage-2");
    expect(dispatch.mail.subject).toContain(plan.plan.workloadId);
    expect(dispatch.mail.to).toBe("BlueFox");
    expect(dispatch.handoff.goal).toBe("wire package/db skill publishing");
    expect(dispatch.handoff.remainingGates[0]).toBe(
      "stage-2: wire package/db skill publishing",
    );
    expect(dispatch.handoff.reservedPaths).toEqual([
      "README.md",
      "packages/db",
      "packages/sdk",
      "vitest.config.ts",
    ]);
    expect(dispatch.guidance.recommendation).toBe(
      "execute-dispatched-stage-now",
    );
    expect(dispatch.guidance.stageReason).toContain("explicitly chose stage-2");
    expect(dispatch.guidance.adrCoverage.records).toContain("ADR-0038");
    expect(dispatch.guidance.executionLoop.approvalPrompt).toContain(
      "approved?",
    );
    expect(dispatch.guidance.executionLoop.approvedNextStep).toContain(
      "reserve the scoped files",
    );
  });

  it("builds a canonical workload runtime request for queue-backed execution", () => {
    const artifactDir = rememberTempDir(
      mkdtempSync(join(tmpdir(), "workload-run-")),
    );
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "implement the operator knowledge plane MCP adapter with budget guards and streamable HTTP discovery",
        kind: "repo.refactor",
        shape: "chained",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/badass-courses/gremlin",
        pathsText:
          "apps/gremlin-cms/app/api/gremlin/knowledge/route.ts,apps/gremlin-cms/app/api/gremlin/mcp/route.ts,packages/gremlin/src/rate-limit.ts",
      },
      new Date("2026-03-08T19:20:00Z"),
    );

    const planPath = __workloadTestUtils.resolvePlanArtifactPath(
      `${artifactDir}/`,
      plan.plan.workloadId,
    );
    __workloadTestUtils.writePlanArtifact(
      planPath,
      buildSuccessEnvelope("workload plan", plan, []),
    );

    const parsed = __workloadTestUtils.parseWorkloadPlanArtifact(planPath);
    const run = __workloadTestUtils.buildWorkloadRunResult({
      sourcePlanPath: parsed.absolutePath,
      result: parsed.result,
      tool: "pi",
      executionMode: "sandbox",
      sandboxBackend: "local",
      sandboxMode: "full",
      now: new Date("2026-03-08T19:21:00Z"),
    });

    expect(run.runId).toBe("WR_20260308_192100");
    expect(run.event.family).toBe("workload/requested");
    expect(run.event.target).toBe("system/agent.requested");
    expect(run.runtimeRequest.workflowId).toBe(plan.plan.workloadId);
    expect(run.runtimeRequest.storyId).toBe("stage-1");
    expect(run.runtimeRequest.executionMode).toBe("sandbox");
    expect(run.runtimeRequest.sandboxBackend).toBe("local");
    expect(run.runtimeRequest.sandboxMode).toBe("full");
    expect(run.runtimeRequest.sandbox).toBe("workspace-write");
    expect(run.runtimeRequest.cwd).toBe(
      "/Users/joel/Code/badass-courses/gremlin",
    );
    expect(run.runtimeRequest.readFiles).toBe(true);
    expect(run.runtimeRequest.task).toContain(plan.request.acceptance[0]!);
    expect(run.guidance.adrCoverage.records).toEqual(
      expect.arrayContaining([
        "ADR-0038",
        "ADR-0039",
        "ADR-0042",
        "ADR-0043",
        "ADR-0044",
      ]),
    );

    const nextActions = __workloadTestUtils.buildRunNextActions(
      parsed.absolutePath,
      {
        ...run,
        dryRun: true,
      },
    );

    expect(
      nextActions.some((action) => action.command.includes("workload run")),
    ).toBe(true);
  });

  it("warns that dispatch is overkill for bounded inline stage-1 work", () => {
    const artifactDir = rememberTempDir(
      mkdtempSync(join(tmpdir(), "workload-dispatch-inline-")),
    );
    const plan = __workloadTestUtils.planWorkload(
      {
        intent:
          "truth-groom the existing repo-honesty agent tooling in gremlin and prove the moved tests and docs are honest",
        kind: "repo.patch",
        shape: "serial",
        autonomy: "supervised",
        proof: "none",
        requestedBy: "Joel",
        repoText: "/Users/joel/Code/badass-courses/gremlin",
        pathsText:
          ".pi/extensions/repo-honesty.test.ts,.pi/tests/repo-honesty.test.ts,README.md,vitest.config.ts,docs/adr/README.md",
      },
      new Date("2026-03-08T19:42:31Z"),
    );

    const planPath = __workloadTestUtils.resolvePlanArtifactPath(
      `${artifactDir}/`,
      plan.plan.workloadId,
    );
    __workloadTestUtils.writePlanArtifact(
      planPath,
      buildSuccessEnvelope("workload plan", plan, []),
    );

    const parsed = __workloadTestUtils.parseWorkloadPlanArtifact(planPath);
    const dispatch = __workloadTestUtils.buildDispatchContract({
      sourcePlanPath: parsed.absolutePath,
      result: parsed.result,
      to: "MaroonReef",
      from: "MaroonReef",
      now: new Date("2026-03-08T19:44:25Z"),
    });

    expect(dispatch.selectedStage.id).toBe("stage-1");
    expect(dispatch.guidance.recommendation).toBe(
      "dispatch-is-overkill-keep-it-inline",
    );
    expect(dispatch.guidance.summary).toContain("bounded inline slice");
    expect(dispatch.guidance.executionLoop.approvedNextStep).toContain(
      "stop bouncing the slice around",
    );
    expect(dispatch.guidance.executionLoop.progressUpdateExpectation).toContain(
      "pi extension/TUI",
    );
  });

  it("writes a reusable dispatch artifact", () => {
    const outputDir = rememberTempDir(
      mkdtempSync(join(tmpdir(), "workload-dispatch-artifact-")),
    );

    const targetPath = __workloadTestUtils.resolvePlanArtifactPath(
      `${outputDir}/`,
      "WD_20260308_190500",
    );
    const artifact = __workloadTestUtils.writeDispatchArtifact(
      targetPath,
      buildSuccessEnvelope("workload dispatch", { dispatched: true }, []),
    );

    expect(artifact.path).toBe(join(outputDir, "WD_20260308_190500.json"));
    expect(existsSync(artifact.path)).toBe(true);
    expect(readFileSync(artifact.path, "utf8")).toContain('"dispatched": true');
  });
});
