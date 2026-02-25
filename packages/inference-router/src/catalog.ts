import type { InferenceCatalogEntry, InferenceModelId, InferenceProvider, InferenceTask } from "./schema";

export const INFERENCE_POLICY_VERSION = "2026-02-25-router-v2";

export const MODEL_OPENAI_CODEX_CODEx = "openai-codex/gpt-5.3-codex";
export const MODEL_OPENAI_CODEX_SPARK = "openai-codex/gpt-5.3-codex-spark";
export const MODEL_OPENAI_CODEX_SPARK_LEGACY = "openai-codex/gpt-5.2-codex-spark";

export const MODEL_CATALOG: Record<string, InferenceCatalogEntry> = {
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    aliases: ["claude-opus-4-6", "claude-opus", "opus"],
    description: "Anthropic Claude Opus 4.6",
    supportedTasks: ["summary", "digest", "default", "reasoning", "complex", "simple", "json", "classification"],
  },
  "anthropic/claude-sonnet-4-6": {
    id: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    aliases: ["claude-sonnet-4-6", "claude-sonnet-4", "sonnet"],
    description: "Anthropic Claude Sonnet 4.6",
    supportedTasks: ["summary", "digest", "default", "simple", "classification", "vision", "reasoning", "complex"],
  },
  "anthropic/claude-sonnet-4-5": {
    id: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    aliases: ["claude-sonnet-4-5", "claude-sonnet-old", "sonnet-old"],
    description: "Anthropic Claude Sonnet 4.5",
    supportedTasks: ["classification", "simple", "reasoning", "default"],
  },
  "anthropic/claude-haiku-4-5": {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    aliases: ["claude-haiku-4-5", "claude-haiku", "haiku", "claude-3-5-haiku-latest", "haiku-latest"],
    description: "Anthropic Claude Haiku 4.5",
    supportedTasks: ["simple", "classification", "json", "default", "rewrite", "summary", "vision"],
  },
  "openai-codex/gpt-5.3-codex": {
    id: "openai-codex/gpt-5.3-codex",
    provider: "openai-codex",
    aliases: ["gpt-5.3-codex", "openai-codex", "codex", "gpt-5-3-codex"],
    description: "OpenAI Codex (complex reasoning)",
    supportedTasks: ["reasoning", "default", "json", "summary"],
  },
  "openai-codex/gpt-5.2-codex-spark": {
    id: "openai-codex/gpt-5.2-codex-spark",
    provider: "openai-codex",
    aliases: ["gpt-5.2-codex-spark", "openai-legacy-codex-spark", "codex-spark-legacy", "gpt-5.2-codex"],
    description: "OpenAI Codex Spark (legacy alias)",
    supportedTasks: ["simple", "json", "summary", "classification", "default", "reasoning"],
  },
  "openai-codex/gpt-5.3-codex-spark": {
    id: "openai-codex/gpt-5.3-codex-spark",
    provider: "openai-codex",
    aliases: ["gpt-5.3-codex-spark", "codex-spark", "openai-codex-spark"],
    description: "OpenAI Codex Spark",
    supportedTasks: ["simple", "json", "summary", "classification", "default", "reasoning"],
  },
  "openai/gpt-5.2": {
    id: "openai/gpt-5.2",
    provider: "openai",
    aliases: ["gpt-5.2", "openai", "gpt-5.2-codex"],
    description: "OpenAI GPT-5.2",
    supportedTasks: ["reasoning", "default", "summary", "classification", "json"],
  },
  "openai/o4-mini": {
    id: "openai/o4-mini",
    provider: "openai",
    aliases: ["o4-mini", "openai-o4-mini", "mini-reasoning"],
    description: "OpenAI O4 mini",
    supportedTasks: ["reasoning", "default", "summary", "simple", "complex"],
  },
  "openai/o3": {
    id: "openai/o3",
    provider: "openai",
    aliases: ["o3", "openai-o3", "reasoning"],
    description: "OpenAI O3",
    supportedTasks: ["reasoning", "default", "summary", "complex"],
  },
};

export const DEFAULT_TASK_TO_MODELS: Record<InferenceTask, InferenceModelId[]> = {
  simple: [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-5",
    "openai-codex/gpt-5.3-codex-spark",
  ],
  classification: [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.3-codex-spark",
  ],
  summary: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "openai/o4-mini",
  ],
  digest: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "openai-codex/gpt-5.3-codex",
  ],
  vision: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-haiku-4-5",
  ],
  reasoning: [
    "openai/o4-mini",
    "openai/o3",
    "openai-codex/gpt-5.3-codex-spark",
    "anthropic/claude-opus-4-6",
  ],
  json: [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.3-codex-spark",
  ],
  default: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "openai-codex/gpt-5.3-codex",
  ],
};

export const GATEWAY_ALLOWED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
] as const;

export const GATEWAY_MODEL_TO_PROVIDER: Record<(typeof GATEWAY_ALLOWED_MODELS)[number], InferenceProvider> = {
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-4-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-5.3-codex-spark": "openai-codex",
  "gpt-5.2-codex-spark": "openai-codex",
  "gpt-5.3-codex": "openai-codex",
  "gpt-5.2": "openai",
};

export const CANONICAL_MODELS = Object.keys(MODEL_CATALOG) as InferenceModelId[];

export const ALLOWED_MODELS = CANONICAL_MODELS;

function toAliasMap() {
  const map: Record<string, InferenceModelId> = {};
  for (const [modelId, entry] of Object.entries(MODEL_CATALOG)) {
    const canonical = modelId as InferenceModelId;

    map[canonical.toLowerCase()] = canonical;

    for (const alias of entry.aliases) {
      map[alias.toLowerCase()] = canonical;
      map[`${entry.id.split("/")[0]}/${alias}`.toLowerCase()] = canonical;
    }

    const [provider, providerSuffix] = canonical.split("/") as [InferenceProvider, string];
    map[`${provider}/${providerSuffix}`.toLowerCase()] = canonical;
    map[providerSuffix.toLowerCase()] = canonical;
    const maybeLegacy = canonical.replace("anthropic/", "").toLowerCase();
    if (!(maybeLegacy in map)) {
      map[maybeLegacy] = canonical;
    }
  }
  return map;
}

export const MODEL_ALIAS_TO_CANONICAL: Record<string, InferenceModelId> = toAliasMap();

export function normalizeModel(input: string, allowLegacy = true): InferenceModelId | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const canonical = MODEL_ALIAS_TO_CANONICAL[trimmed];
  if (canonical) return canonical;
  if (allowLegacy && trimmed in GATEWAY_MODEL_TO_PROVIDER) {
    const provider = GATEWAY_MODEL_TO_PROVIDER[trimmed as (typeof GATEWAY_ALLOWED_MODELS)[number]];
    const fallback = `${provider}/${trimmed}`;
    const canonicalFallback = MODEL_ALIAS_TO_CANONICAL[fallback.toLowerCase()];
    return canonicalFallback ?? null;
  }
  return null;
}

export function inferProviderFromModel(model: string): InferenceProvider {
  if (model.includes("/")) {
    const provider = model.split("/")[0];
    if (provider === "anthropic" || provider === "openai" || provider === "openai-codex") {
      return provider;
    }
  }
  const normalized = normalizeModel(model);
  if (normalized) return MODEL_CATALOG[normalized]!.provider;
  return model.startsWith("openai") ? "openai" : "anthropic";
}

export function isKnownModel(model: string): model is InferenceModelId {
  return normalizeModel(model) !== null;
}

export function listCanonicalModels(): InferenceModelId[] {
  return [...CANONICAL_MODELS];
}
