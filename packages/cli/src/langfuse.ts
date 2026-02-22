import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

const LANGFUSE_ENABLED = (process.env.JOELCLAW_LLM_OBS_ENABLED ?? "1") !== "0";
const SECRET_TTL = process.env.JOELCLAW_LANGFUSE_SECRET_TTL ?? "4h";
const SECRET_TIMEOUT_MS = Number.parseInt(process.env.JOELCLAW_LANGFUSE_SECRET_TIMEOUT_MS ?? "2000", 10);

export type RecallRewriteUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput?: number;
  costOutput?: number;
  costTotal?: number;
};

export type RecallRewriteTraceInput = {
  query: string;
  rewritePrompt: string;
  rewrittenQuery: string;
  rewritten: boolean;
  strategy: string;
  provider?: string;
  model?: string;
  usage?: RecallRewriteUsage;
  durationMs?: number;
  error?: string;
  budgetRequested?: string;
  budgetApplied?: string;
  budgetReason?: string;
};

let initialized = false;
let disabledReason: string | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function maskError(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.slice(0, 200);
}

function truncate(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function loadSecret(name: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["secrets", "lease", name, "--ttl", SECRET_TTL], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SECRET_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb" },
    });
    if (proc.exitCode !== 0) return undefined;
    const value = readShellText(proc.stdout).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveLangfuseConfig(): { publicKey: string; secretKey: string; baseUrl: string } | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() || loadSecret("langfuse_public_key");
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() || loadSecret("langfuse_secret_key");
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim()
    || loadSecret("langfuse_base_url")
    || "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    disabledReason = "langfuse_credentials_missing";
    return null;
  }

  return {
    publicKey,
    secretKey,
    baseUrl,
  };
}

function ensureLangfuseTracing(): boolean {
  if (!LANGFUSE_ENABLED) {
    disabledReason = "langfuse_disabled";
    return false;
  }

  if (initialized) return true;

  const config = resolveLangfuseConfig();
  if (!config) return false;

  try {
    spanProcessor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: process.env.JOELCLAW_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.JOELCLAW_RELEASE ?? process.env.GIT_SHA,
      exportMode: "immediate",
    });

    const provider = new BasicTracerProvider({
      spanProcessors: [spanProcessor],
    });

    setLangfuseTracerProvider(provider);
    initialized = true;
    return true;
  } catch (error) {
    disabledReason = `langfuse_init_failed:${maskError(error)}`;
    return false;
  }
}

function usageDetailsFrom(usage?: RecallRewriteUsage): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {};

  if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
    details.input = Math.max(0, usage.inputTokens);
  }
  if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
    details.output = Math.max(0, usage.outputTokens);
  }
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    details.total = Math.max(0, usage.totalTokens);
  }
  if (typeof usage.cacheReadTokens === "number" && Number.isFinite(usage.cacheReadTokens)) {
    details.cache_read_input_tokens = Math.max(0, usage.cacheReadTokens);
  }
  if (typeof usage.cacheWriteTokens === "number" && Number.isFinite(usage.cacheWriteTokens)) {
    details.cache_write_input_tokens = Math.max(0, usage.cacheWriteTokens);
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function costDetailsFrom(usage?: RecallRewriteUsage): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {};

  if (typeof usage.costInput === "number" && Number.isFinite(usage.costInput)) {
    details.input = usage.costInput;
  }
  if (typeof usage.costOutput === "number" && Number.isFinite(usage.costOutput)) {
    details.output = usage.costOutput;
  }
  if (typeof usage.costTotal === "number" && Number.isFinite(usage.costTotal)) {
    details.total = usage.costTotal;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

export async function traceRecallRewrite(input: RecallRewriteTraceInput): Promise<void> {
  if (!ensureLangfuseTracing()) return;

  try {
    const trace = startObservation("joelclaw.recall", {
      input: {
        query: truncate(input.query, 800),
      },
      metadata: {
        component: "cli.recall",
        action: "memory.recall.rewrite",
        joelclaw: {
          scope: "llm",
          source: "cli",
        },
      },
    });

    trace.updateTrace({
      name: "joelclaw.recall",
      sessionId: `cli-${process.pid}`,
      tags: ["joelclaw", "llm-only", "recall"],
      metadata: {
        component: "cli.recall",
        action: "memory.recall.rewrite",
        budgetRequested: input.budgetRequested,
        budgetApplied: input.budgetApplied,
        budgetReason: input.budgetReason,
        joelclaw: {
          scope: "llm",
          source: "cli",
          disabledReason,
        },
      },
    });

    const generation = trace.startObservation(
      "recall.query-rewrite",
      {
        model: input.model,
        input: [
          {
            role: "user",
            content: truncate(input.rewritePrompt, 2_500),
          },
        ],
        output: {
          rewrittenQuery: truncate(input.rewrittenQuery, 800),
          rewritten: input.rewritten,
        },
        usageDetails: usageDetailsFrom(input.usage),
        costDetails: costDetailsFrom(input.usage),
        metadata: {
          strategy: input.strategy,
          provider: input.provider,
          durationMs: input.durationMs,
          rewriteError: input.error,
          joelclaw: {
            scope: "llm",
            source: "cli",
          },
        },
      },
      { asType: "generation" }
    );

    generation.update({
      metadata: {
        strategy: input.strategy,
      },
    });

    generation.end();

    trace.update({
      output: {
        rewrittenQuery: truncate(input.rewrittenQuery, 800),
        rewritten: input.rewritten,
      },
      metadata: {
        strategy: input.strategy,
        provider: input.provider,
        model: input.model,
        durationMs: input.durationMs,
        joelclaw: {
          scope: "llm",
          source: "cli",
        },
      },
    });

    trace.end();
    await spanProcessor?.forceFlush();
  } catch {
    // fail-open: never break recall command on Langfuse errors
  }
}
