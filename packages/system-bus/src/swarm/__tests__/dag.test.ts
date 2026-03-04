import { describe, expect, test } from "bun:test";
import {
  buildDependencyGraph,
  buildExecutionWaves,
  detectCycles,
} from "../dag";
import type { SwarmDefinition } from "../schema";

function makeFanOutDefinition(): SwarmDefinition {
  return {
    name: "fanout",
    workspace: "/tmp/project",
    mode: "parallel",
    targetCount: 1,
    tool: "codex",
    agents: new Map([
      [
        "researchA",
        {
          name: "researchA",
          role: "research",
          task: "Collect A",
          reportsTo: ["lead"],
          waitsFor: [],
          tool: "codex",
          sandbox: "workspace-write",
        },
      ],
      [
        "researchB",
        {
          name: "researchB",
          role: "research",
          task: "Collect B",
          reportsTo: ["lead"],
          waitsFor: [],
          tool: "codex",
          sandbox: "workspace-write",
        },
      ],
      [
        "lead",
        {
          name: "lead",
          role: "synthesizer",
          task: "Combine outputs",
          reportsTo: [],
          waitsFor: [],
          tool: "codex",
          sandbox: "workspace-write",
        },
      ],
    ]),
    agentOrder: ["researchA", "researchB", "lead"],
  };
}

describe("buildDependencyGraph", () => {
  test("builds a 2→1 fan-out graph via reports_to", () => {
    const deps = buildDependencyGraph(makeFanOutDefinition());

    expect([...deps.get("researchA") ?? []]).toEqual([]);
    expect([...deps.get("researchB") ?? []]).toEqual([]);
    expect([...deps.get("lead") ?? []].sort()).toEqual(["researchA", "researchB"]);
  });
});

describe("detectCycles", () => {
  test("catches a cycle", () => {
    const deps = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);

    const cycles = detectCycles(deps);
    expect(cycles).not.toBeNull();
    expect(cycles?.sort()).toEqual(["a", "b"]);
  });
});

describe("buildExecutionWaves", () => {
  test("produces waves for fan-out dependencies", () => {
    const deps = buildDependencyGraph(makeFanOutDefinition());
    const waves = buildExecutionWaves(deps);

    expect(waves).toEqual([["researchA", "researchB"], ["lead"]]);
  });
});
