import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";

// --- Constants ---

const MAX_SIMULATED_MS = 30_000;
const MAX_OUTPUT_BYTES = 16_384;
const HANDLER_TIMEOUT_MS = 120_000;

const PI_PATH_DIRS = [
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.bun/bin`,
  `${process.env.HOME}/.local/share/fnm/aliases/default/bin`,
];

// --- Types ---

export type DagHandler = "noop" | "shell" | "http" | "infer";

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
}

export interface DagWaveResult {
  waveIndex: number;
  nodeIds: string[];
  results: DagWorkerResult[];
}

export interface DagRunResult {
  workflowId: string;
  requestId: string;
  nodeCount: number;
  waveCount: number;
  startedAt: string;
  completedAt: string;
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
  const validHandlers: DagHandler[] = ["noop", "shell", "http", "infer"];
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

// --- Handler implementations ---

async function executeShell(config: Record<string, unknown>): Promise<string> {
  const command = config.command as string | undefined;
  if (!command) throw new Error("shell handler requires config.command");

  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const timer = setTimeout(() => proc.kill(), HANDLER_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return truncate(
    JSON.stringify({
      exitCode,
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
    }),
  );
}

async function executeHttp(config: Record<string, unknown>): Promise<string> {
  const url = config.url as string | undefined;
  if (!url) throw new Error("http handler requires config.url");

  const method = (config.method as string) ?? "GET";
  const headers = (config.headers as Record<string, string>) ?? {};
  const body = config.body as string | undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDLER_TIMEOUT_MS);

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

    const timer = setTimeout(() => proc.kill(), HANDLER_TIMEOUT_MS);
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

    // pi -p outputs JSON with { text, model, usage } — extract text
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

// --- dagWorker service ---

export const dagWorker = restate.service({
  name: "dagWorker",
  handlers: {
    execute: async (
      ctx: restate.Context,
      input: DagWorkerRequest,
    ): Promise<DagWorkerResult> => {
      const startedAt = await ctx.run("mark-start", () => new Date().toISOString());

      await ctx.run("record-input", () => ({
        nodeId: input.nodeId,
        handler: input.handler,
        wave: input.wave,
        dependsOn: input.dependsOn,
      }));

      // noop sleep (outside ctx.run — Restate timer primitive)
      if (input.handler === "noop" && input.simulatedMs && input.simulatedMs > 0) {
        await ctx.sleep({ milliseconds: input.simulatedMs });
      }

      // Execute the handler inside ctx.run for durability
      const output = await ctx.run("execute-task", async () => {
        switch (input.handler) {
          case "shell":
            return executeShell(input.config);
          case "http":
            return executeHttp(input.config);
          case "infer":
            return executeInfer(input.config, input.dependencyOutputs);
          case "noop":
          default:
            return `completed:${input.nodeId}:${input.task}`;
        }
      });

      const completedAt = await ctx.run("mark-complete", () => new Date().toISOString());

      return {
        nodeId: input.nodeId,
        task: input.task,
        wave: input.wave,
        dependsOn: input.dependsOn,
        handler: input.handler,
        output,
        startedAt,
        completedAt,
      };
    },
  },
});

// --- dagOrchestrator workflow ---

export const dagOrchestrator = restate.workflow({
  name: "dagOrchestrator",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      request: DagRunRequest,
    ): Promise<DagRunResult> => {
      const initialized = await ctx.run("init-run", () => ({
        requestId: request.requestId?.trim() || ctx.key,
        startedAt: new Date().toISOString(),
      }));

      const nodes = await ctx.run("validate-request", () =>
        validateAndNormalize(request.nodes),
      );
      const waves = await ctx.run("build-waves", () => buildExecutionWaves(nodes));
      const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

      // Accumulate outputs for dependency passing
      const outputsByNodeId: Record<string, string> = {};
      const waveResults: DagWaveResult[] = [];
      const completionOrder: string[] = [];

      for (const [waveIndex, nodeIds] of waves.entries()) {
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
      }

      const completedAt = await ctx.run("complete-run", () =>
        new Date().toISOString(),
      );

      return {
        workflowId: ctx.key,
        requestId: initialized.requestId,
        nodeCount: nodes.length,
        waveCount: waves.length,
        startedAt: initialized.startedAt,
        completedAt,
        completionOrder,
        waves: waveResults,
      };
    },
  },
});
