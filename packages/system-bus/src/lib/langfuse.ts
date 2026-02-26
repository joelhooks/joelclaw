import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

const LANGFUSE_ENABLED = (process.env.JOELCLAW_LLM_OBS_ENABLED ?? "1") !== "0";
const SECRET_TTL = process.env.JOELCLAW_LANGFUSE_SECRET_TTL ?? "4h";
const SECRET_TIMEOUT_MS = Number.parseInt(process.env.JOELCLAW_LANGFUSE_SECRET_TIMEOUT_MS ?? "2000", 10);

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput?: number;
  costOutput?: number;
  costTotal?: number;
};

export type TraceLlmGenerationInput = {
  traceName: string;
  generationName: string;
  component: string;
  action: string;
  tags?: string[];
  input: unknown;
  output?: unknown;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  runId?: string;
  agentProfile?: string;
  agentTags?: string[];
  agentToolset?: string[];
};

type PiAssistantMessage = {
  role?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: {
      input?: number;
      output?: number;
      total?: number;
    };
  };
  content?: Array<{ type?: string; text?: string }>;
};

let initialized = false;
let spanProcessor: LangfuseSpanProcessor | null = null;

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
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

  if (!publicKey || !secretKey) return null;

  return { publicKey, secretKey, baseUrl };
}

function ensureLangfuseTracing(): boolean {
  if (!LANGFUSE_ENABLED) return false;
  if (initialized) return true;

  const config = resolveLangfuseConfig();
  if (!config) return false;

  try {
    spanProcessor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: "production",
      release: process.env.JOELCLAW_RELEASE ?? process.env.GIT_SHA,
      exportMode: "immediate",
    });

    const provider = new BasicTracerProvider({
      spanProcessors: [spanProcessor],
    });

    setLangfuseTracerProvider(provider);
    initialized = true;
    return true;
  } catch {
    return false;
  }
}

function stripOtelMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const cleaned = { ...metadata };
  delete cleaned.resourceAttributes;
  delete cleaned.scope;
  return cleaned;
}

function mergeTraceTags(inputTags: string[] = []): string[] {
  const tags = ["joelclaw", "system-bus", ...inputTags.filter((tag) => typeof tag === "string" && tag.trim().length > 0)];
  return [...new Set(tags)];
}

function usageDetailsFrom(usage?: LlmUsage): Record<string, number> | undefined {
  if (!usage) return undefined;

  const details: Record<string, number> = {};
  if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) details.input = Math.max(0, usage.inputTokens);
  if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) details.output = Math.max(0, usage.outputTokens);
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) details.total = Math.max(0, usage.totalTokens);
  if (typeof usage.cacheReadTokens === "number" && Number.isFinite(usage.cacheReadTokens)) details.cache_read_input_tokens = Math.max(0, usage.cacheReadTokens);
  if (typeof usage.cacheWriteTokens === "number" && Number.isFinite(usage.cacheWriteTokens)) details.cache_write_input_tokens = Math.max(0, usage.cacheWriteTokens);

  return Object.keys(details).length > 0 ? details : undefined;
}

function costDetailsFrom(usage?: LlmUsage): Record<string, number> | undefined {
  if (!usage) return undefined;

  const details: Record<string, number> = {};
  if (typeof usage.costInput === "number" && Number.isFinite(usage.costInput)) details.input = usage.costInput;
  if (typeof usage.costOutput === "number" && Number.isFinite(usage.costOutput)) details.output = usage.costOutput;
  if (typeof usage.costTotal === "number" && Number.isFinite(usage.costTotal)) details.total = usage.costTotal;

  return Object.keys(details).length > 0 ? details : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parsePiJsonAssistant(raw: string): {
  text: string;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
} | null {
  const lines = raw.split(/\r?\n/gu);
  let assistant: PiAssistantMessage | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        message?: PiAssistantMessage;
      };

      if ((parsed.type === "turn_end" || parsed.type === "message_end") && parsed.message?.role === "assistant") {
        assistant = parsed.message;
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (!assistant) return null;

  const text = (assistant.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) return null;

  const usage = assistant.usage
    ? {
        inputTokens: toFiniteNumber(assistant.usage.input),
        outputTokens: toFiniteNumber(assistant.usage.output),
        totalTokens: toFiniteNumber(assistant.usage.totalTokens),
        cacheReadTokens: toFiniteNumber(assistant.usage.cacheRead),
        cacheWriteTokens: toFiniteNumber(assistant.usage.cacheWrite),
        costInput: toFiniteNumber(assistant.usage.cost?.input),
        costOutput: toFiniteNumber(assistant.usage.cost?.output),
        costTotal: toFiniteNumber(assistant.usage.cost?.total),
      }
    : undefined;

  return {
    text,
    provider: assistant.provider,
    model: assistant.model,
    usage,
  };
}

export async function traceLlmGeneration(input: TraceLlmGenerationInput): Promise<void> {
  if (!ensureLangfuseTracing()) return;

  try {
    const additionalMetadata = stripOtelMetadata(input.metadata);
    const baseMetadata = additionalMetadata ?? {};
    const traceTags = mergeTraceTags(input.tags);
    const joelclawMetadata = {
      source: "system-bus",
      component: input.component,
      action: input.action,
    };

    const trace = startObservation(input.traceName, {
      input: input.input,
      metadata: {
        joelclaw: joelclawMetadata,
        ...baseMetadata,
      },
    });

    trace.updateTrace({
      name: input.traceName,
      sessionId: input.sessionId,
      tags: traceTags,
      metadata: {
        agentProfile: input.agentProfile,
        agentTags: input.agentTags,
        agentToolset: input.agentToolset,
        runId: input.runId,
        joelclaw: joelclawMetadata,
        ...baseMetadata,
      },
    });

    const generation = trace.startObservation(
      input.generationName,
      {
        model: input.model,
        input: input.input,
        output: input.output,
        usageDetails: usageDetailsFrom(input.usage),
        costDetails: costDetailsFrom(input.usage),
        metadata: {
          provider: input.provider,
          durationMs: input.durationMs,
          error: input.error,
          ...baseMetadata,
        },
      },
      { asType: "generation" }
    );

    generation.end();

    trace.update({
      output: input.output,
      metadata: {
        provider: input.provider,
        model: input.model,
        durationMs: input.durationMs,
        error: input.error,
        ...baseMetadata,
      },
    });

    trace.end();
    await spanProcessor?.forceFlush();
  } catch {
    // fail-open: tracing must not break core path
  }
}
