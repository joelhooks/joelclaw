import {
  GATEWAY_ALLOWED_MODELS,
  normalizeModel as normalizeCatalogModel,
  getCatalogModel as resolveModelFromCatalog,
} from "@joelclaw/inference-router";
import type { FallbackConfig } from "@joelclaw/model-fallback";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import type Redis from "ioredis";

export const GATEWAY_CONFIG_KEY = "joelclaw:gateway:config";

export const ALLOWED_MODELS = GATEWAY_ALLOWED_MODELS;

export const ALLOWED_THINKING_LEVELS = ["none", "low", "medium", "high"] as const;

export type GatewayModel = (typeof ALLOWED_MODELS)[number];
export type GatewayThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];

export type GatewayConfig = {
  model: GatewayModel;
  thinkingLevel: GatewayThinkingLevel;
  verbose: boolean;
} & FallbackConfig;

const DEFAULT_MODEL: GatewayModel = "gpt-5.5";
const DEFAULT_THINKING_LEVEL: GatewayThinkingLevel = "low";
const DEFAULT_VERBOSE = false;

const OPUS_PRIMARY_MIN_FALLBACK_TIMEOUT_MS = 240_000;

const DEFAULT_FALLBACK: FallbackConfig = {
  fallbackProvider: "openai-codex",
  fallbackModel: "gpt-5.4",
  fallbackTimeoutMs: 120_000,
  fallbackAfterFailures: 3,
  recoveryProbeIntervalMs: 10 * 60 * 1000,
};

export function providerForModel(modelId: string): string {
  const catalogModel = resolveModelFromCatalog(modelId);
  const provider = catalogModel?.provider;
  if (provider) {
    void emitGatewayOtel({
      level: "info",
      component: "gateway.commands.config",
      action: "model.provider.resolved",
      success: true,
      metadata: {
        modelId,
        catalogModel: catalogModel.id,
        provider,
      },
    });
    return provider;
  }

  void emitGatewayOtel({
    level: "info",
    component: "gateway.commands.config",
    action: "model.provider.fallback",
    success: true,
    metadata: {
      modelId,
      provider: "anthropic",
    },
  });
  return "anthropic";
}

function normalizeModel(raw: unknown): GatewayModel {
  if (typeof raw !== "string") return DEFAULT_MODEL;
  const normalized = normalizeCatalogModel(raw, true);
  if (!normalized) return DEFAULT_MODEL;

  const normalizedAlias = normalized.split("/")[1];
  return ALLOWED_MODELS.includes(normalizedAlias as GatewayModel)
    ? (normalizedAlias as GatewayModel)
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

function normalizeFallbackTimeoutMs(raw: unknown, fallback: number, model: GatewayModel): number {
  const normalized = normalizePositiveInt(raw, fallback);
  if (model === "claude-opus-4-6") {
    return Math.max(normalized, OPUS_PRIMARY_MIN_FALLBACK_TIMEOUT_MS);
  }
  return normalized;
}

function normalizeFallbackModel(raw: unknown, provider: string): string {
  if (typeof raw !== "string") return DEFAULT_FALLBACK.fallbackModel;
  const value = raw.trim();
  if (!value) return DEFAULT_FALLBACK.fallbackModel;

  const normalized = normalizeCatalogModel(value, true)
    ?? normalizeCatalogModel(`${provider}/${value}`, true);
  if (normalized) {
    const normalizedAlias = normalized.split("/")[1];
    return normalizedAlias?.trim().length ? normalizedAlias : DEFAULT_FALLBACK.fallbackModel;
  }

  if (value.includes("/")) {
    const [, modelId] = value.split("/");
    return modelId?.trim().length ? modelId.trim() : DEFAULT_FALLBACK.fallbackModel;
  }

  return value;
}

export function defaultGatewayConfig(): GatewayConfig {
  const model = normalizeModel(process.env.PI_MODEL ?? process.env.PI_MODEL_ID);
  return {
    model,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    verbose: DEFAULT_VERBOSE,
    ...DEFAULT_FALLBACK,
    fallbackTimeoutMs: normalizeFallbackTimeoutMs(DEFAULT_FALLBACK.fallbackTimeoutMs, DEFAULT_FALLBACK.fallbackTimeoutMs, model),
  };
}

export async function loadGatewayConfig(redis: Redis | undefined): Promise<GatewayConfig> {
  const defaults = defaultGatewayConfig();
  if (!redis) return defaults;

  try {
    const raw = await redis.get(GATEWAY_CONFIG_KEY);
    if (!raw) return defaults;

    const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
    const model = normalizeModel(parsed.model);
    const fallbackProvider = typeof parsed.fallbackProvider === "string"
      ? parsed.fallbackProvider
      : defaults.fallbackProvider;

    return {
      model,
      thinkingLevel: normalizeThinkingLevel(parsed.thinkingLevel),
      verbose: normalizeVerbose(parsed.verbose),
      fallbackProvider,
      fallbackModel: normalizeFallbackModel(parsed.fallbackModel, fallbackProvider),
      fallbackTimeoutMs: normalizeFallbackTimeoutMs(parsed.fallbackTimeoutMs, defaults.fallbackTimeoutMs, model),
      fallbackAfterFailures: normalizePositiveInt(parsed.fallbackAfterFailures, defaults.fallbackAfterFailures),
      recoveryProbeIntervalMs: normalizePositiveInt(parsed.recoveryProbeIntervalMs, defaults.recoveryProbeIntervalMs),
    };
  } catch {
    return defaults;
  }
}

export async function saveGatewayConfig(redis: Redis, config: GatewayConfig): Promise<void> {
  const fallbackProvider = config.fallbackProvider || DEFAULT_FALLBACK.fallbackProvider;

  const model = normalizeModel(config.model);
  const normalized: GatewayConfig = {
    model,
    thinkingLevel: normalizeThinkingLevel(config.thinkingLevel),
    verbose: normalizeVerbose(config.verbose),
    fallbackProvider,
    fallbackModel: normalizeFallbackModel(config.fallbackModel, fallbackProvider),
    fallbackTimeoutMs: normalizeFallbackTimeoutMs(config.fallbackTimeoutMs, DEFAULT_FALLBACK.fallbackTimeoutMs, model),
    fallbackAfterFailures: normalizePositiveInt(config.fallbackAfterFailures, DEFAULT_FALLBACK.fallbackAfterFailures),
    recoveryProbeIntervalMs: normalizePositiveInt(config.recoveryProbeIntervalMs, DEFAULT_FALLBACK.recoveryProbeIntervalMs),
  };

  await redis.set(GATEWAY_CONFIG_KEY, JSON.stringify(normalized));
}
