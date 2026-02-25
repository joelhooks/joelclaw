export type InferenceProvider = "anthropic" | "openai" | "openai-codex";

export type InferenceTask =
  | "simple"
  | "classification"
  | "summary"
  | "digest"
  | "complex"
  | "vision"
  | "reasoning"
  | "rewrite"
  | "json"
  | "default";

export type InferenceModelId = `${InferenceProvider}/${string}`;

export type InferenceRouteAttempt = {
  /** Canonical model id used for this attempt */
  model: InferenceModelId;
  /** Provider of the model */
  provider: InferenceProvider;
  /** Why this attempt was selected */
  reason: "requested" | "policy" | "fallback";
  /** Stable ordinal in fallback chain */
  attempt: number;
};

export type InferencePlan = {
  policyVersion: string;
  requestedModel?: InferenceModelId;
  normalizedTask: InferenceTask;
  attempts: InferenceRouteAttempt[];
};

export type BuildRouteInput = {
  task?: InferenceTask;
  model?: string;
  provider?: InferenceProvider;
  maxAttempts?: number;
  policyVersion?: string;
  allowLegacy?: boolean;
  strict?: boolean;
};

export type InferenceCatalogEntry = {
  id: InferenceModelId;
  provider: InferenceProvider;
  aliases: string[];
  description: string;
  supportedTasks: InferenceTask[];
};

export type InferencePolicy = {
  version: string;
  strict: boolean;
  allowLegacy: boolean;
  maxFallbackAttempts: number;
  defaults: Record<InferenceTask, InferenceModelId[]>;
};

export const INFERENCE_EVENT_NAMES = {
  request: "model_router.request",
  route: "model_router.route",
  fallback: "model_router.fallback",
  result: "model_router.result",
  fail: "model_router.fail",
} as const;

export type InferenceEventName = (typeof INFERENCE_EVENT_NAMES)[keyof typeof INFERENCE_EVENT_NAMES];

export type InferenceRouterError = {
  code: "unknown_task" | "no_model" | "invalid_model" | "empty_model_chain";
  message: string;
  model?: string;
};

export type InferenceRouteError = Error & {
  readonly code?: InferenceRouterError["code"];
};

export type InferencePlanInput = BuildRouteInput;
