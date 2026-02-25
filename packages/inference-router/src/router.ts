import {
  type InferenceCatalogEntry,
  type InferenceModelId,
  type InferencePlan,
  type InferencePlanInput,
  type InferencePolicy,
  type InferenceRouteAttempt,
  type InferenceTask,
  INFERENCE_EVENT_NAMES,
} from "./schema";
import {
  ALLOWED_MODELS,
  CANONICAL_MODELS,
  DEFAULT_TASK_TO_MODELS,
  GATEWAY_ALLOWED_MODELS,
  MODEL_CATALOG,
  INFERENCE_POLICY_VERSION,
  normalizeModel,
} from "./catalog";

const DEFAULT_POLICY: InferencePolicy = {
  version: INFERENCE_POLICY_VERSION,
  strict: false,
  allowLegacy: true,
  maxFallbackAttempts: 3,
  defaults: DEFAULT_TASK_TO_MODELS,
};

function normalizeTask(task: string | undefined, strict = false): InferenceTask {
  const normalized = (task ?? "default").trim().toLowerCase();
  if (normalized === "simple") return "simple";
  if (normalized === "classification") return "classification";
  if (normalized === "summary") return "summary";
  if (normalized === "digest") return "digest";
  if (normalized === "vision") return "vision";
  if (normalized === "reasoning" || normalized === "complex" || normalized === "analysis") return "reasoning";
  if (normalized === "rewrite") return "rewrite";
  if (normalized === "json") return "json";
  if (normalized === "default") return "default";

  if (strict) {
    throw Object.assign(new Error(`inference-router: unknown task "${task}"`), {
      code: "unknown_task",
    } as const);
  }
  return "default";
}

function uniqueAttempts(attempts: InferenceRouteAttempt[]): InferenceRouteAttempt[] {
  const seen = new Set<string>();
  const normalized: InferenceRouteAttempt[] = [];
  for (const attempt of attempts) {
    const key = attempt.model;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...attempt, attempt: normalized.length });
  }
  return normalized;
}

export function buildPolicy(overrides?: Partial<InferencePolicy>): InferencePolicy {
  const merged: InferencePolicy = {
    ...DEFAULT_POLICY,
    ...overrides,
    defaults: {
      ...DEFAULT_POLICY.defaults,
      ...(overrides?.defaults ?? {}),
    },
  };

  if (merged.maxFallbackAttempts < 1) merged.maxFallbackAttempts = 1;
  return merged;
}

export function buildInferenceRoute(input: InferencePlanInput, policy = DEFAULT_POLICY): InferencePlan {
  const resolvedPolicy = buildPolicy({
    ...policy,
    strict: input.strict ?? policy.strict,
    allowLegacy: input.allowLegacy ?? policy.allowLegacy,
    maxFallbackAttempts: input.maxAttempts ?? policy.maxFallbackAttempts,
    version: input.policyVersion ?? policy.version,
  });
  const normalizedTask = normalizeTask(input.task, resolvedPolicy.strict);
  const normalizedModel = input.model
    ? normalizeModel(input.model, resolvedPolicy.allowLegacy)
    : undefined;

  if (input.strict && input.model && !normalizedModel) {
    throw new Error(`inference-router: unknown model ${input.model}`);
  }

  const chain: InferenceRouteAttempt[] = [];
  let attempt = 0;

  if (normalizedModel) {
    const entry = MODEL_CATALOG[normalizedModel];
    if (entry) {
      chain.push({
        model: normalizedModel,
        provider: entry.provider,
        reason: "requested",
        attempt,
      });
      attempt += 1;
    }
  } else {
    const configuredModels = resolvedPolicy.defaults[normalizedTask] ?? resolvedPolicy.defaults.default;
    if (input.provider) {
      for (const model of configuredModels) {
        const entry = MODEL_CATALOG[model];
        if (!entry || entry.provider !== input.provider) continue;
        chain.push({
          model,
          provider: entry.provider,
          reason: "policy",
          attempt,
        });
        attempt += 1;
      }
    } else {
      for (const model of configuredModels) {
        const entry = MODEL_CATALOG[model];
        if (!entry) continue;
        chain.push({
          model,
          provider: entry.provider,
          reason: "policy",
          attempt,
        });
        attempt += 1;
      }
    }
  }

  const fallbackCandidate: InferenceModelId[] = [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.3-codex-spark",
  ];

  for (const model of fallbackCandidate) {
    const catalogEntry = MODEL_CATALOG[model];
    if (!catalogEntry) continue;

    const base = chain.find((entry) => entry.model === model);
    if (!base) {
      chain.push({ model, provider: catalogEntry.provider, reason: "fallback", attempt });
      attempt += 1;
    }
  }

  const maxAttempts = Math.max(1, Math.min(
    input.maxAttempts ?? resolvedPolicy.maxFallbackAttempts,
    resolvedPolicy.maxFallbackAttempts,
    chain.length,
  ));

  const deduped = uniqueAttempts(chain)
    .slice(0, maxAttempts)
    .map((item, idx) => ({ ...item, attempt: idx }));

  if (deduped.length === 0) {
    throw new Error("inference-router: no model candidates available");
  }

  return {
    policyVersion: resolvedPolicy.version,
    requestedModel: normalizedModel,
    normalizedTask,
    attempts: deduped,
  };
}

export function isAllowedCatalogModel(value: string): value is InferenceModelId {
  return CANONICAL_MODELS.includes(value as InferenceModelId);
}

export function getCatalogModel(value: string): InferenceCatalogEntry | undefined {
  return MODEL_CATALOG[normalizeModel(value) ?? value];
}

export function getCatalogModels(): InferenceModelId[] {
  return ALLOWED_MODELS;
}

export function getGatewayModels(): readonly string[] {
  return [...GATEWAY_ALLOWED_MODELS];
}

export { INFERENCE_EVENT_NAMES };
