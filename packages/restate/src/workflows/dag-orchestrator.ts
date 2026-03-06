import * as restate from "@restatedev/restate-sdk";

const MAX_SIMULATED_MS = 30_000;

export interface DagNodeInput {
  id: string;
  task: string;
  dependsOn?: string[];
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
  simulatedMs?: number;
}

export interface DagWorkerResult {
  nodeId: string;
  task: string;
  wave: number;
  dependsOn: string[];
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

interface DagNodeNormalized {
  id: string;
  task: string;
  dependsOn: string[];
  simulatedMs: number;
}

const normalizeNode = (node: DagNodeInput): DagNodeNormalized => {
  const id = node.id.trim();
  const task = node.task.trim();

  if (!id) {
    throw new Error("DAG node id is required");
  }

  if (!task) {
    throw new Error(`DAG node ${id} requires a non-empty task`);
  }

  const dependsOn = Array.from(new Set((node.dependsOn ?? []).map((dep) => dep.trim()).filter(Boolean))).sort();
  const simulatedMs = Math.max(0, Math.min(node.simulatedMs ?? 0, MAX_SIMULATED_MS));

  return {
    id,
    task,
    dependsOn,
    simulatedMs,
  };
};

const validateAndNormalize = (nodes: DagNodeInput[]): DagNodeNormalized[] => {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("DAG requires at least one node");
  }

  const normalized = nodes.map(normalizeNode);
  const seen = new Set<string>();

  for (const node of normalized) {
    if (seen.has(node.id)) {
      throw new Error(`Duplicate DAG node id: ${node.id}`);
    }

    seen.add(node.id);
  }

  for (const node of normalized) {
    if (node.dependsOn.includes(node.id)) {
      throw new Error(`Node ${node.id} cannot depend on itself`);
    }

    for (const dep of node.dependsOn) {
      if (!seen.has(dep)) {
        throw new Error(`Node ${node.id} depends on missing node ${dep}`);
      }
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

    for (const readyId of ready) {
      remaining.delete(readyId);
    }

    for (const deps of dependencies.values()) {
      for (const readyId of ready) {
        deps.delete(readyId);
      }
    }
  }

  return waves;
};

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
        wave: input.wave,
        dependsOn: input.dependsOn,
      }));

      if (input.simulatedMs && input.simulatedMs > 0) {
        await ctx.sleep({ milliseconds: input.simulatedMs });
      }

      const output = await ctx.run("execute-task", () => `completed:${input.nodeId}:${input.task}`);
      const completedAt = await ctx.run("mark-complete", () => new Date().toISOString());

      return {
        nodeId: input.nodeId,
        task: input.task,
        wave: input.wave,
        dependsOn: input.dependsOn,
        output,
        startedAt,
        completedAt,
      };
    },
  },
});

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

      const nodes = await ctx.run("validate-request", () => validateAndNormalize(request.nodes));
      const waves = await ctx.run("build-waves", () => buildExecutionWaves(nodes));
      const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

      const waveResults: DagWaveResult[] = [];
      const completionOrder: string[] = [];

      for (const [waveIndex, nodeIds] of waves.entries()) {
        await ctx.run(`wave-${waveIndex}-dispatch`, () => ({ waveIndex, nodeIds }));

        const results = await Promise.all(
          nodeIds.map((nodeId) => {
            const node = nodeById.get(nodeId);
            if (!node) {
              throw new Error(`Missing node definition for ${nodeId}`);
            }

            return ctx.serviceClient(dagWorker).execute({
              nodeId: node.id,
              task: node.task,
              wave: waveIndex,
              dependsOn: node.dependsOn,
              simulatedMs: node.simulatedMs,
            });
          }),
        );

        const collected = await ctx.run(`wave-${waveIndex}-collect`, () => ({
          waveIndex,
          nodeIds,
          results: [...results].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
        }));

        waveResults.push(collected);
        completionOrder.push(...collected.results.map((result) => result.nodeId));
      }

      const completedAt = await ctx.run("complete-run", () => new Date().toISOString());

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
