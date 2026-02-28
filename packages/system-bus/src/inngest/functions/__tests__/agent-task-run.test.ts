import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";

const loadAgentDefinitionCalls: Array<{ agent: string; cwd?: string }> = [];
const inferCalls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
const sendEventCalls: unknown[][] = [];

const mockAgentDefinition = {
  name: "panda",
  description: "Test agent",
  model: "claude-sonnet-4-6",
  tools: [],
  skills: [],
  extensions: [],
  systemPrompt: "You are Panda.",
  source: "project" as const,
  filePath: "/tmp/.pi/agents/panda.md",
};

mock.module(new URL("../../../lib/agent-roster.ts", import.meta.url).pathname, () => ({
  loadAgentDefinition: (agent: string, cwd?: string) => {
    loadAgentDefinitionCalls.push({ agent, cwd });
    return mockAgentDefinition;
  },
}));

mock.module(new URL("../../../lib/inference.ts", import.meta.url).pathname, () => ({
  infer: async (prompt: string, opts: Record<string, unknown>) => {
    inferCalls.push({ prompt, opts });
    return {
      text: "Task completed",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
      },
    };
  },
}));

mock.module(new URL("../../../observability/emit.ts", import.meta.url).pathname, () => ({
  emitOtelEvent: async () => ({ stored: false }),
}));

describe("agentTaskRun", () => {
  beforeEach(() => {
    loadAgentDefinitionCalls.length = 0;
    inferCalls.length = 0;
    sendEventCalls.length = 0;
  });

  test("registers agent/task.run trigger with per-agent concurrency", async () => {
    const { agentTaskRun } = await import("../agent-task-run");

    const opts = (agentTaskRun as any).opts;
    const triggerDefs = (opts?.triggers ?? []) as Array<{ event?: string }>;

    expect(triggerDefs.some((trigger) => trigger.event === "agent/task.run")).toBe(true);
    expect(opts?.concurrency).toMatchObject({
      limit: 3,
      key: "event.data.agent",
    });
    expect(opts?.retries).toBe(2);
  });

  test("calls loadAgentDefinition with the incoming agent", async () => {
    const { agentTaskRun } = await import("../agent-task-run");

    const engine = new InngestTestEngine({
      function: agentTaskRun as any,
      events: [
        {
          name: "agent/task.run",
          data: {
            taskId: "task-123",
            agent: "panda",
            task: "Summarize this task",
            originSession: "telegram:test",
            cwd: "/tmp/workspace",
          },
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

    await engine.execute();

    expect(loadAgentDefinitionCalls).toEqual([
      {
        agent: "panda",
        cwd: "/tmp/workspace",
      },
    ]);

    expect(inferCalls).toHaveLength(1);
    expect(inferCalls[0]?.opts?.agent).toBe("panda");

    const emittedEventNames = sendEventCalls.map((call) => {
      const payload = call[1] as { name?: string } | undefined;
      return payload?.name;
    });

    expect(emittedEventNames).toContain("agent/task.progress");
    expect(emittedEventNames).toContain("agent/task.complete");
  });
});
