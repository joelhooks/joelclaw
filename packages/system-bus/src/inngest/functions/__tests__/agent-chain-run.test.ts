import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";

const inferCalls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
const sendEventCalls: unknown[][] = [];
const failingAgents = new Set<string>();
const agentOutputs = new Map<string, string>();

const mockAgentDefinition = {
  name: "agent",
  description: "Test agent",
  model: "claude-sonnet-4-6",
  tools: [],
  skills: [],
  extensions: [],
  systemPrompt: "You are a test agent.",
  source: "project" as const,
  filePath: "/tmp/.pi/agents/agent.md",
};

mock.module(new URL("../../../lib/agent-roster.ts", import.meta.url).pathname, () => ({
  loadAgentDefinition: (agent: string) => ({
    ...mockAgentDefinition,
    name: agent,
  }),
}));

mock.module(new URL("../../../lib/inference.ts", import.meta.url).pathname, () => ({
  infer: async (prompt: string, opts: Record<string, unknown>) => {
    inferCalls.push({ prompt, opts });

    const agent = String(opts.agent ?? "unknown");
    if (failingAgents.has(agent)) {
      throw new Error(`forced failure for ${agent}`);
    }

    return {
      text: agentOutputs.get(agent) ?? `output:${agent}:${prompt}`,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    };
  },
}));

mock.module(new URL("../../../observability/emit.ts", import.meta.url).pathname, () => ({
  emitOtelEvent: async () => ({ stored: false }),
}));

async function executeChain(data: Record<string, unknown>) {
  const { agentChainRun } = await import("../agent-chain-run");

  const engine = new InngestTestEngine({
    function: agentChainRun as any,
    events: [
      {
        name: "agent/chain.run",
        data,
      } as any,
    ],
    transformCtx: (ctx: any) => {
      ctx.gateway = {
        originSession: "telegram:test",
        progress: async () => ({ pushed: true, type: "progress" }),
        notify: async () => ({ pushed: true, type: "notify" }),
        alert: async () => ({ pushed: true, type: "alert" }),
      };

      ctx.step.sendEvent = async (...args: unknown[]) => {
        sendEventCalls.push(args);
        return { ids: ["mock-event-id"] };
      };

      return ctx;
    },
  });

  return engine.execute();
}

function getSentEvent(name: string): Record<string, unknown> | undefined {
  const hit = sendEventCalls.find((call) => {
    const payload = call[1] as { name?: string } | undefined;
    return payload?.name === name;
  });

  const payload = hit?.[1] as { data?: Record<string, unknown> } | undefined;
  return payload?.data;
}

describe("agentChainRun", () => {
  beforeEach(() => {
    inferCalls.length = 0;
    sendEventCalls.length = 0;
    failingAgents.clear();
    agentOutputs.clear();
  });

  test("registers agent/chain.run trigger with chain concurrency", async () => {
    const { agentChainRun } = await import("../agent-chain-run");

    const opts = (agentChainRun as any).opts;
    const triggerDefs = (opts?.triggers ?? []) as Array<{ event?: string }>;

    expect(triggerDefs.some((trigger) => trigger.event === "agent/chain.run")).toBe(true);
    expect(opts?.concurrency).toMatchObject({
      limit: 2,
      key: "event.data.chainId",
    });
    expect(opts?.retries).toBe(1);
    expect(opts?.timeouts?.finish).toBe("15m");
  });

  test("substitutes {task} and {previous} template variables", async () => {
    agentOutputs.set("scout", "Scout summary");
    agentOutputs.set("planner", "Plan summary");

    await executeChain({
      chainId: "chain-template",
      task: "Build chain execution",
      steps: [
        { agent: "scout", task: "Analyze: {task}" },
        { agent: "planner", task: "Plan from: {previous}" },
      ],
    });

    expect(inferCalls[0]?.prompt).toBe("Analyze: Build chain execution");
    expect(inferCalls[1]?.prompt).toBe("Plan from: Scout summary");
  });

  test("passes each sequential step the immediate previous text output", async () => {
    agentOutputs.set("scout", "First output");
    agentOutputs.set("planner", "Second output");
    agentOutputs.set("coder", "Third output");

    await executeChain({
      chainId: "chain-seq",
      task: "Ship feature",
      steps: [
        { agent: "scout", task: "Step 1 {task}" },
        { agent: "planner", task: "Step 2 {previous}" },
        { agent: "coder", task: "Step 3 {previous}" },
      ],
    });

    expect(inferCalls[1]?.prompt).toBe("Step 2 First output");
    expect(inferCalls[2]?.prompt).toBe("Step 3 Second output");
  });

  test("aggregates parallel outputs for downstream {previous}", async () => {
    agentOutputs.set("scout", "Scout context");
    agentOutputs.set("planner", "Planner output");
    agentOutputs.set("reviewer", "Reviewer output");
    agentOutputs.set("coder", "Coder output");

    await executeChain({
      chainId: "chain-parallel",
      task: "Implement phase 3",
      steps: [
        { agent: "scout", task: "Prep {task}" },
        {
          parallel: [
            { agent: "planner", task: "Parallel plan using {previous}" },
            { agent: "reviewer", task: "Parallel review using {previous}" },
          ],
        },
        { agent: "coder", task: "Implement with\n{previous}" },
      ],
    });

    expect(inferCalls[1]?.prompt).toBe("Parallel plan using Scout context");
    expect(inferCalls[2]?.prompt).toBe("Parallel review using Scout context");

    const expectedAggregate =
      "=== Parallel Task 1 (planner) ===\nPlanner output\n\n=== Parallel Task 2 (reviewer) ===\nReviewer output";

    expect(inferCalls[3]?.prompt).toBe(`Implement with\n${expectedAggregate}`);
  });

  test("continues chain on step failure when failFast is false", async () => {
    agentOutputs.set("scout", "Scout context");
    agentOutputs.set("planner", "Planner output");
    agentOutputs.set("coder", "Coder output");
    failingAgents.add("reviewer");

    await executeChain({
      chainId: "chain-errors",
      task: "Ship safely",
      steps: [
        { agent: "scout", task: "Scout {task}" },
        {
          parallel: [
            { agent: "planner", task: "Plan {previous}" },
            { agent: "reviewer", task: "Review {previous}" },
          ],
        },
        { agent: "coder", task: "Code {previous}" },
      ],
    });

    const calledAgents = inferCalls.map((call) => String(call.opts.agent));
    expect(calledAgents).toContain("coder");

    const chainComplete = getSentEvent("agent/chain.complete");
    expect(chainComplete).toBeDefined();
    expect(chainComplete?.status).toBe("completed_with_errors");

    const results = chainComplete?.results as Array<{ agent: string; status: string }>;
    expect(results.some((result) => result.agent === "reviewer" && result.status === "failed")).toBe(true);
  });
});
