import type Redis from "ioredis";

export const GATEWAY_CONFIG_KEY = "joelclaw:gateway:config";

export const ALLOWED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
] as const;

/** Map model IDs to their provider. Models not listed default to "anthropic". */
export const MODEL_PROVIDERS: Record<string, string> = {
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-4-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-5.3-codex-spark": "openai-codex",
  "gpt-5.2": "openai",
};

export const ALLOWED_THINKING_LEVELS = ["none", "low", "medium", "high"] as const;

export type GatewayModel = (typeof ALLOWED_MODELS)[number];
export type GatewayThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];

export type FallbackConfig = {
  fallbackProvider: string;
  fallbackModel: string;
  fallbackTimeoutMs: number;
  fallbackAfterFailures: number;
  recoveryProbeIntervalMs: number;
};

export type GatewayConfig = {
  model: GatewayModel;
  thinkingLevel: GatewayThinkingLevel;
  verbose: boolean;
} & FallbackConfig;

const DEFAULT_MODEL: GatewayModel = "claude-opus-4-6";
const DEFAULT_THINKING_LEVEL: GatewayThinkingLevel = "low";
const DEFAULT_VERBOSE = false;

const DEFAULT_FALLBACK: FallbackConfig = {
  fallbackProvider: "anthropic",
  fallbackModel: "claude-sonnet-4-6",
  fallbackTimeoutMs: 120_000,
  fallbackAfterFailures: 3,
  recoveryProbeIntervalMs: 10 * 60 * 1000,
};

export function providerForModel(modelId: string): string {
  return MODEL_PROVIDERS[modelId] ?? "anthropic";
}

function normalizeModel(raw: unknown): GatewayModel {
  if (typeof raw !== "string") return DEFAULT_MODEL;
  // Strip any provider prefix (anthropic/, openai-codex/)
  const value = raw.replace(/^[a-z-]+\//, "").trim();
  return ALLOWED_MODELS.includes(value as GatewayModel)
    ? (value as GatewayModel)
    : DEFAULT_MODEL;
}

function normalizeThinkingLevel(raw: unknown): GatewayThinkingLevel {
  if (typeof raw !== "string") return DEFAULT_THINKING_LEVEL;
  const value = raw.trim().toLowerCase();
  return ALLOWED_THINKING_LEVELS.includes(value as GatewayThinkingLevel)
    ? (value as GatewayThinkingLevel)
    : DEFAULT_THINKING_LEVEL;
}

function normalizeVerbose(raw: unknown): boolean {
  return raw === true;
}

function normalizePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && raw > 0) return Math.round(raw);
  return fallback;
}

export function defaultGatewayConfig(): GatewayConfig {
  return {
    model: normalizeModel(process.env.PI_MODEL ?? process.env.PI_MODEL_ID),
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    verbose: DEFAULT_VERBOSE,
    ...DEFAULT_FALLBACK,
  };
}

export async function loadGatewayConfig(redis: Redis | undefined): Promise<GatewayConfig> {
  const defaults = defaultGatewayConfig();
  if (!redis) return defaults;

  try {
    const raw = await redis.get(GATEWAY_CONFIG_KEY);
    if (!raw) return defaults;

    const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
    return {
      model: normalizeModel(parsed.model),
      thinkingLevel: normalizeThinkingLevel(parsed.thinkingLevel),
      verbose: normalizeVerbose(parsed.verbose),
      fallbackProvider: typeof parsed.fallbackProvider === "string" ? parsed.fallbackProvider : defaults.fallbackProvider,
      fallbackModel: typeof parsed.fallbackModel === "string" ? parsed.fallbackModel : defaults.fallbackModel,
      fallbackTimeoutMs: normalizePositiveInt(parsed.fallbackTimeoutMs, defaults.fallbackTimeoutMs),
      fallbackAfterFailures: normalizePositiveInt(parsed.fallbackAfterFailures, defaults.fallbackAfterFailures),
      recoveryProbeIntervalMs: normalizePositiveInt(parsed.recoveryProbeIntervalMs, defaults.recoveryProbeIntervalMs),
    };
  } catch {
    return defaults;
  }
}

export async function saveGatewayConfig(redis: Redis, config: GatewayConfig): Promise<void> {
  const normalized: GatewayConfig = {
    model: normalizeModel(config.model),
    thinkingLevel: normalizeThinkingLevel(config.thinkingLevel),
    verbose: normalizeVerbose(config.verbose),
    fallbackProvider: config.fallbackProvider || DEFAULT_FALLBACK.fallbackProvider,
    fallbackModel: config.fallbackModel || DEFAULT_FALLBACK.fallbackModel,
    fallbackTimeoutMs: normalizePositiveInt(config.fallbackTimeoutMs, DEFAULT_FALLBACK.fallbackTimeoutMs),
    fallbackAfterFailures: normalizePositiveInt(config.fallbackAfterFailures, DEFAULT_FALLBACK.fallbackAfterFailures),
    recoveryProbeIntervalMs: normalizePositiveInt(config.recoveryProbeIntervalMs, DEFAULT_FALLBACK.recoveryProbeIntervalMs),
  };

  await redis.set(GATEWAY_CONFIG_KEY, JSON.stringify(normalized));
}
