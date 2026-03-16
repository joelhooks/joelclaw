import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WorkloadStage } from "./workload-types";
import { dedupe, expandHome } from "./workload-utils";

export type ExplicitStage = {
  id: string;
  name: string;
  executionMode?: "manual" | "codex" | "sandbox" | "microvm" | "inline";
  dependsOn?: string[];
  acceptance: string[];
  files?: string[];
  artifacts?: string[];
  owner?: string;
  tool?: "pi" | "codex" | "claude";
  timeout?: number;
  phase?: string;
  notes?: string;
};

export type ParsedStagesResult = {
  stages: ExplicitStage[];
  dagInfo: DagInfo;
  warnings: string[];
};

export type DagInfo = {
  isLinear: boolean;
  hasParallel: boolean;
  topologicalOrder: string[];
  criticalPath: string[];
  phases: Map<string, string[]>;
  inferredShape: "serial" | "parallel" | "chained";
};

const EXPLICIT_STAGE_EXECUTION_MODES = [
  "manual",
  "codex",
  "sandbox",
  "microvm",
  "inline",
] as const;

const EXPLICIT_STAGE_TOOLS = ["pi", "codex", "claude"] as const;

const EXECUTION_MODE_MAP: Record<
  NonNullable<ExplicitStage["executionMode"]>,
  WorkloadStage["mode"]
> = {
  manual: "inline",
  codex: "durable",
  sandbox: "sandbox",
  microvm: "durable",
  inline: "inline",
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeNonEmptyString = (
  value: unknown,
  field: string,
  index: number,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Stage ${index + 1} is missing required field "${field}" or it is empty`,
    );
  }

  return value.trim();
};

const normalizeOptionalString = (
  value: unknown,
  field: string,
  index: number,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Stage ${index + 1} field "${field}" must be a non-empty string when provided`,
    );
  }

  return value.trim();
};

const normalizeStringArray = (
  value: unknown,
  field: string,
  index: number,
  { required = false, allowEmpty = true }: { required?: boolean; allowEmpty?: boolean } = {},
): string[] | undefined => {
  if (value === undefined) {
    if (required) {
      throw new Error(`Stage ${index + 1} is missing required field "${field}"`);
    }

    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Stage ${index + 1} field "${field}" must be an array of strings`);
  }

  const normalized = dedupe(
    value.map((item, itemIndex) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new Error(
          `Stage ${index + 1} field "${field}" item ${itemIndex + 1} must be a non-empty string`,
        );
      }

      return item.trim();
    }),
  );

  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`Stage ${index + 1} field "${field}" must not be empty`);
  }

  return normalized;
};

const normalizeEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  index: number,
): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Stage ${index + 1} field "${field}" must be a string`);
  }

  const normalized = value.trim() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(
      `Stage ${index + 1} field "${field}" must be one of: ${allowed.join(", ")}`,
    );
  }

  return normalized;
};

const normalizeTimeout = (
  value: unknown,
  index: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`Stage ${index + 1} field "timeout" must be a positive number`);
  }

  return value;
};

const buildExecutionWaves = (
  stageIds: readonly string[],
  inDegree: Map<string, number>,
  adjacency: Map<string, string[]>,
  orderIndex: Map<string, number>,
): string[][] => {
  const remaining = new Map(inDegree);
  const waves: string[][] = [];

  while (true) {
    const ready = stageIds
      .filter((stageId) => (remaining.get(stageId) ?? 0) === 0)
      .filter((stageId) => !waves.some((wave) => wave.includes(stageId)))
      .sort(
        (left, right) =>
          (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
      );

    if (ready.length === 0) break;

    waves.push(ready);

    for (const stageId of ready) {
      remaining.set(stageId, -1);
      for (const dependent of adjacency.get(stageId) ?? []) {
        remaining.set(dependent, (remaining.get(dependent) ?? 0) - 1);
      }
    }
  }

  return waves;
};

const findCycle = (
  remainingIds: readonly string[],
  dependencyMap: Map<string, string[]>,
): string[] => {
  const remaining = new Set(remainingIds);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (stageId: string): string[] | undefined => {
    visited.add(stageId);
    visiting.add(stageId);
    stack.push(stageId);

    for (const dependencyId of dependencyMap.get(stageId) ?? []) {
      if (!remaining.has(dependencyId)) continue;

      if (visiting.has(dependencyId)) {
        const cycleStart = stack.indexOf(dependencyId);
        return [...stack.slice(cycleStart), dependencyId];
      }

      if (!visited.has(dependencyId)) {
        const cycle = visit(dependencyId);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    visiting.delete(stageId);
    return undefined;
  };

  for (const stageId of remainingIds) {
    if (visited.has(stageId)) continue;
    const cycle = visit(stageId);
    if (cycle) return cycle;
  }

  return [...remainingIds];
};

export const toSerializableDagInfo = (dagInfo: DagInfo) => ({
  ...dagInfo,
  phases: Object.fromEntries(dagInfo.phases),
});

export const parseStagesFile = (path: string): ExplicitStage[] => {
  const absolutePath = resolve(expandHome(path));
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read explicit stages file ${absolutePath}: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Explicit stages file must be a JSON array: ${absolutePath}`);
  }

  if (parsed.length === 0) {
    throw new Error(`Explicit stages file must contain at least one stage: ${absolutePath}`);
  }

  const seenIds = new Set<string>();

  return parsed.map((entry, index) => {
    const object = asObject(entry);
    if (!object) {
      throw new Error(`Stage ${index + 1} must be a JSON object`);
    }

    const id = normalizeNonEmptyString(object.id, "id", index);
    if (seenIds.has(id)) {
      throw new Error(`Explicit stages file contains duplicate stage id "${id}"`);
    }
    seenIds.add(id);

    const name = normalizeNonEmptyString(object.name, "name", index);
    const acceptance = normalizeStringArray(object.acceptance, "acceptance", index, {
      required: true,
      allowEmpty: false,
    })!;
    const executionMode = normalizeEnum(
      object.executionMode,
      EXPLICIT_STAGE_EXECUTION_MODES,
      "executionMode",
      index,
    );
    const dependsOn = normalizeStringArray(object.dependsOn, "dependsOn", index);
    const files = normalizeStringArray(object.files, "files", index);
    const artifacts = normalizeStringArray(object.artifacts, "artifacts", index);
    const owner = normalizeOptionalString(object.owner, "owner", index);
    const tool = normalizeEnum(object.tool, EXPLICIT_STAGE_TOOLS, "tool", index);
    const timeout = normalizeTimeout(object.timeout, index);
    const phase = normalizeOptionalString(object.phase, "phase", index);
    const notes = normalizeOptionalString(object.notes, "notes", index);

    return {
      id,
      name,
      acceptance,
      ...(executionMode ? { executionMode } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(files ? { files } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(owner ? { owner } : {}),
      ...(tool ? { tool } : {}),
      ...(timeout ? { timeout } : {}),
      ...(phase ? { phase } : {}),
      ...(notes ? { notes } : {}),
    };
  });
};

export const validateStageDag = (stages: ExplicitStage[]): DagInfo => {
  const stageIds = stages.map((stage) => stage.id);
  const stageIdSet = new Set(stageIds);
  const orderIndex = new Map(stageIds.map((stageId, index) => [stageId, index]));
  const adjacency = new Map<string, string[]>();
  const dependencyMap = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const stage of stages) {
    adjacency.set(stage.id, []);
    dependencyMap.set(stage.id, dedupe(stage.dependsOn ?? []));
    inDegree.set(stage.id, 0);
    outDegree.set(stage.id, 0);
  }

  for (const stage of stages) {
    for (const dependencyId of dependencyMap.get(stage.id) ?? []) {
      if (!stageIdSet.has(dependencyId)) {
        throw new Error(
          `Stage "${stage.id}" depends on unknown stage "${dependencyId}"`,
        );
      }

      if (dependencyId === stage.id) {
        throw new Error(`Stage "${stage.id}" cannot depend on itself`);
      }

      adjacency.get(dependencyId)?.push(stage.id);
      inDegree.set(stage.id, (inDegree.get(stage.id) ?? 0) + 1);
      outDegree.set(dependencyId, (outDegree.get(dependencyId) ?? 0) + 1);
    }
  }

  const queue = stageIds
    .filter((stageId) => (inDegree.get(stageId) ?? 0) === 0)
    .sort(
      (left, right) =>
        (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
  const remainingInDegree = new Map(inDegree);
  const topologicalOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);

    for (const dependent of adjacency.get(current) ?? []) {
      const nextDegree = (remainingInDegree.get(dependent) ?? 0) - 1;
      remainingInDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
        queue.sort(
          (left, right) =>
            (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
        );
      }
    }
  }

  if (topologicalOrder.length !== stages.length) {
    const remainingIds = stageIds.filter(
      (stageId) => !topologicalOrder.includes(stageId),
    );
    const cycle = findCycle(remainingIds, dependencyMap);
    throw new Error(`Cycle detected in stage DAG: ${cycle.join(" -> ")}`);
  }

  const longestDistance = new Map<string, number>();
  const predecessor = new Map<string, string | undefined>();

  for (const stageId of topologicalOrder) {
    const dependencies = dependencyMap.get(stageId) ?? [];

    if (dependencies.length === 0) {
      longestDistance.set(stageId, 1);
      predecessor.set(stageId, undefined);
      continue;
    }

    let bestDistance = 0;
    let bestDependency: string | undefined;

    for (const dependencyId of dependencies) {
      const dependencyDistance = longestDistance.get(dependencyId) ?? 1;
      if (dependencyDistance > bestDistance) {
        bestDistance = dependencyDistance;
        bestDependency = dependencyId;
      }
    }

    longestDistance.set(stageId, bestDistance + 1);
    predecessor.set(stageId, bestDependency);
  }

  const criticalPathEnd =
    topologicalOrder.reduce((best, stageId) => {
      if (!best) return stageId;
      return (longestDistance.get(stageId) ?? 0) >
        (longestDistance.get(best) ?? 0)
        ? stageId
        : best;
    }, topologicalOrder[0]) ?? "";

  const criticalPath: string[] = [];
  let cursor: string | undefined = criticalPathEnd;
  while (cursor) {
    criticalPath.unshift(cursor);
    cursor = predecessor.get(cursor);
  }

  const phases = new Map<string, string[]>();
  for (const stage of stages) {
    if (!stage.phase) continue;
    const current = phases.get(stage.phase) ?? [];
    current.push(stage.id);
    phases.set(stage.phase, current);
  }

  const waves = buildExecutionWaves(stageIds, inDegree, adjacency, orderIndex);
  const hasParallel = waves.some((wave) => wave.length > 1);
  const rootCount = stageIds.filter((stageId) => (inDegree.get(stageId) ?? 0) === 0).length;
  const sinkCount = stageIds.filter((stageId) => (outDegree.get(stageId) ?? 0) === 0).length;
  const isLinear =
    stages.length <= 1 ||
    (rootCount === 1 &&
      sinkCount === 1 &&
      stageIds.every((stageId) => {
        const stageInDegree = inDegree.get(stageId) ?? 0;
        const stageOutDegree = outDegree.get(stageId) ?? 0;

        return stageInDegree <= 1 && stageOutDegree <= 1;
      }));

  const inferredShape = isLinear
    ? "serial"
    : hasParallel && waves.length <= 3
      ? "parallel"
      : "chained";

  return {
    isLinear,
    hasParallel,
    topologicalOrder,
    criticalPath,
    phases,
    inferredShape,
  };
};

export const convertToWorkloadStages = (
  stages: ExplicitStage[],
): WorkloadStage[] =>
  stages.map((stage) => {
    const mappedMode = EXECUTION_MODE_MAP[stage.executionMode ?? "inline"];

    return {
      id: stage.id,
      name: stage.name,
      owner:
        stage.owner ??
        (stage.executionMode === "manual" || mappedMode === "inline"
          ? "planner"
          : "worker"),
      mode: mappedMode,
      inputs:
        stage.dependsOn && stage.dependsOn.length > 0
          ? stage.dependsOn.map((dependencyId) => `${dependencyId} outputs`)
          : ["workload request", "acceptance criteria"],
      outputs:
        stage.artifacts && stage.artifacts.length > 0
          ? dedupe(stage.artifacts)
          : [`${stage.id}-complete`],
      ...(stage.files && stage.files.length > 0
        ? { reservedPaths: dedupe(stage.files) }
        : {}),
      verification: dedupe(stage.acceptance),
      stopConditions: [`acceptance criteria for ${stage.id} are not satisfied`],
      ...(stage.dependsOn && stage.dependsOn.length > 0
        ? { dependsOn: dedupe(stage.dependsOn) }
        : {}),
    };
  });

export const parseAndValidateStagesFile = (
  path: string,
): ParsedStagesResult => {
  const stages = parseStagesFile(path);
  const dagInfo = validateStageDag(stages);

  convertToWorkloadStages(stages);

  const warnings = dedupe([
    ...stages
      .filter((stage) => !stage.executionMode)
      .map(
        (stage) =>
          `Stage "${stage.id}" omitted executionMode; converter will default it to inline`,
      ),
    ...stages
      .filter((stage) => !stage.owner)
      .map(
        (stage) =>
          `Stage "${stage.id}" omitted owner; converter will default it based on execution mode`,
      ),
    ...stages
      .filter((stage) => stage.executionMode === "microvm")
      .map(
        (stage) =>
          `Stage "${stage.id}" uses executionMode microvm; the current workload stage mode maps it to durable and runtime-specific microvm handling still needs an explicit execution override`,
      ),
  ]);

  return {
    stages,
    dagInfo,
    warnings,
  };
};
