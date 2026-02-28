import { NonRetriableError } from "inngest";
import { loadAgentDefinition } from "../../lib/agent-roster";
import { infer } from "../../lib/inference";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

type AgentTaskRunEvent = {
  taskId: string;
  agent: string;
  task: string;
  originSession?: string;
  cwd?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveTimeoutMs(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (timeoutMs < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;

  return Math.floor(timeoutMs);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const agentTaskRun = inngest.createFunction(
  {
    id: "agent-task-run",
    name: "Agent Task Run",
    retries: 2,
    concurrency: { limit: 3, key: "event.data.agent" },
    timeouts: { finish: "5m" },
  },
  { event: "agent/task.run" },
  async ({ event, step, gateway }) => {
    const payload = event.data as AgentTaskRunEvent;
    const taskId = asTrimmedString(payload.taskId);
    const agent = asTrimmedString(payload.agent);
    const task = asTrimmedString(payload.task);
    const originSession = asTrimmedString(payload.originSession) || undefined;
    const cwd = asTrimmedString(payload.cwd) || undefined;
    const timeoutMs = resolveTimeoutMs(payload.timeoutMs);
    const metadata = payload.metadata ?? {};
    const startedAt = Date.now();

    await step.run("emit-started-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "agent-task-run",
        action: "agent.task.started",
        success: true,
        metadata: {
          taskId,
          agent,
          originSession,
          cwd,
          timeoutMs,
        },
      });
    });

    try {
      const validated = await step.run("validate", async () => {
        if (!taskId || !agent || !task) {
          throw new NonRetriableError(
            "agent/task.run requires non-empty taskId, agent, and task"
          );
        }

        const definition = loadAgentDefinition(agent, cwd);
        if (!definition) {
          throw new NonRetriableError(`Unknown agent roster entry: ${agent}`);
        }

        return {
          taskId,
          agent,
          task,
          originSession,
          timeoutMs,
          metadata,
        };
      });

      await step.sendEvent("agent-task-progress-execute", {
        name: "agent/task.progress",
        data: {
          taskId: validated.taskId,
          agent: validated.agent,
          step: "execute",
          message: "Agent task execution started",
          originSession: validated.originSession,
        },
      });

      const result = await step.run("execute", async () => {
        await gateway.progress(
          `🤖 Running ${validated.agent} task ${validated.taskId}`,
          {
            taskId: validated.taskId,
            agent: validated.agent,
            phase: "execute",
          }
        );

        return infer(validated.task, {
          agent: validated.agent,
          timeout: validated.timeoutMs,
          component: "agent-task-run",
          action: "agent.task.run",
          metadata: {
            taskId: validated.taskId,
            originSession: validated.originSession,
            ...validated.metadata,
          },
        });
      });

      const durationMs = Date.now() - startedAt;
      await step.sendEvent("agent-task-complete", {
        name: "agent/task.complete",
        data: {
          taskId: validated.taskId,
          agent: validated.agent,
          status: "completed",
          text: result.text,
          model: result.model,
          provider: result.provider,
          durationMs,
          usage: result.usage
            ? {
                promptTokens: result.usage.inputTokens,
                completionTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
              }
            : undefined,
          originSession: validated.originSession,
        },
      });

      await step.run("emit-completed-otel", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "agent-task-run",
          action: "agent.task.completed",
          success: true,
          duration_ms: durationMs,
          metadata: {
            taskId: validated.taskId,
            agent: validated.agent,
            originSession: validated.originSession,
            model: result.model,
            provider: result.provider,
          },
        });
      });

      return {
        taskId: validated.taskId,
        agent: validated.agent,
        status: "completed" as const,
        text: result.text,
        model: result.model,
        provider: result.provider,
        durationMs,
      };
    } catch (error) {
      const message = toErrorMessage(error);
      const durationMs = Date.now() - startedAt;

      await step.sendEvent("agent-task-complete-failed", {
        name: "agent/task.complete",
        data: {
          taskId,
          agent,
          status: "failed",
          durationMs,
          originSession,
          error: message,
        },
      });

      await step.run("emit-failed-otel", async () => {
        await emitOtelEvent({
          level: error instanceof NonRetriableError ? "warn" : "error",
          source: "worker",
          component: "agent-task-run",
          action: "agent.task.failed",
          success: false,
          duration_ms: durationMs,
          error: message,
          metadata: {
            taskId,
            agent,
            originSession,
          },
        });
      });

      throw error;
    }
  }
);
