import type Redis from "ioredis";

export const GATEWAY_CONFIG_KEY = "joelclaw:gateway:config";

export const ALLOWED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export const ALLOWED_THINKING_LEVELS = ["none", "low", "medium", "high"] as const;

export type GatewayModel = (typeof ALLOWED_MODELS)[number];
export type GatewayThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];

export type GatewayConfig = {
  model: GatewayModel;
  thinkingLevel: GatewayThinkingLevel;
  verbose: boolean;
};

const DEFAULT_MODEL: GatewayModel = "claude-opus-4-6";
const DEFAULT_THINKING_LEVEL: GatewayThinkingLevel = "low";
const DEFAULT_VERBOSE = false;

function normalizeModel(raw: unknown): GatewayModel {
  if (typeof raw !== "string") return DEFAULT_MODEL;
  const value = raw.replace(/^anthropic\//, "").trim();
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

export function defaultGatewayConfig(): GatewayConfig {
  return {
    model: normalizeModel(process.env.PI_MODEL ?? process.env.PI_MODEL_ID),
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    verbose: DEFAULT_VERBOSE,
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
  };

  await redis.set(GATEWAY_CONFIG_KEY, JSON.stringify(normalized));
}
