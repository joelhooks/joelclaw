import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UsageLike = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type SessionType = "gateway" | "interactive" | "codex" | "central";
type GuardrailKey = "maxLlmCalls" | "maxTotalTokens" | "maxCostUsd";
type GuardrailState = Record<GuardrailKey, {
  breached: boolean;
  firstBreachTurnIndex?: number;
}>;
type SessionCounters = {
  llmCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
};
export type NormalizedModelAttribution = {
  provider?: string;
  modelId?: string;
};

const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const SESSION_TYPE = getSessionType(CHANNEL);
const TRACE_TAGS = ["joelclaw", "pi-session"];
const FLUSH_INTERVAL_MS = 30_000;
const ALERT_MAX_LLM_CALLS = readNumericEnv("JOELCLAW_LANGFUSE_ALERT_MAX_LLM_CALLS", 120);
const ALERT_MAX_TOTAL_TOKENS = readNumericEnv("JOELCLAW_LANGFUSE_ALERT_MAX_TOTAL_TOKENS", 1_200_000);
const ALERT_MAX_COST_USD = readNumericEnv("JOELCLAW_LANGFUSE_ALERT_MAX_COST_USD", 20);
let sessionId: string | null = null;
let lastTracedMessageId: string | null = null;

const KNOWN_MODEL_ALIASES: Record<string, string> = {
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4-6",
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
  "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4-5",
  "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
  "openai-codex/gpt-5.3-codex": "openai-codex/gpt-5.3-codex",
  "gpt-5.3-codex": "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark": "openai-codex/gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark": "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.2-codex-spark": "openai-codex/gpt-5.2-codex-spark",
  "gpt-5.2-codex-spark": "openai-codex/gpt-5.2-codex-spark",
  "openai/gpt-5.2": "openai/gpt-5.2",
  "gpt-5.2": "openai/gpt-5.2",
  "openai/o3": "openai/o3",
  "o3": "openai/o3",
  "openai/o4-mini": "openai/o4-mini",
  "o4-mini": "openai/o4-mini",
};

function getSessionType(channel: string): SessionType {
  const normalized = channel.toLowerCase();
  if (normalized === "gateway" || normalized === "central" || normalized === "codex" || normalized === "interactive") {
    return normalized;
  }
  return "interactive";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readNumericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeProvider(provider: unknown): string | undefined {
  if (typeof provider !== "string") return undefined;
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized === "anthropic" || normalized === "claude") return "anthropic";
  if (normalized === "openai-codex" || normalized === "codex") return "openai-codex";
  if (normalized === "openai") return "openai";
  return normalized;
}

function inferProviderFromModel(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  if (lower.includes("/")) {
    const provider = normalizeProvider(lower.split("/")[0]);
    if (provider) return provider;
  }
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.includes("codex")) return "openai-codex";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return "openai";
  }
  return undefined;
}

function applyModelAlias(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return undefined;
  return KNOWN_MODEL_ALIASES[normalized] ?? normalized;
}

export function normalizeModelAttribution(input?: {
  provider?: unknown;
  id?: unknown;
  model?: unknown;
}): NormalizedModelAttribution {
  try {
    const normalizedProvider = normalizeProvider(input?.provider);
    const rawModel = typeof input?.id === "string"
      ? input.id
      : typeof input?.model === "string"
        ? input.model
        : undefined;
    let modelId = applyModelAlias(rawModel);
    let provider = normalizedProvider;

    if (modelId && modelId.includes("/")) {
      const [providerPrefix, ...rest] = modelId.split("/");
      const suffix = rest.join("/");
      const normalizedPrefix = normalizeProvider(providerPrefix);
      if (normalizedPrefix && suffix) {
        provider = normalizedPrefix;
        modelId = applyModelAlias(`${normalizedPrefix}/${suffix}`);
      }
    }

    if (!provider) {
      provider = inferProviderFromModel(modelId);
    }

    if (modelId && !modelId.includes("/") && provider) {
      modelId = applyModelAlias(`${provider}/${modelId}`);
    }

    if (!provider && modelId) {
      provider = inferProviderFromModel(modelId);
    }

    return { provider, modelId };
  } catch {
    return {
      provider: normalizeProvider(input?.provider),
      modelId: typeof input?.id === "string" ? input.id : undefined,
    };
  }
}

function mergeModelAttribution(
  previous: NormalizedModelAttribution,
  next: NormalizedModelAttribution,
): NormalizedModelAttribution {
  return {
    provider: next.provider ?? previous.provider,
    modelId: next.modelId ?? previous.modelId,
  };
}

function getInitialSessionCounters(): SessionCounters {
  return {
    llmCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

function getInitialGuardrailState(): GuardrailState {
  return {
    maxLlmCalls: { breached: false },
    maxTotalTokens: { breached: false },
    maxCostUsd: { breached: false },
  };
}

function asCost(candidate: unknown): UsageLike["cost"] | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const parsed = candidate as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    total?: unknown;
  };

  const cost: UsageLike["cost"] = {};
  if (isNumber(parsed.input)) cost.input = parsed.input;
  if (isNumber(parsed.output)) cost.output = parsed.output;
  if (isNumber(parsed.cacheRead)) cost.cacheRead = parsed.cacheRead;
  if (isNumber(parsed.cacheWrite)) cost.cacheWrite = parsed.cacheWrite;
  if (isNumber(parsed.total)) cost.total = parsed.total;

  return Object.keys(cost).length > 0 ? cost : undefined;
}

export function parseUsage(candidate: unknown): UsageLike | null {
  if (!candidate || typeof candidate !== "object") return null;

  const usage = candidate as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: unknown;
  };

  if (!isNumber(usage.input) || !isNumber(usage.output) || !isNumber(usage.totalTokens)) {
    return null;
  }

  const cost = asCost(usage.cost);

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: isNumber(usage.cacheRead) ? usage.cacheRead : 0,
    cacheWrite: isNumber(usage.cacheWrite) ? usage.cacheWrite : 0,
    totalTokens: usage.totalTokens,
    ...(cost ? { cost } : {}),
  };
}

function getCostTotal(cost?: UsageLike["cost"]): number | undefined {
  if (!cost) return undefined;
  if (isNumber(cost.total)) return cost.total;

  const components = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].filter(isNumber);
  if (components.length === 0) return undefined;
  return components.reduce((sum, value) => sum + value, 0);
}

function getCostDetails(cost?: UsageLike["cost"]): Record<string, number> | undefined {
  if (!cost) return undefined;
  const details: Record<string, number> = {};
  if (isNumber(cost.input)) details.input = cost.input;
  if (isNumber(cost.output)) details.output = cost.output;
  if (isNumber(cost.cacheRead)) details.cache_read = cost.cacheRead;
  if (isNumber(cost.cacheWrite)) details.cache_write = cost.cacheWrite;
  if (isNumber(cost.total)) details.total = cost.total;
  return Object.keys(details).length > 0 ? details : undefined;
}

function getTraceTags(model?: NormalizedModelAttribution): string[] {
  const tags: Array<string | undefined> = [
    ...TRACE_TAGS,
    `channel:${CHANNEL}`,
    `session:${SESSION_TYPE}`,
    typeof model?.provider === "string" ? `provider:${model.provider}` : undefined,
    typeof model?.modelId === "string" ? `model:${model.modelId}` : undefined,
  ];

  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

function extractText(content: unknown, maxLen = 2000): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content.slice(0, maxLen);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n");
  return text ? text.slice(0, maxLen) : undefined;
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "tool_use" && typeof b?.name === "string")
    .map((b: any) => b.name as string);
}

function extractToolResultSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content.filter(
    (b: any) => b?.type === "tool_result" && typeof b?.tool_use_id === "string",
  ).length;
  return results > 0 ? `[${results} tool result(s)]` : undefined;
}

/** Known single-line header keys we care about */
const HEADER_KEYS = new Set(["channel", "date", "platform_capabilities"]);

/** Strip ---\nChannel:...\n--- header from input, return clean text + parsed metadata */
function stripChannelHeader(text: string): { clean: string; headerMeta?: Record<string, string> } {
  const headerMatch = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!headerMatch) return { clean: text };

  const headerBlock = headerMatch[1];
  const meta: Record<string, string> = {};

  for (const line of headerBlock.split("\n")) {
    if (/^\s*-/.test(line)) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "_");
      const value = line.slice(colonIdx + 1).trim();
      if (key && value && HEADER_KEYS.has(key)) meta[key] = value;
    }
  }

  const clean = text.slice(headerMatch[0].length).trim();
  return { clean, headerMeta: Object.keys(meta).length > 0 ? meta : undefined };
}


type LangfuseGenerationLike = {
  end: (payload?: Record<string, unknown>) => void;
};

type LangfuseSpanLike = {
  span: (payload: Record<string, unknown>) => LangfuseSpanLike;
  generation: (payload: Record<string, unknown>) => LangfuseGenerationLike;
  end: (payload?: Record<string, unknown>) => void;
};

type LangfuseTraceLike = {
  span: (payload: Record<string, unknown>) => LangfuseSpanLike;
  generation: (payload: Record<string, unknown>) => LangfuseGenerationLike;
  update: (payload: Record<string, unknown>) => void;
};

type LangfuseLike = {
  trace: (payload: Record<string, unknown>) => LangfuseTraceLike;
  flush?: () => Promise<unknown>;
  shutdownAsync: () => Promise<void>;
};

type LangfuseCtor = new (payload: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  environment?: string;
}) => LangfuseLike;

let cachedLangfuseCtor: LangfuseCtor | null | undefined;
let reportedMissingLangfuseModule = false;
const requireFromHere = createRequire(import.meta.url);

async function loadLangfuseCtor(): Promise<LangfuseCtor | null> {
  if (cachedLangfuseCtor !== undefined) {
    return cachedLangfuseCtor;
  }

  const moduleName = ["lang", "fuse"].join("");
  // Optional dependency contract:
  // - importing this extension must never hard-fail when `langfuse` is absent
  // - runtime gracefully disables telemetry instead
  // - guarded by regression test: pi/extensions/langfuse-cost/index.test.ts

  // First try CommonJS require — avoids static ESM import analysis during extension load.
  try {
    const mod = requireFromHere(moduleName) as { default?: unknown };
    const ctorCandidate = mod.default ?? mod;
    if (typeof ctorCandidate === "function") {
      cachedLangfuseCtor = ctorCandidate as LangfuseCtor;
      return cachedLangfuseCtor;
    }
  } catch {
    // fall through to dynamic import fallback
  }

  // Then try dynamic import, but keep module name dynamic to avoid static resolver crashes.
  try {
    const dynamicImport = new Function("name", "return import(name)") as (
      name: string,
    ) => Promise<{ default?: unknown }>;
    const mod = await dynamicImport(moduleName);
    const ctorCandidate = mod.default;
    if (typeof ctorCandidate === "function") {
      cachedLangfuseCtor = ctorCandidate as LangfuseCtor;
      return cachedLangfuseCtor;
    }

    cachedLangfuseCtor = null;
    if (!reportedMissingLangfuseModule) {
      reportedMissingLangfuseModule = true;
      console.warn("langfuse-cost: 'langfuse' module loaded without a constructor; telemetry disabled.");
    }
    return null;
  } catch {
    cachedLangfuseCtor = null;
    if (!reportedMissingLangfuseModule) {
      reportedMissingLangfuseModule = true;
      console.warn("langfuse-cost: cannot load optional dependency 'langfuse'; telemetry disabled.");
    }
    return null;
  }
}

const GLOBAL_KEY = "__langfuse_cost_loaded__";

export default function (pi: ExtensionAPI) {
  if ((globalThis as any)[GLOBAL_KEY]) {
    console.warn("langfuse-cost: skipping duplicate instance (already loaded)");
    return;
  }
  (globalThis as any)[GLOBAL_KEY] = true;
  let langfuse: LangfuseLike | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let initPromise: Promise<void> | null = null;

  // --- Span hierarchy state ---
  // Session trace: one per pi session lifetime
  let sessionTrace: LangfuseTraceLike | null = null;
  let sessionSpan: LangfuseSpanLike | null = null;
  let sessionStartTime: Date | null = null;
  let sessionTurnCount = 0;

  // Message span: one per user→assistant exchange
  let messageSpan: LangfuseSpanLike | null = null;
  let messageStartTime: Date | null = null;
  let lastUserInput: string | undefined;
  let lastInputHeaderMeta: Record<string, string> | undefined;
  let lastAssistantStartTime: number | undefined;

  // Tool spans: one per tool_call→tool_result
  let pendingToolNames: string[] = [];
  let activeToolSpans: Map<string, LangfuseSpanLike> = new Map();

  // Session-level usage/cost control state
  let sessionCounters = getInitialSessionCounters();
  let guardrailState = getInitialGuardrailState();
  let currentModelAttribution: NormalizedModelAttribution = {};

  const guardrailThresholds = {
    maxLlmCalls: ALERT_MAX_LLM_CALLS,
    maxTotalTokens: ALERT_MAX_TOTAL_TOKENS,
    maxCostUsd: ALERT_MAX_COST_USD,
  };

  const getGuardrailMetadata = () => ({
    alertOnly: true,
    thresholds: guardrailThresholds,
    breached: {
      maxLlmCalls: guardrailState.maxLlmCalls.breached,
      maxTotalTokens: guardrailState.maxTotalTokens.breached,
      maxCostUsd: guardrailState.maxCostUsd.breached,
    },
    firstBreachTurnIndex: {
      maxLlmCalls: guardrailState.maxLlmCalls.firstBreachTurnIndex ?? null,
      maxTotalTokens: guardrailState.maxTotalTokens.firstBreachTurnIndex ?? null,
      maxCostUsd: guardrailState.maxCostUsd.firstBreachTurnIndex ?? null,
    },
  });

  const getSessionCounterMetadata = () => ({
    llmCallCount: sessionCounters.llmCallCount,
    inputTokens: sessionCounters.inputTokens,
    outputTokens: sessionCounters.outputTokens,
    cacheReadTokens: sessionCounters.cacheReadTokens,
    cacheWriteTokens: sessionCounters.cacheWriteTokens,
    totalTokens: sessionCounters.totalTokens,
    totalCostUsd: Number(sessionCounters.totalCostUsd.toFixed(6)),
  });

  const warnGuardrailOnce = (
    key: GuardrailKey,
    currentValue: number,
    threshold: number,
  ) => {
    if (threshold <= 0) return;
    const state = guardrailState[key];
    if (state.breached || currentValue < threshold) return;

    state.breached = true;
    state.firstBreachTurnIndex = sessionTurnCount;

    console.warn(
      `langfuse-cost guardrail alert (${key}) sessionId=${sessionId ?? "unknown"} threshold=${threshold} current=${currentValue} counters=${JSON.stringify(getSessionCounterMetadata())}`,
    );
  };

  const evaluateGuardrails = () => {
    warnGuardrailOnce("maxLlmCalls", sessionCounters.llmCallCount, guardrailThresholds.maxLlmCalls);
    warnGuardrailOnce("maxTotalTokens", sessionCounters.totalTokens, guardrailThresholds.maxTotalTokens);
    warnGuardrailOnce("maxCostUsd", sessionCounters.totalCostUsd, guardrailThresholds.maxCostUsd);
  };

  const resolveCurrentAttribution = (ctxModel?: { provider?: unknown; id?: unknown }, message?: { provider?: unknown; model?: unknown }) => {
    currentModelAttribution = mergeModelAttribution(
      currentModelAttribution,
      normalizeModelAttribution({ provider: ctxModel?.provider, id: ctxModel?.id }),
    );

    if (message) {
      currentModelAttribution = mergeModelAttribution(
        currentModelAttribution,
        normalizeModelAttribution({ provider: message.provider, model: message.model }),
      );
    }

    return currentModelAttribution;
  };

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;

  const initializeLangfuse = (): Promise<void> => {
    if (langfuse) return Promise.resolve();
    if (initPromise) return initPromise;
    if (!publicKey || !secretKey) return Promise.resolve();

    initPromise = (async () => {
      const Langfuse = await loadLangfuseCtor();
      if (!Langfuse) return;

      try {
        langfuse = new Langfuse({
          publicKey,
          secretKey,
          baseUrl,
          environment: "production",
        });

        flushTimer = setInterval(() => {
          try {
            langfuse?.flush?.()?.catch?.(() => {}); // Swallow async flush failures silently
          } catch {
            // Swallow sync flush failures silently
          }
        }, FLUSH_INTERVAL_MS);
      } catch (error) {
        console.error("langfuse-cost: Failed to initialize Langfuse; telemetry disabled.", error);
        langfuse = null;
        if (flushTimer) {
          clearInterval(flushTimer);
          flushTimer = undefined;
        }
      }
    })().finally(() => {
      initPromise = null;
    });

    return initPromise;
  };

  if (!publicKey || !secretKey) {
    console.warn(
      "langfuse-cost: LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY missing; telemetry disabled.",
    );
  } else {
    void initializeLangfuse();
  }

  // ─── SESSION SPAN ───────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initializeLangfuse();
      sessionId = ctx.sessionManager.getSessionId() ?? null;
      sessionStartTime = new Date();
      sessionTurnCount = 0;
      sessionCounters = getInitialSessionCounters();
      guardrailState = getInitialGuardrailState();
      currentModelAttribution = resolveCurrentAttribution(ctx.model);
      if (!langfuse || !sessionId) return;

      sessionTrace = langfuse.trace({
        name: "joelclaw.session",
        userId: "joel",
        sessionId,
        tags: getTraceTags(currentModelAttribution),
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          model: currentModelAttribution.modelId,
          provider: currentModelAttribution.provider,
          ...getSessionCounterMetadata(),
          guardrails: getGuardrailMetadata(),
        },
      });

      sessionSpan = sessionTrace.span({
        name: "session",
        startTime: sessionStartTime,
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
        },
      });
    } catch {
      // ignore
    }
  });

  // ─── MESSAGE SPAN ──────────────────────────────────────────────
  pi.on("message_start", (event, _ctx) => {
    try {
      const message = event.message;
      if (!message || typeof message !== "object") return;

      const role = (message as { role?: unknown }).role;

      if (role === "assistant") {
        lastAssistantStartTime = Date.now();
        return;
      }

      if (role !== "user") return;

      // Start a new message span for this user→assistant exchange
      messageStartTime = new Date();
      const parentSpan = sessionSpan || sessionTrace;

      const content = (message as { content?: unknown }).content;
      const extracted = extractText(content);
      if (extracted !== undefined) {
        const { clean, headerMeta } = stripChannelHeader(extracted);
        lastUserInput = clean || extracted;
        lastInputHeaderMeta = headerMeta;
      } else {
        const toolSummary = extractToolResultSummary(content);
        if (toolSummary !== undefined) {
          lastUserInput = toolSummary;
        }
      }

      if (parentSpan && langfuse) {
        // End previous message span if still open (shouldn't happen, but safety)
        if (messageSpan) {
          try { messageSpan.end(); } catch { /* ignore */ }
        }

        sessionTurnCount++;
        messageSpan = parentSpan.span({
          name: `turn-${sessionTurnCount}`,
          startTime: messageStartTime,
          input: lastUserInput,
          metadata: {
            turnIndex: sessionTurnCount,
            ...(lastInputHeaderMeta ? { sourceChannel: lastInputHeaderMeta } : {}),
          },
        });
      }
    } catch {
      // ignore
    }
  });

  // ─── TOOL SPANS ────────────────────────────────────────────────
  pi.on("tool_call", (event, _ctx) => {
    try {
      const toolName = (event as any)?.toolName;
      const toolCallId = (event as any)?.toolCallId;
      if (typeof toolName === "string" && toolName) {
        pendingToolNames.push(toolName);

        // Create a child span under the current message span
        const parent = messageSpan || sessionSpan || sessionTrace;
        if (parent && typeof toolCallId === "string") {
          const toolSpan = parent.span({
            name: `tool:${toolName}`,
            startTime: new Date(),
            input: (event as any)?.input,
            metadata: { toolName, toolCallId },
          });
          activeToolSpans.set(toolCallId, toolSpan);
        }
      }
    } catch {
      // ignore
    }
  });

  pi.on("tool_result" as any, (event: any, _ctx: any) => {
    try {
      const toolCallId = event?.toolCallId ?? event?.toolUseId;
      if (typeof toolCallId === "string" && activeToolSpans.has(toolCallId)) {
        const toolSpan = activeToolSpans.get(toolCallId)!;
        const output = extractText(event?.result ?? event?.content) ?? event?.output;
        toolSpan.end({
          output: typeof output === "string" ? output.slice(0, 500) : undefined,
        });
        activeToolSpans.delete(toolCallId);
      }
    } catch {
      // ignore
    }
  });

  // ─── GENERATION (LLM CALL) ────────────────────────────────────
  pi.on("message_end", (event, ctx) => {
    if (!langfuse) return;

    try {
      if (!sessionId) {
        try {
          sessionId = ctx.sessionManager.getSessionId() ?? null;
        } catch { /* ignore */ }
      }

      const message = event.message;
      if (!message || typeof message !== "object") return;
      if ((message as { role?: unknown }).role !== "assistant") return;

      const assistantMessage = message as {
        usage?: unknown;
        stopReason?: unknown;
        content?: unknown;
        provider?: unknown;
        model?: unknown;
      };

      const attribution = resolveCurrentAttribution(ctx.model, {
        provider: assistantMessage.provider,
        model: assistantMessage.model,
      });

      const usage = parseUsage(assistantMessage.usage);
      if (!usage) return;

      const dedupKey = `${usage.input}-${usage.output}-${usage.totalTokens}-${usage.cacheRead}-${usage.cacheWrite}-${getCostTotal(usage.cost) ?? "na"}`;
      if (dedupKey === lastTracedMessageId) return;
      lastTracedMessageId = dedupKey;

      const stopReason = assistantMessage.stopReason;
      const content = assistantMessage.content;
      const toolNames = pendingToolNames.length > 0 ? [...pendingToolNames] : extractToolNames(content);
      pendingToolNames = [];

      const outputText = extractText(content);
      const output =
        outputText ||
        (toolNames.length > 0 ? `[${toolNames.join(", ")}]` : undefined) ||
        (typeof stopReason === "string" ? `[${stopReason}]` : undefined);
      const input = lastUserInput ?? (stopReason === "toolUse" ? "[tool continuation]" : undefined);
      const completionStartTime = lastAssistantStartTime
        ? new Date(lastAssistantStartTime)
        : undefined;

      sessionCounters.llmCallCount += 1;
      sessionCounters.inputTokens += usage.input;
      sessionCounters.outputTokens += usage.output;
      sessionCounters.cacheReadTokens += usage.cacheRead;
      sessionCounters.cacheWriteTokens += usage.cacheWrite;
      sessionCounters.totalTokens += usage.totalTokens;
      const costTotal = getCostTotal(usage.cost);
      if (typeof costTotal === "number") {
        sessionCounters.totalCostUsd += costTotal;
      }
      evaluateGuardrails();

      // If no session trace exists (session_start missed), create a standalone trace
      if (!sessionTrace) {
        sessionTrace = langfuse.trace({
          name: "joelclaw.session",
          userId: "joel",
          sessionId: sessionId ?? undefined,
          tags: getTraceTags(attribution),
          metadata: {
            channel: CHANNEL,
            sessionType: SESSION_TYPE,
            component: "pi-session",
            model: attribution.modelId,
            provider: attribution.provider,
            ...getSessionCounterMetadata(),
            guardrails: getGuardrailMetadata(),
          },
        });
      }

      // Generation is a child of the message span (or session span)
      const parent = messageSpan || sessionSpan || sessionTrace;
      const costDetails = getCostDetails(usage.cost);

      const generation = parent.generation({
        name: "llm.call",
        model: attribution.modelId,
        input,
        output,
        completionStartTime,
        endTime: new Date(),
        usageDetails: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cache_read_input_tokens: usage.cacheRead,
          cache_write_input_tokens: usage.cacheWrite,
        },
        ...(costDetails ? { costDetails } : {}),
        metadata: {
          provider: attribution.provider,
          stopReason,
          ...(toolNames.length > 0 ? { tools: toolNames } : {}),
        },
      });
      generation.end();

      // Update message span output when we get a text response (end of turn)
      if (messageSpan && outputText && stopReason !== "toolUse") {
        messageSpan.end({
          output: outputText,
        });
        messageSpan = null;
      }

      // Update session trace with latest state
      sessionTrace.update({
        output: `${sessionTurnCount} turns`,
        tags: getTraceTags(attribution),
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          model: attribution.modelId,
          provider: attribution.provider,
          turnCount: sessionTurnCount,
          ...getSessionCounterMetadata(),
          guardrails: getGuardrailMetadata(),
        },
      });

      lastAssistantStartTime = undefined;
      lastInputHeaderMeta = undefined;
    } catch (error) {
      console.error("langfuse-cost: Failed to process message_end", error);
    }
  });
  // ─── SESSION SHUTDOWN ──────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (!langfuse) return;

    try {
      // End any open tool spans
      activeToolSpans.forEach((span) => {
        try { span.end(); } catch { /* ignore */ }
      });
      activeToolSpans.clear();

      // End message span if open
      if (messageSpan) {
        try { messageSpan.end(); } catch { /* ignore */ }
        messageSpan = null;
      }

      // End session span
      if (sessionSpan) {
        try {
          sessionSpan.end({
            output: `${sessionTurnCount} turns`,
            metadata: {
              turnCount: sessionTurnCount,
              ...getSessionCounterMetadata(),
              guardrails: getGuardrailMetadata(),
            },
          });
        } catch { /* ignore */ }
        sessionSpan = null;
      }

      // Final trace update
      if (sessionTrace) {
        try {
          sessionTrace.update({
            output: `Session ended after ${sessionTurnCount} turns`,
            tags: getTraceTags(currentModelAttribution),
            metadata: {
              channel: CHANNEL,
              sessionType: SESSION_TYPE,
              component: "pi-session",
              model: currentModelAttribution.modelId,
              provider: currentModelAttribution.provider,
              turnCount: sessionTurnCount,
              ...getSessionCounterMetadata(),
              guardrails: getGuardrailMetadata(),
            },
          });
        } catch { /* ignore */ }
        sessionTrace = null;
      }

      sessionCounters = getInitialSessionCounters();
      guardrailState = getInitialGuardrailState();
      currentModelAttribution = {};

      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      await langfuse.shutdownAsync();
    } catch (error) {
      console.error("langfuse-cost: Failed to shutdown Langfuse", error);
    }
  });
}
