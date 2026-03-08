import { describe, expect, it } from "bun:test";
import { __workloadTestUtils, workloadCmd } from "./workload";

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
});
