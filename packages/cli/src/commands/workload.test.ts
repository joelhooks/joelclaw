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

    expect(subcommandNames).toEqual(["plan"]);
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
});
