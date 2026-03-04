import { describe, expect, test } from "bun:test";
import { parseSwarmYaml, validateSwarmDefinition } from "../schema";

describe("parseSwarmYaml", () => {
  test("parses valid YAML", () => {
    const yaml = `
swarm:
  name: demo-swarm
  workspace: /tmp/demo
  mode: sequential
  tool: codex
  agents:
    planner:
      role: planner
      task: Draft plan
    implementer:
      role: implementer
      task: Build the plan
      waits_for:
        - planner
      sandbox: danger-full-access
`;

    const def = parseSwarmYaml(yaml);

    expect(def.name).toBe("demo-swarm");
    expect(def.workspace).toBe("/tmp/demo");
    expect(def.mode).toBe("sequential");
    expect(def.tool).toBe("codex");
    expect(def.agents.get("planner")?.tool).toBe("codex");
    expect(def.agents.get("planner")?.sandbox).toBe("workspace-write");
    expect(def.agents.get("implementer")?.sandbox).toBe("danger-full-access");
  });
});

describe("validateSwarmDefinition", () => {
  test("catches unknown agent references", () => {
    const yaml = `
swarm:
  name: invalid
  workspace: /tmp/demo
  agents:
    worker:
      role: worker
      task: Do work
      waits_for:
        - missing-agent
`;

    const def = parseSwarmYaml(yaml);
    const errors = validateSwarmDefinition(def);

    expect(errors).toContain("Agent 'worker' waits_for unknown agent 'missing-agent'");
  });
});
