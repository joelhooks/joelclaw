import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

const runtimeEnv = (() => {
  const processLike = globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      pid?: number;
    };
  };
  return processLike.process?.env ?? {};
})();
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";
const LANGFUSE_ENABLED = (runtimeEnv.JOELCLAW_LLM_OBS_ENABLED ?? "1") !== "0";

export interface TracingConfig {
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseHost?: string;
}

let initialized = false;
let spanProcessor: LangfuseSpanProcessor | null = null;

function resolveConfig(config: TracingConfig): { publicKey: string; secretKey: string; host: string } | null {
  const publicKey = config.langfusePublicKey?.trim() || runtimeEnv.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = config.langfuseSecretKey?.trim() || runtimeEnv.LANGFUSE_SECRET_KEY?.trim();
  const host = config.langfuseHost?.trim()
    || runtimeEnv.LANGFUSE_HOST?.trim()
    || runtimeEnv.LANGFUSE_BASE_URL?.trim()
    || DEFAULT_LANGFUSE_HOST;

  if (!publicKey || !secretKey) return null;

  return { publicKey, secretKey, host };
}

export function initTracing(config: TracingConfig = {}): void {
  if (!LANGFUSE_ENABLED || initialized) return;

  const resolved = resolveConfig(config);
  if (!resolved) return;

  try {
    const processor = new LangfuseSpanProcessor({
      publicKey: resolved.publicKey,
      secretKey: resolved.secretKey,
      baseUrl: resolved.host,
      environment: runtimeEnv.JOELCLAW_ENV ?? runtimeEnv.NODE_ENV ?? "development",
      release: runtimeEnv.JOELCLAW_RELEASE ?? runtimeEnv.GIT_SHA,
      exportMode: "immediate",
    });

    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    setLangfuseTracerProvider(provider);
    spanProcessor = processor;
    initialized = true;
  } catch {
    initialized = false;
    spanProcessor = null;
  }
}

type TraceRouteDecisionInput = {
  modelId: string;
  resolvedModel: string;
  provider: string;
  source: "catalog" | "fallback" | "env";
};

export function traceRouteDecision(input: TraceRouteDecisionInput): void {
  if (!initialized || !spanProcessor) return;

  try {
    const trace = startObservation("inference_router.route", {
      input: {
        requestModel: input.modelId,
        resolvedModel: input.resolvedModel,
      },
      metadata: {
        component: "inference-router",
        action: "model-route-decision",
        source: input.source,
      },
    });

    trace.updateTrace({
      tags: ["joelclaw", "inference-router"],
      metadata: {
        component: "inference-router",
        action: "model-route-decision",
        source: input.source,
        modelId: input.modelId,
        resolvedModel: input.resolvedModel,
        provider: input.provider,
      },
    });

    const generation = trace.startObservation(
      "route.decision",
      {
        input: {
          source: input.source,
          modelId: input.modelId,
          resolvedModel: input.resolvedModel,
          provider: input.provider,
        },
        metadata: {
          provider: input.provider,
          source: input.source,
        },
      },
      { asType: "generation" },
    );
    generation.end();
    trace.end();
    void spanProcessor.forceFlush().catch(() => {});
  } catch {
    // fail-open: tracing must never block routing
  }
}
