import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { emitOtel, notifyGateway, previewOutput } from "../otel";

// --- Constants ---

const MAX_SIMULATED_MS = 30_000;
const MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_HANDLER_TIMEOUT_MS = 120_000;
const MAX_HANDLER_TIMEOUT_MS = 60 * 60_000;

const PI_PATH_DIRS = [
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.bun/bin`,
  `${process.env.HOME}/.local/share/fnm/aliases/default/bin`,
];

// --- Types ---

export type DagHandler = "noop" | "shell" | "http" | "infer" | "microvm";

export interface DagNodeInput {
  id: string;
  task: string;
  dependsOn?: string[];
  handler?: DagHandler;
  config?: Record<string, unknown>;
  simulatedMs?: number;
}

export interface DagRunRequest {
  requestId?: string;
  pipeline?: string;
  nodes: DagNodeInput[];
}

export interface DagWorkerRequest {
  nodeId: string;
  task: string;
  wave: number;
  dependsOn: string[];
  handler: DagHandler;
  config: Record<string, unknown>;
  dependencyOutputs: Record<string, string>;
  simulatedMs?: number;
  workflowId?: string;
  pipeline?: string;
}

export interface DagWorkerResult {
  nodeId: string;
  task: string;
  wave: number;
  dependsOn: string[];
  handler: DagHandler;
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface DagWaveResult {
  waveIndex: number;
  nodeIds: string[];
  results: DagWorkerResult[];
}

export interface DagRunResult {
  workflowId: string;
  requestId: string;
  pipeline: string;
  nodeCount: number;
  waveCount: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  completionOrder: string[];
  waves: DagWaveResult[];
}

// --- Normalization & validation ---

interface DagNodeNormalized {
  id: string;
  task: string;
  dependsOn: string[];
  handler: DagHandler;
  config: Record<string, unknown>;
  simulatedMs: number;
}

const normalizeNode = (node: DagNodeInput): DagNodeNormalized => {
  const id = node.id.trim();
  const task = node.task.trim();

  if (!id) throw new Error("DAG node id is required");
  if (!task) throw new Error(`DAG node ${id} requires a non-empty task`);

  const handler = node.handler ?? "noop";
  const validHandlers: DagHandler[] = ["noop", "shell", "http", "infer", "microvm"];
  if (!validHandlers.includes(handler)) {
    throw new Error(`DAG node ${id} has invalid handler: ${handler}`);
  }

  const dependsOn = Array.from(
    new Set((node.dependsOn ?? []).map((dep) => dep.trim()).filter(Boolean)),
  ).sort();
  const simulatedMs = Math.max(0, Math.min(node.simulatedMs ?? 0, MAX_SIMULATED_MS));

  return { id, task, dependsOn, handler, config: node.config ?? {}, simulatedMs };
};

const validateAndNormalize = (nodes: DagNodeInput[]): DagNodeNormalized[] => {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("DAG requires at least one node");
  }

  const normalized = nodes.map(normalizeNode);
  const seen = new Set<string>();

  for (const node of normalized) {
    if (seen.has(node.id)) throw new Error(`Duplicate DAG node id: ${node.id}`);
    seen.add(node.id);
  }

  for (const node of normalized) {
    if (node.dependsOn.includes(node.id)) {
      throw new Error(`Node ${node.id} cannot depend on itself`);
    }
    for (const dep of node.dependsOn) {
      if (!seen.has(dep)) throw new Error(`Node ${node.id} depends on missing node ${dep}`);
    }
  }

  return normalized.sort((a, b) => a.id.localeCompare(b.id));
};

const buildExecutionWaves = (nodes: DagNodeNormalized[]): string[][] => {
  const dependencies = new Map<string, Set<string>>();
  const remaining = new Set<string>();

  for (const node of nodes) {
    dependencies.set(node.id, new Set(node.dependsOn));
    remaining.add(node.id);
  }

  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => (dependencies.get(id)?.size ?? 0) === 0)
      .sort((a, b) => a.localeCompare(b));

    if (ready.length === 0) {
      const cycleCandidates = [...remaining].sort((a, b) => a.localeCompare(b));
      throw new Error(`Cycle detected in DAG dependencies: ${cycleCandidates.join(", ")}`);
    }

    waves.push(ready);
    for (const readyId of ready) remaining.delete(readyId);
    for (const deps of dependencies.values()) {
      for (const readyId of ready) deps.delete(readyId);
    }
  }

  return waves;
};

// --- Utility ---

const truncate = (s: string): string =>
  s.length > MAX_OUTPUT_BYTES
    ? `${s.slice(0, MAX_OUTPUT_BYTES)}\n[truncated at ${MAX_OUTPUT_BYTES} bytes]`
    : s;

const interpolateOutputs = (
  template: string,
  outputs: Record<string, string>,
): string => {
  let result = template;
  for (const [nodeId, output] of Object.entries(outputs)) {
    result = result.replaceAll(`{{${nodeId}}}`, output);
  }
  return result;
};

/** Interpolate {{nodeId}} templates in all string-valued config fields. */
const interpolateConfig = (
  config: Record<string, unknown>,
  outputs: Record<string, string>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      result[key] = interpolateOutputs(value, outputs);
    } else {
      result[key] = value;
    }
  }
  return result;
};

/** Convert dependency outputs to DEP_* env vars for shell handlers. */
const buildDepEnv = (outputs: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [nodeId, output] of Object.entries(outputs)) {
    const envKey = `DEP_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    env[envKey] = output;
  }
  return env;
};

const resolveHandlerTimeoutMs = (config: Record<string, unknown>): number => {
  const raw = config.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_HANDLER_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(raw, MAX_HANDLER_TIMEOUT_MS));
};

// --- Handler implementations ---

async function executeShell(
  config: Record<string, unknown>,
  depEnv: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const command = config.command as string | undefined;
  if (!command) throw new Error("shell handler requires config.command");

  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...depEnv,
      JOELCLAW_REPO_CACHE: "/app/repo-cache",
      JOELCLAW_WORKER_HEARTBEAT_DIR: "/tmp/joelclaw-worker-heartbeat",
    },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const result = {
    exitCode,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };

  if (exitCode !== 0) {
    throw new Error(`shell handler failed: ${truncate(JSON.stringify(result))}`);
  }

  return truncate(JSON.stringify(result));
}

async function executeHttp(config: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const url = config.url as string | undefined;
  if (!url) throw new Error("http handler requires config.url");

  const method = (config.method as string) ?? "GET";
  const headers = (config.headers as Record<string, string>) ?? {};
  const body = config.body as string | undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: controller.signal,
  });
  const text = await response.text();
  clearTimeout(timer);

  return truncate(
    JSON.stringify({
      status: response.status,
      ok: response.ok,
      body: text.trimEnd(),
    }),
  );
}

async function executeInfer(
  config: Record<string, unknown>,
  dependencyOutputs: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const promptTemplate = config.prompt as string | undefined;
  if (!promptTemplate) throw new Error("infer handler requires config.prompt");

  const model = config.model as string | undefined;
  const system = config.system as string | undefined;

  const prompt = interpolateOutputs(promptTemplate, dependencyOutputs);

  const promptDir = await mkdtemp(join(tmpdir(), "dag-infer-"));
  const promptPath = join(promptDir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf-8");

  try {
    const args: string[] = ["pi", "-p", "--no-session", "--no-extensions"];
    if (model) args.push("--models", model);
    if (system) args.push("--system-prompt", system);

    const proc = Bun.spawn(args, {
      stdin: Bun.file(promptPath),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: [...PI_PATH_DIRS, process.env.PATH].filter(Boolean).join(":"),
      },
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      throw new Error(
        `pi inference failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
      );
    }

    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.text) return truncate(parsed.text);
    } catch {
      // not JSON — use raw stdout
    }

    return truncate(stdout.trimEnd());
  } finally {
    await rm(promptDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeMicroVm(
  config: Record<string, unknown>,
  _depEnv: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const { execInMicroVm } = await import("@joelclaw/agent-execution");

  const sandboxId = `dag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const kernelPath =
    (config.kernelPath as string | undefined)?.trim() || "/tmp/firecracker-test/vmlinux";
  const rootfsPath =
    (config.rootfsPath as string | undefined)?.trim() ||
    "/tmp/firecracker-test/agent-rootfs.ext4";
  const command =
    (config.command as string | undefined)?.trim() || 'echo "no command specified"';
  const vcpuCount =
    typeof config.vcpuCount === "number" && Number.isFinite(config.vcpuCount)
      ? config.vcpuCount
      : 2;
  const memSizeMib =
    typeof config.memSizeMib === "number" && Number.isFinite(config.memSizeMib)
      ? config.memSizeMib
      : 512;

  // One-shot model: execInMicroVm handles the full lifecycle
  // (create workspace image → write command → boot VM → wait for exit → read results)
  const result = await execInMicroVm(null, command, timeoutMs, {
    sandboxId,
    kernelPath,
    rootfsPath,
    vcpuCount,
    memSizeMib,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `microvm command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return truncate(result.stdout.trimEnd());
}

// --- dagWorker service (with OTEL instrumentation) ---

export const dagWorker = restate.service({
  name: "dagWorker",
  options: {
    defaultRetryPolicy: {
      initialInterval: { seconds: 1 },
      maxInterval: { seconds: 30 },
      maxAttempts: 5,
    },
  },
  handlers: {
    execute: async (
      ctx: restate.Context,
      input: DagWorkerRequest,
    ): Promise<DagWorkerResult> => {
      const startedAt = await ctx.run("mark-start", () => new Date().toISOString());
      const startMs = Date.now();

      await ctx.run("record-input", () => ({
        nodeId: input.nodeId,
        handler: input.handler,
        wave: input.wave,
        dependsOn: input.dependsOn,
      }));

      // OTEL: node started
      await ctx.run("otel-node-started", async () => {
        await emitOtel({
          action: "dag.node.started",
          component: "dag-worker",
          metadata: {
            workflowId: input.workflowId,
            pipeline: input.pipeline,
            nodeId: input.nodeId,
            handler: input.handler,
            wave: input.wave,
            task: input.task,
            dependsOn: input.dependsOn,
            depCount: Object.keys(input.dependencyOutputs).length,
          },
        });
        return true;
      });

      // noop sleep (Restate timer primitive, outside ctx.run)
      if (input.handler === "noop" && input.simulatedMs && input.simulatedMs > 0) {
        await ctx.sleep({ milliseconds: input.simulatedMs });
      }

      // Interpolate config templates with dependency outputs
      const resolvedConfig = interpolateConfig(input.config, input.dependencyOutputs);
      const depEnv = buildDepEnv(input.dependencyOutputs);
      const handlerTimeoutMs = resolveHandlerTimeoutMs(resolvedConfig);

      // Execute the handler inside ctx.run for durability
      let output: string;
      let failed = false;
      let errorMsg: string | undefined;

      try {
        output = await ctx.run("execute-task", async () => {
          switch (input.handler) {
            case "shell":
              return executeShell(resolvedConfig, depEnv, handlerTimeoutMs);
            case "http":
              return executeHttp(resolvedConfig, handlerTimeoutMs);
            case "infer":
              return executeInfer(resolvedConfig, input.dependencyOutputs, handlerTimeoutMs);
            case "microvm":
              return executeMicroVm(resolvedConfig, depEnv, handlerTimeoutMs);
            case "noop":
            default:
              return `completed:${input.nodeId}:${input.task}`;
          }
        });
      } catch (err) {
        failed = true;
        errorMsg = err instanceof Error ? err.message : String(err);

        // OTEL: node failed
        await ctx.run("otel-node-failed", async () => {
          await emitOtel({
            level: "error",
            action: "dag.node.failed",
            component: "dag-worker",
            success: false,
            error: errorMsg,
            metadata: {
              workflowId: input.workflowId,
              pipeline: input.pipeline,
              nodeId: input.nodeId,
              handler: input.handler,
              wave: input.wave,
              task: input.task,
              durationMs: Date.now() - startMs,
            },
          });
          return true;
        });

        throw err;
      }

      const completedAt = await ctx.run("mark-complete", () => new Date().toISOString());
      const durationMs = Date.now() - startMs;

      // OTEL: node completed
      await ctx.run("otel-node-completed", async () => {
        await emitOtel({
          action: "dag.node.completed",
          component: "dag-worker",
          metadata: {
            workflowId: input.workflowId,
            pipeline: input.pipeline,
            nodeId: input.nodeId,
            handler: input.handler,
            wave: input.wave,
            task: input.task,
            durationMs,
            outputPreview: previewOutput(output),
            outputBytes: output.length,
          },
        });
        return true;
      });

      return {
        nodeId: input.nodeId,
        task: input.task,
        wave: input.wave,
        dependsOn: input.dependsOn,
        handler: input.handler,
        output,
        startedAt,
        completedAt,
        durationMs,
      };
    },
  },
});

// --- dagOrchestrator workflow (with OTEL instrumentation) ---

export const dagOrchestrator = restate.workflow({
  name: "dagOrchestrator",
  options: {
    defaultRetryPolicy: {
      initialInterval: { seconds: 2 },
      maxInterval: { seconds: 60 },
      maxAttempts: 3,
    },
  },
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      request: DagRunRequest,
    ): Promise<DagRunResult> => {
      const pipelineName = request.pipeline ?? "unknown";
      const workflowStartMs = Date.now();

      // Note: Restate workflows support cancellation via terminate() API.
      // When terminated, all pending durable executions are cancelled,
      // and the workflow state becomes "cancelled". The system-bus
      // agent-dispatch function handles cancellation via cancelOn config.

      const initialized = await ctx.run("init-run", () => ({
        requestId: request.requestId?.trim() || ctx.key,
        startedAt: new Date().toISOString(),
      }));

      let nodes: DagNodeNormalized[];
      let waves: string[][];

      try {
        nodes = await ctx.run("validate-request", () =>
          validateAndNormalize(request.nodes),
        );
        waves = await ctx.run("build-waves", () => buildExecutionWaves(nodes));
      } catch (err) {
        // Gateway: notify on validation/planning failure
        const errorMsg = err instanceof Error ? err.message : String(err);
        await ctx.run("gateway-notify-error", async () => {
          await notifyGateway({
            message: `❌ DAG "${pipelineName}" failed during planning: ${errorMsg}`,
            priority: "high",
            source: "restate/dag",
            context: { workflowId: ctx.key, pipeline: pipelineName, phase: "planning" },
          });
          return true;
        });
        throw err;
      }

      const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

      // OTEL: workflow started
      await ctx.run("otel-workflow-started", async () => {
        await emitOtel({
          action: "dag.workflow.started",
          metadata: {
            workflowId: ctx.key,
            requestId: initialized.requestId,
            pipeline: pipelineName,
            nodeCount: nodes.length,
            waveCount: waves.length,
            handlers: Object.fromEntries(nodes.map((n) => [n.id, n.handler])),
            waveTopology: waves,
          },
        });
        return true;
      });

      // Accumulate outputs for dependency passing
      const outputsByNodeId: Record<string, string> = {};
      const waveResults: DagWaveResult[] = [];
      const completionOrder: string[] = [];

      try {
        for (const [waveIndex, nodeIds] of waves.entries()) {
          const waveStartMs = Date.now();

          // OTEL: wave dispatched
          await ctx.run(`otel-wave-${waveIndex}-dispatched`, async () => {
            await emitOtel({
              action: "dag.wave.dispatched",
              metadata: {
                workflowId: ctx.key,
                pipeline: pipelineName,
                waveIndex,
                nodeIds,
                nodeHandlers: nodeIds.map((id) => ({
                  id,
                  handler: nodeById.get(id)?.handler,
                })),
              },
            });
            return true;
          });

          await ctx.run(`wave-${waveIndex}-dispatch`, () => ({ waveIndex, nodeIds }));

          const results = await Promise.all(
            nodeIds.map((nodeId) => {
              const node = nodeById.get(nodeId);
              if (!node) throw new Error(`Missing node definition for ${nodeId}`);

              // Collect outputs from this node's dependencies
              const dependencyOutputs: Record<string, string> = {};
              for (const depId of node.dependsOn) {
                if (outputsByNodeId[depId] !== undefined) {
                  dependencyOutputs[depId] = outputsByNodeId[depId];
                }
              }

              return ctx.serviceClient(dagWorker).execute({
                nodeId: node.id,
                task: node.task,
                wave: waveIndex,
                dependsOn: node.dependsOn,
                handler: node.handler,
                config: node.config,
                dependencyOutputs,
                simulatedMs: node.simulatedMs,
                workflowId: ctx.key,
                pipeline: pipelineName,
              });
            }),
          );

          // Store outputs for downstream consumption
          for (const result of results) {
            outputsByNodeId[result.nodeId] = result.output;
          }

          const collected = await ctx.run(`wave-${waveIndex}-collect`, () => ({
            waveIndex,
            nodeIds,
            results: [...results].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
          }));

          waveResults.push(collected);
          completionOrder.push(
            ...collected.results.map((result) => result.nodeId),
          );

          // OTEL: wave completed
          await ctx.run(`otel-wave-${waveIndex}-completed`, async () => {
            await emitOtel({
              action: "dag.wave.completed",
              metadata: {
                workflowId: ctx.key,
                pipeline: pipelineName,
                waveIndex,
                nodeIds,
                durationMs: Date.now() - waveStartMs,
                resultCount: results.length,
                handlerDurations: results.map((r) => ({
                  nodeId: r.nodeId,
                  handler: r.handler,
                  durationMs: r.durationMs,
                })),
              },
            });
            return true;
          });
        }
      } catch (err) {
        // Gateway: notify on execution failure
        const errorMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - workflowStartMs;
        await ctx.run("gateway-notify-error", async () => {
          await notifyGateway({
            message: [
              `❌ DAG "${pipelineName}" failed after ${Math.round(durationMs / 1000)}s`,
              `   Completed ${completionOrder.length}/${nodes.length} nodes`,
              `   Error: ${errorMsg.slice(0, 300)}`,
            ].join("\n"),
            priority: "high",
            source: "restate/dag",
            context: {
              workflowId: ctx.key,
              pipeline: pipelineName,
              phase: "execution",
              completedNodes: completionOrder,
              failedAtWave: waveResults.length,
              durationMs,
            },
          });
          return true;
        });

        // OTEL: workflow failed
        await ctx.run("otel-workflow-failed", async () => {
          await emitOtel({
            level: "error",
            action: "dag.workflow.failed",
            success: false,
            error: errorMsg,
            metadata: {
              workflowId: ctx.key,
              pipeline: pipelineName,
              completedNodes: completionOrder.length,
              totalNodes: nodes.length,
              durationMs,
            },
          });
          return true;
        });

        throw err;
      }

      const completedAt = await ctx.run("complete-run", () =>
        new Date().toISOString(),
      );
      const totalDurationMs = Date.now() - workflowStartMs;

      // OTEL: workflow completed
      await ctx.run("otel-workflow-completed", async () => {
        await emitOtel({
          action: "dag.workflow.completed",
          metadata: {
            workflowId: ctx.key,
            requestId: initialized.requestId,
            pipeline: pipelineName,
            nodeCount: nodes.length,
            waveCount: waves.length,
            durationMs: totalDurationMs,
            completionOrder,
            handlerBreakdown: Object.fromEntries(
              nodes.map((n) => [n.id, n.handler]),
            ),
            waveDurations: waveResults.map((w) => ({
              wave: w.waveIndex,
              nodes: w.nodeIds.length,
            })),
          },
        });
        return true;
      });

      // Gateway: notify on success
      await ctx.run("gateway-notify-complete", async () => {
        // Find the synthesis/infer output for a meaningful summary
        const synthOutput = waveResults
          .flatMap((w) => w.results)
          .find((r) => r.handler === "infer");
        const summary = synthOutput
          ? previewOutput(synthOutput.output)
          : `${nodes.length} nodes in ${waves.length} waves`;

        await notifyGateway({
          message: [
            `✅ DAG "${pipelineName}" completed in ${Math.round(totalDurationMs / 1000)}s`,
            `   ${nodes.length} nodes, ${waves.length} waves`,
            synthOutput ? `\n${summary.slice(0, 500)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          priority: "normal",
          source: "restate/dag",
          context: {
            workflowId: ctx.key,
            pipeline: pipelineName,
            nodeCount: nodes.length,
            waveCount: waves.length,
            durationMs: totalDurationMs,
            completionOrder,
          },
        });
        return true;
      });

      // Publish DAG completion event for pi session extensions
      await ctx.run("publish-dag-completed", async () => {
        try {
          const Redis = (await import("ioredis")).default;
          const host = (process.env.REDIS_HOST ?? "localhost") === "localhost" ? "127.0.0.1" : (process.env.REDIS_HOST ?? "redis");
          const port = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);
          const pub = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
          pub.on("error", () => {});
          await pub.connect();
          await pub.publish("joelclaw:dag:completed", JSON.stringify({
            workflowId: ctx.key,
            pipeline: pipelineName,
            success: true,
            durationMs: totalDurationMs,
            nodeCount: nodes.length,
            waveCount: waves.length,
            completionOrder,
            summary: `${pipelineName}: ${nodes.length} nodes in ${waves.length} waves, ${Math.round(totalDurationMs / 1000)}s`,
          }));
          pub.disconnect();
        } catch { /* non-fatal */ }
        return true;
      });

      return {
        workflowId: ctx.key,
        requestId: initialized.requestId,
        pipeline: pipelineName,
        nodeCount: nodes.length,
        waveCount: waves.length,
        startedAt: initialized.startedAt,
        completedAt,
        durationMs: totalDurationMs,
        completionOrder,
        waves: waveResults,
      };
    },
  },
});
