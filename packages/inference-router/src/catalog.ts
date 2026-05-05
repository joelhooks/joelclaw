import type { InferenceCatalogEntry, InferenceModelId, InferenceProvider, InferenceTask } from "./schema";

export const INFERENCE_POLICY_VERSION = "2026-05-05-codex-policy-v4";

export const MODEL_OPENAI_CODEX_CODEx = "openai-codex/gpt-5.5";
export const MODEL_OPENAI_CODEX_SPARK = "openai-codex/gpt-5.5";
export const MODEL_OPENAI_CODEX_SPARK_LEGACY = "openai-codex/gpt-5.4";

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
  "openai-codex/gpt-5.5": {
    id: "openai-codex/gpt-5.5",
    provider: "openai-codex",
    aliases: [
      "gpt-5.5",
      "gpt-55",
      "gpt-5.5-codex",
      "gpt-5.5-codex-spark",
      "gpt-5-5-codex",
    ],
    description: "OpenAI GPT-5.5 via Codex provider",
    supportedTasks: [
      "summary",
      "digest",
      "default",
      "reasoning",
      "complex",
      "simple",
      "json",
      "classification",
      "vision",
      "rewrite",
    ],
  },
  "openai-codex/gpt-5.4": {
    id: "openai-codex/gpt-5.4",
    provider: "openai-codex",
    aliases: [
      "gpt-5.4",
      "gpt-54",
      "gpt-5.4-codex",
      "gpt-5.4-codex-spark",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2-codex-spark",
      "openai-codex",
      "openai-codex-spark",
      "codex",
      "codex-spark",
      "openai-legacy-codex-spark",
      "codex-spark-legacy",
      "gpt-5-4-codex",
      "gpt-5-3-codex",
    ],
    description: "OpenAI GPT-5.4 via Codex provider",
    supportedTasks: [
      "summary",
      "digest",
      "default",
      "reasoning",
      "complex",
      "simple",
      "json",
      "classification",
      "vision",
      "rewrite",
    ],
  },
  "openai-codex/gpt-5.4-mini": {
    id: "openai-codex/gpt-5.4-mini",
    provider: "openai-codex",
    aliases: [
      "gpt-5.4-mini",
      "gpt-54-mini",
      "gpt-5.4-codex-mini",
      "gpt-5-4-mini",
      "gpt-5-4-codex-mini",
      "codex-mini",
      "openai-codex-mini",
      "mini",
    ],
    description: "OpenAI GPT-5.4 Mini via Codex provider",
    supportedTasks: [
      "simple",
      "classification",
      "json",
      "rewrite",
      "default",
      "summary",
      "digest",
      "reasoning",
      "complex",
    ],
  },
  "openai/gpt-5.2": {
    id: "openai/gpt-5.2",
    provider: "openai",
    aliases: ["gpt-5.2", "openai"],
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
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
  ],
  classification: [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
  ],
  summary: [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
  ],
  digest: [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
  ],
  vision: [
    "openai-codex/gpt-5.5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
  ],
  reasoning: [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
  ],
  json: [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
  ],
  default: [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
  ],
  complex: [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
  ],
  rewrite: [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
  ],
};

export const GATEWAY_ALLOWED_MODELS = [
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.5-codex-spark",
  "gpt-5.4",
  "gpt-5.4-codex",
  "gpt-5.4-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.4-codex-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2-codex-spark",
  "gpt-5.2",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export const GATEWAY_MODEL_TO_PROVIDER: Record<(typeof GATEWAY_ALLOWED_MODELS)[number], InferenceProvider> = {
  "gpt-5.5": "openai-codex",
  "gpt-5.5-codex": "openai-codex",
  "gpt-5.5-codex-spark": "openai-codex",
  "gpt-5.4": "openai-codex",
  "gpt-5.4-codex": "openai-codex",
  "gpt-5.4-codex-spark": "openai-codex",
  "gpt-5.4-mini": "openai-codex",
  "gpt-5.4-codex-mini": "openai-codex",
  "gpt-5.3-codex": "openai-codex",
  "gpt-5.3-codex-spark": "openai-codex",
  "gpt-5.2-codex": "openai-codex",
  "gpt-5.2-codex-spark": "openai-codex",
  "gpt-5.2": "openai",
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-4-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
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

export function normalizeModel(input: string, allowLegacy = true): InferenceModelId | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;
  const canonical = MODEL_ALIAS_TO_CANONICAL[trimmed];
  if (canonical) return canonical;
  if (allowLegacy && trimmed in GATEWAY_MODEL_TO_PROVIDER) {
    const provider = GATEWAY_MODEL_TO_PROVIDER[trimmed as (typeof GATEWAY_ALLOWED_MODELS)[number]];
    const fallback = `${provider}/${trimmed}`;
    const canonicalFallback = MODEL_ALIAS_TO_CANONICAL[fallback.toLowerCase()];
    return canonicalFallback;
  }
  return undefined;
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
  if (model.startsWith("openai-codex") || model.startsWith("gpt-") || model.includes("codex")) {
    return "openai-codex";
  }
  return model.startsWith("openai") ? "openai" : "anthropic";
}

export function isKnownModel(model: string): model is InferenceModelId {
  return normalizeModel(model) !== undefined;
}

export function listCanonicalModels(): InferenceModelId[] {
  return [...CANONICAL_MODELS];
}
