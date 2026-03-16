import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  convertToWorkloadStages,
  type ExplicitStage,
  parseAndValidateStagesFile,
  parseStagesFile,
  validateStageDag,
} from "./workload-stages";

const tempDirs: string[] = [];

const rememberTempDir = (path: string) => {
  tempDirs.push(path);
  return path;
};

const writeStagesFixture = (stages: unknown) => {
  const dir = rememberTempDir(mkdtempSync(join(tmpdir(), "workload-stages-")));
  const path = join(dir, "stages.json");
  writeFileSync(path, `${JSON.stringify(stages, null, 2)}\n`, "utf8");
  return path;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("workload explicit stages", () => {
  it("parses the Firecracker stages fixture", () => {
    const fixturePath = resolve(process.cwd(), "infra/firecracker/stages.json");
    const stages = parseStagesFile(fixturePath);

    expect(stages).toHaveLength(10);
    expect(stages[0]).toMatchObject({
      id: "fix-admin-port",
      name: "Fix Restate admin reachability",
      executionMode: "manual",
    });
    expect(stages[5]).toMatchObject({
      id: "create-snapshot",
      dependsOn: ["build-rootfs"],
    });
  });

  it("rejects missing required fields", () => {
    const path = writeStagesFixture([
      {
        id: "broken-stage",
        name: "Broken stage",
      },
    ]);

    expect(() => parseStagesFile(path)).toThrow(
      'Stage 1 is missing required field "acceptance"',
    );
  });

  it("detects cycles in the stage DAG", () => {
    const stages: ExplicitStage[] = [
      { id: "alpha", name: "Alpha", acceptance: ["alpha"], dependsOn: ["gamma"] },
      { id: "beta", name: "Beta", acceptance: ["beta"], dependsOn: ["alpha"] },
      { id: "gamma", name: "Gamma", acceptance: ["gamma"], dependsOn: ["beta"] },
    ];

    expect(() => validateStageDag(stages)).toThrow(
      /Cycle detected in stage DAG: (alpha|beta|gamma)/,
    );
  });

  it("identifies parallel branches after a shared prerequisite", () => {
    const stages: ExplicitStage[] = [
      { id: "step-1", name: "Step 1", acceptance: ["done"] },
      { id: "step-2", name: "Step 2", acceptance: ["done"], dependsOn: ["step-1"] },
      { id: "step-3", name: "Step 3", acceptance: ["done"], dependsOn: ["step-2"] },
      { id: "step-4", name: "Step 4", acceptance: ["done"], dependsOn: ["step-3"] },
      { id: "step-5", name: "Step 5", acceptance: ["done"], dependsOn: ["step-3"] },
      {
        id: "step-6",
        name: "Step 6",
        acceptance: ["done"],
        dependsOn: ["step-4", "step-5"],
      },
    ];

    const dagInfo = validateStageDag(stages);

    expect(dagInfo.hasParallel).toBe(true);
    expect(dagInfo.isLinear).toBe(false);
    expect(dagInfo.topologicalOrder.indexOf("step-3")).toBeLessThan(
      dagInfo.topologicalOrder.indexOf("step-4"),
    );
    expect(dagInfo.topologicalOrder.indexOf("step-3")).toBeLessThan(
      dagInfo.topologicalOrder.indexOf("step-5"),
    );
  });

  it("calculates the Firecracker critical path", () => {
    const fixturePath = resolve(process.cwd(), "infra/firecracker/stages.json");
    const { dagInfo } = parseAndValidateStagesFile(fixturePath);

    expect(dagInfo.criticalPath).toEqual([
      "install-firecracker",
      "build-rootfs",
      "create-snapshot",
      "microvm-runner",
      "wire-dagworker",
      "canary",
      "docs-api-consumer",
    ]);
  });

  it("infers the Firecracker DAG shape as chained", () => {
    const fixturePath = resolve(process.cwd(), "infra/firecracker/stages.json");
    const { dagInfo } = parseAndValidateStagesFile(fixturePath);

    expect(dagInfo.inferredShape).toBe("chained");
    expect(dagInfo.hasParallel).toBe(true);
    expect(Array.from(dagInfo.phases.entries())).toEqual([
      ["A", ["fix-admin-port", "triage-queue", "worker-to-k8s"]],
      ["B", ["install-firecracker", "build-rootfs", "create-snapshot"]],
      ["C", ["microvm-runner", "wire-dagworker", "canary"]],
      ["D", ["docs-api-consumer"]],
    ]);
  });

  it("converts explicit stages into WorkloadStage records", () => {
    const fixturePath = resolve(process.cwd(), "infra/firecracker/stages.json");
    const stages = convertToWorkloadStages(parseStagesFile(fixturePath));

    expect(stages).toHaveLength(10);
    expect(stages.find((stage) => stage.id === "fix-admin-port")).toMatchObject({
      mode: "inline",
      owner: "planner",
      verification: [
        "joelclaw jobs status reports restate as healthy without manual port-forward",
        "NodePort 30970 added to k8s/restate.yaml Service for admin API (9070)",
      ],
      reservedPaths: ["k8s/restate.yaml"],
    });
    expect(stages.find((stage) => stage.id === "worker-to-k8s")).toMatchObject({
      mode: "durable",
      owner: "worker",
      dependsOn: ["fix-admin-port"],
    });
    expect(stages.find((stage) => stage.id === "canary")).toMatchObject({
      mode: "durable",
      dependsOn: ["wire-dagworker"],
    });
  });
});
