import { NonRetriableError } from "inngest";
import { loadAgentDefinition } from "../../lib/agent-roster";
import { infer } from "../../lib/inference";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

type AgentTaskStep = {
  agent: string;
  task?: string;
};

type AgentChainStep = AgentTaskStep | { parallel: AgentTaskStep[] };

type AgentChainRunEvent = {
  chainId: string;
  task: string;
  steps: AgentChainStep[];
  failFast?: boolean;
  originSession?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
};

type AgentChainStepResult = {
  stepIndex: number;
  parallelIndex?: number;
  agent: string;
  task: string;
  status: "completed" | "failed";
  text: string;
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  durationMs: number;
  error?: string;
};

type StepTools = {
  run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T>;
  sendEvent: (
    id: string,
    payload:
      | {
          name: string;
          data: Record<string, unknown>;
        }
      | Array<{
          name: string;
          data: Record<string, unknown>;
        }>
  ) => Promise<unknown>;
};

type GatewayTools = {
  progress: (message: string, extra?: Record<string, unknown>) => Promise<unknown>;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sanitizeStepLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function isParallelStep(step: AgentChainStep): step is { parallel: AgentTaskStep[] } {
  return typeof step === "object" && step !== null && "parallel" in step;
}

function resolveStepTask(template: string | undefined, task: string, previous: string): string {
  const rawTemplate = asTrimmedString(template) || "{task}";
  return rawTemplate.replaceAll("{task}", task).replaceAll("{previous}", previous).trim();
}

function formatParallelAggregate(results: AgentChainStepResult[]): string {
  return results
    .map((result, index) => {
      const body = result.text || (result.error ? `[failed] ${result.error}` : "[no output]");
      return `=== Parallel Task ${index + 1} (${result.agent}) ===\n${body}`;
    })
    .join("\n\n")
    .trim();
}

function buildProgressTaskId(chainId: string, stepIndex: number, parallelIndex?: number): string {
  const suffix = typeof parallelIndex === "number" ? `${stepIndex + 1}.${parallelIndex + 1}` : `${stepIndex + 1}`;
  return `chain-${chainId}-${suffix}`;
}

function buildFailedResult(input: {
  stepIndex: number;
  parallelIndex?: number;
  agent: string;
  task: string;
  error: unknown;
}): AgentChainStepResult {
  return {
    stepIndex: input.stepIndex,
    parallelIndex: input.parallelIndex,
    agent: input.agent,
    task: input.task,
    status: "failed",
    text: "",
    durationMs: 0,
    error: toErrorMessage(input.error),
  };
}

async function runChainTaskStep(input: {
  chainId: string;
  task: string;
  previous: string;
  stepDef: AgentTaskStep;
  stepIndex: number;
  parallelIndex?: number;
  originSession?: string;
  cwd?: string;
  metadata: Record<string, unknown>;
  failFast: boolean;
  step: StepTools;
  gateway: GatewayTools;
}): Promise<AgentChainStepResult> {
  const agent = asTrimmedString(input.stepDef.agent);
  const resolvedTask = resolveStepTask(input.stepDef.task, input.task, input.previous);
  const scopeLabel =
    typeof input.parallelIndex === "number"
      ? `Step ${input.stepIndex + 1}.${input.parallelIndex + 1}`
      : `Step ${input.stepIndex + 1}`;
  const runId =
    typeof input.parallelIndex === "number"
      ? `chain:${input.stepIndex}:parallel:${input.parallelIndex}:${sanitizeStepLabel(agent)}`
      : `chain:${input.stepIndex}:${sanitizeStepLabel(agent)}`;
  const progressTaskId = buildProgressTaskId(input.chainId, input.stepIndex, input.parallelIndex);

  await input.step.sendEvent(`agent-chain-progress-start-${sanitizeStepLabel(progressTaskId)}`, {
    name: "agent/task.progress",
    data: {
      taskId: progressTaskId,
      agent,
      step: "execute",
      message: `${scopeLabel} started (${agent})`,
      originSession: input.originSession,
    },
  });

  try {
    const result = await input.step.run(runId, async () => {
      const startedAt = Date.now();

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "agent-chain-run",
        action: "agent.chain.step.started",
        success: true,
        metadata: {
          chainId: input.chainId,
          stepIndex: input.stepIndex,
          parallelIndex: input.parallelIndex,
          agent,
          originSession: input.originSession,
        },
      });

      try {
        if (!agent) {
          throw new NonRetriableError("agent/chain.run step requires non-empty agent name");
        }

        const definition = loadAgentDefinition(agent, input.cwd);
        if (!definition) {
          throw new NonRetriableError(`Unknown agent roster entry: ${agent}`);
        }

        await input.gateway.progress(`🤖 Chain ${input.chainId} ${scopeLabel}: running ${agent}`, {
          chainId: input.chainId,
          stepIndex: input.stepIndex,
          parallelIndex: input.parallelIndex,
          agent,
        });

        const inference = await infer(resolvedTask, {
          agent,
          component: "agent-chain-run",
          action: "agent.chain.step.run",
          metadata: {
            chainId: input.chainId,
            stepIndex: input.stepIndex,
            parallelIndex: input.parallelIndex,
            originSession: input.originSession,
            ...input.metadata,
          },
        });

        const durationMs = Date.now() - startedAt;

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "agent-chain-run",
          action: "agent.chain.step.completed",
          success: true,
          duration_ms: durationMs,
          metadata: {
            chainId: input.chainId,
            stepIndex: input.stepIndex,
            parallelIndex: input.parallelIndex,
            agent,
            model: inference.model,
            provider: inference.provider,
            originSession: input.originSession,
          },
        });

        return {
          stepIndex: input.stepIndex,
          parallelIndex: input.parallelIndex,
          agent,
          task: resolvedTask,
          status: "completed" as const,
          text: inference.text,
          model: inference.model,
          provider: inference.provider,
          usage: inference.usage
            ? {
                inputTokens: inference.usage.inputTokens,
                outputTokens: inference.usage.outputTokens,
                totalTokens: inference.usage.totalTokens,
              }
            : undefined,
          durationMs,
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = toErrorMessage(error);

        await emitOtelEvent({
          level: error instanceof NonRetriableError ? "warn" : "error",
          source: "worker",
          component: "agent-chain-run",
          action: "agent.chain.step.failed",
          success: false,
          duration_ms: durationMs,
          error: message,
          metadata: {
            chainId: input.chainId,
            stepIndex: input.stepIndex,
            parallelIndex: input.parallelIndex,
            agent,
            originSession: input.originSession,
          },
        });

        if (input.failFast) {
          throw error;
        }

        return {
          stepIndex: input.stepIndex,
          parallelIndex: input.parallelIndex,
          agent,
          task: resolvedTask,
          status: "failed" as const,
          text: "",
          durationMs,
          error: message,
        };
      }
    });

    await input.step.sendEvent(`agent-chain-progress-complete-${sanitizeStepLabel(progressTaskId)}`, {
      name: "agent/task.progress",
      data: {
        taskId: progressTaskId,
        agent,
        step: "complete",
        message:
          result.status === "completed"
            ? `${scopeLabel} completed (${agent})`
            : `${scopeLabel} failed (${agent}): ${result.error ?? "unknown error"}`,
        originSession: input.originSession,
      },
    });

    return result;
  } catch (error) {
    await input.step.sendEvent(`agent-chain-progress-failed-${sanitizeStepLabel(progressTaskId)}`, {
      name: "agent/task.progress",
      data: {
        taskId: progressTaskId,
        agent,
        step: "failed",
        message: `${scopeLabel} failed (${agent}): ${toErrorMessage(error)}`,
        originSession: input.originSession,
      },
    });

    throw error;
  }
}

export const agentChainRun = inngest.createFunction(
  {
    id: "agent-chain-run",
    name: "Agent Chain Run",
    retries: 1,
    concurrency: { limit: 2, key: "event.data.chainId" },
    timeouts: { finish: "15m" },
  },
  { event: "agent/chain.run" },
  async ({ event, step, gateway }) => {
    const payload = event.data as AgentChainRunEvent;
    const chainId = asTrimmedString(payload.chainId);
    const task = asTrimmedString(payload.task);
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    const failFast = payload.failFast === true;
    const originSession = asTrimmedString(payload.originSession) || undefined;
    const cwd = asTrimmedString(payload.cwd) || undefined;
    const metadata = payload.metadata ?? {};
    const startedAt = Date.now();
    const results: AgentChainStepResult[] = [];

    await step.run("emit-chain-started-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "agent-chain-run",
        action: "agent.chain.started",
        success: true,
        metadata: {
          chainId,
          steps: steps.length,
          failFast,
          originSession,
          cwd,
        },
      });
    });

    try {
      await step.run("validate", async () => {
        if (!chainId || !task) {
          throw new NonRetriableError("agent/chain.run requires non-empty chainId and task");
        }

        if (!steps.length) {
          throw new NonRetriableError("agent/chain.run requires at least one chain step");
        }

        for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
          const stepDef = steps[stepIndex];

          if (isParallelStep(stepDef)) {
            if (!Array.isArray(stepDef.parallel) || stepDef.parallel.length === 0) {
              throw new NonRetriableError(`agent/chain.run step ${stepIndex + 1} has empty parallel group`);
            }

            continue;
          }

          if (!asTrimmedString(stepDef.agent)) {
            throw new NonRetriableError(`agent/chain.run step ${stepIndex + 1} requires a non-empty agent`);
          }
        }
      });

      let previous = task;

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const stepDef = steps[stepIndex];

        if (isParallelStep(stepDef)) {
          const settled = await Promise.allSettled(
            stepDef.parallel.map((parallelStep, parallelIndex) =>
              runChainTaskStep({
                chainId,
                task,
                previous,
                stepDef: parallelStep,
                stepIndex,
                parallelIndex,
                originSession,
                cwd,
                metadata,
                failFast,
                step: step as StepTools,
                gateway: gateway as GatewayTools,
              })
            )
          );

          const parallelResults = settled.map((entry, parallelIndex) => {
            if (entry.status === "fulfilled") {
              return entry.value;
            }

            if (failFast) {
              throw entry.reason;
            }

            const rawStep = stepDef.parallel[parallelIndex];
            const agent = asTrimmedString(rawStep?.agent) || "unknown";
            const resolvedTask = resolveStepTask(rawStep?.task, task, previous);
            return buildFailedResult({
              stepIndex,
              parallelIndex,
              agent,
              task: resolvedTask,
              error: entry.reason,
            });
          });

          results.push(...parallelResults);
          previous = formatParallelAggregate(parallelResults);
          continue;
        }

        const result = await runChainTaskStep({
          chainId,
          task,
          previous,
          stepDef,
          stepIndex,
          originSession,
          cwd,
          metadata,
          failFast,
          step: step as StepTools,
          gateway: gateway as GatewayTools,
        });

        results.push(result);
        previous = result.text || (result.error ?? "");
      }

      const durationMs = Date.now() - startedAt;
      const status = results.some((result) => result.status === "failed")
        ? "completed_with_errors"
        : "completed";

      await step.sendEvent("emit-agent-chain-complete", {
        name: "agent/chain.complete",
        data: {
          chainId,
          status,
          task,
          results,
          durationMs,
          originSession,
          metadata,
        },
      });

      await step.run("emit-chain-completed-otel", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "agent-chain-run",
          action: "agent.chain.completed",
          success: true,
          duration_ms: durationMs,
          metadata: {
            chainId,
            status,
            steps: steps.length,
            results: results.length,
            failed: results.filter((result) => result.status === "failed").length,
            originSession,
          },
        });
      });

      return {
        chainId,
        task,
        status,
        results,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = toErrorMessage(error);

      await step.sendEvent("emit-agent-chain-failed", {
        name: "agent/chain.complete",
        data: {
          chainId,
          status: "failed",
          task,
          results,
          durationMs,
          originSession,
          metadata,
          error: message,
        },
      });

      await step.run("emit-chain-failed-otel", async () => {
        await emitOtelEvent({
          level: error instanceof NonRetriableError ? "warn" : "error",
          source: "worker",
          component: "agent-chain-run",
          action: "agent.chain.failed",
          success: false,
          duration_ms: durationMs,
          error: message,
          metadata: {
            chainId,
            steps: steps.length,
            results: results.length,
            originSession,
          },
        });
      });

      throw error;
    }
  }
);
