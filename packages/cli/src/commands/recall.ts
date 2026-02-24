// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Migrated from Qdrant+embed.py (Qdrant fully retired 2026-02-22) to Typesense with built-in auto-embedding.
// ADR-0077 Workstream 1/2: query rewrite + trust pass + usage-signal-aware ranking.
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"
import { traceRecallRewrite } from "../langfuse"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const OTEL_INGEST_URL = process.env.JOELCLAW_OTEL_INGEST_URL || "http://localhost:3111/observability/emit"
const OTEL_INGEST_TOKEN = process.env.OTEL_EMIT_TOKEN?.trim()
const MAX_INJECT = 10
const DECAY_CONSTANT = 0.01
const STALENESS_DAYS = 90
const MIN_OBSERVATION_CHARS = 12
const REWRITE_TIMEOUT_MS = 2_000
const OPENAI_REWRITE_TIMEOUT_MS = 3_000
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
const ANTHROPIC_REWRITE_MODEL = process.env.JOELCLAW_RECALL_REWRITE_MODEL?.trim() || "claude-3-5-haiku-latest"
const OPENAI_REWRITE_MODEL = "gpt-5.3-codex-spark"
const RECALL_OTEL_ENABLED = (process.env.JOELCLAW_RECALL_OTEL ?? "1") !== "0"
const RECALL_REWRITE_ENABLED = (process.env.JOELCLAW_RECALL_REWRITE ?? "1") !== "0"

type RewriteStrategy = "haiku" | "openai" | "fallback" | "disabled"
type BudgetProfile = "lean" | "balanced" | "deep" | "auto"

type BudgetPlan = {
  requested: BudgetProfile
  applied: Exclude<BudgetProfile, "auto">
  reason: string
  rewriteEnabled: boolean
  fetchMultiplier: number
  maxInject: number
}

interface TypesenseHit {
  document: {
    id: string
    session_id?: string
    timestamp?: number
    updated_at?: string
    observation_type?: string
    observation: string
    source?: string
    merged_count?: number | string
    stale?: boolean
    recall_count?: number | string
    retrieval_priority?: number | string
    write_verdict?: "allow" | "hold" | "discard"
    category_id?: string
    category_confidence?: number | string
    category_source?: string
    taxonomy_version?: string
  }
  highlights?: Array<{ field: string; snippet?: string }>
  text_match_info?: { score?: number | string }
  hybrid_search_info?: { rank_fusion_score?: number | string }
}

interface RankedRecallHit extends TypesenseHit {
  score: number
  decayedScore: number
  usageBoost: number
}

type RewriteUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costInput?: number
  costOutput?: number
  costTotal?: number
}

type RewrittenQuery = {
  inputQuery: string
  rewritePrompt: string
  rewrittenQuery: string
  rewritten: boolean
  strategy: RewriteStrategy
  model?: string
  provider?: string
  usage?: RewriteUsage
  durationMs?: number
  error?: string
}

type TrustPassDroppedHit = {
  id: string
  observation: string
  reasons: string[]
}

type RewriteRunnerOptions = {
  rewriteEnabled?: boolean
  context?: string
  timeoutMs?: number
  spawn?: (
    args: string[],
    prompt: string,
    timeoutMs: number
  ) => {
    exitCode: number | null
    stdout: unknown
    stderr: unknown
  }
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/gu, " ").slice(0, 300)
}

function normalizeBudgetProfile(input: string): BudgetProfile {
  const normalized = input.trim().toLowerCase()
  if (normalized === "lean") return "lean"
  if (normalized === "balanced") return "balanced"
  if (normalized === "deep") return "deep"
  return "auto"
}

function normalizeCategoryFilter(input: string): string | null {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return null

  const aliasMap: Record<string, string> = {
    "preferences": "jc:preferences",
    "jc:preferences": "jc:preferences",
    "rules": "jc:rules-conventions",
    "conventions": "jc:rules-conventions",
    "jc:rules-conventions": "jc:rules-conventions",
    "architecture": "jc:system-architecture",
    "system-architecture": "jc:system-architecture",
    "jc:system-architecture": "jc:system-architecture",
    "operations": "jc:operations",
    "ops": "jc:operations",
    "jc:operations": "jc:operations",
    "memory": "jc:memory-system",
    "memory-system": "jc:memory-system",
    "jc:memory-system": "jc:memory-system",
    "projects": "jc:projects",
    "jc:projects": "jc:projects",
    "people": "jc:people-relationships",
    "relationships": "jc:people-relationships",
    "jc:people-relationships": "jc:people-relationships",
  }

  return aliasMap[normalized] ?? null
}

function resolveBudgetPlan(requestedRaw: string, query: string): BudgetPlan {
  const requested = normalizeBudgetProfile(requestedRaw)
  const normalizedQuery = normalizeQuery(query)

  const applied: Exclude<BudgetProfile, "auto"> = requested === "auto"
    ? normalizedQuery.length > 90 || normalizedQuery.includes(" and ") || normalizedQuery.includes("why")
      ? "deep"
      : "balanced"
    : requested

  switch (applied) {
    case "lean":
      return {
        requested,
        applied,
        reason: requested === "auto" ? "auto-short-query" : "explicit",
        rewriteEnabled: false,
        fetchMultiplier: 1.8,
        maxInject: 5,
      }
    case "deep":
      return {
        requested,
        applied,
        reason: requested === "auto" ? "auto-complex-query" : "explicit",
        rewriteEnabled: true,
        fetchMultiplier: 5,
        maxInject: 10,
      }
    case "balanced":
    default:
      return {
        requested,
        applied,
        reason: requested === "auto" ? "auto-default" : "explicit",
        rewriteEnabled: true,
        fetchMultiplier: 3,
        maxInject: 10,
      }
  }
}

function sanitizeRewriteResult(text: string): string {
  return normalizeQuery(
    text
      .replace(/^["'`]+/u, "")
      .replace(/["'`]+$/u, "")
  )
}

function toIsoTimestamp(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function toAgeDays(timestampSeconds: number | undefined): number {
  if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) return 0
  const createdAt = timestampSeconds * 1000
  return Math.max(0, (Date.now() - createdAt) / (1000 * 60 * 60 * 24))
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value == null) return ""
  return String(value)
}

type PiAssistantMessage = {
  provider?: string
  model?: string
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    cost?: {
      input?: number
      output?: number
      total?: number
    }
  }
  content?: Array<{ type?: string; text?: string }>
}

type AnthropicRewriteResponse = {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  content?: Array<{ type?: string; text?: string }>
}

type OpenAIRewriteResponse = {
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
}

function parsePiRewriteJsonOutput(stdout: string): {
  rewrittenQuery: string
  provider?: string
  model?: string
  usage?: RewriteUsage
} | null {
  const lines = stdout.split(/\r?\n/gu)
  let assistant: PiAssistantMessage | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string
        message?: PiAssistantMessage & { role?: string }
      }

      if ((parsed.type === "turn_end" || parsed.type === "message_end") && parsed.message?.role === "assistant") {
        assistant = parsed.message
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (!assistant) return null

  const rewrittenText = sanitizeRewriteResult(
    (assistant.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join("")
  )

  if (!rewrittenText) return null

  const usageRaw = assistant.usage
  const usage: RewriteUsage | undefined = usageRaw
    ? {
        inputTokens: asFiniteNumber(usageRaw.input, 0),
        outputTokens: asFiniteNumber(usageRaw.output, 0),
        totalTokens: asFiniteNumber(usageRaw.totalTokens, 0),
        cacheReadTokens: asFiniteNumber(usageRaw.cacheRead, 0),
        cacheWriteTokens: asFiniteNumber(usageRaw.cacheWrite, 0),
        costInput: asFiniteNumber(usageRaw.cost?.input, 0),
        costOutput: asFiniteNumber(usageRaw.cost?.output, 0),
        costTotal: asFiniteNumber(usageRaw.cost?.total, 0),
      }
    : undefined

  return {
    rewrittenQuery: rewrittenText,
    provider: assistant.provider,
    model: assistant.model,
    usage,
  }
}

function parseAnthropicRewriteOutput(payload: AnthropicRewriteResponse): {
  rewrittenQuery: string
  model?: string
  usage?: RewriteUsage
} | null {
  const rewrittenText = sanitizeRewriteResult(
    (payload.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join("")
  )

  if (!rewrittenText) return null

  const usageRaw = payload.usage
  const inputTokens = asFiniteNumber(usageRaw?.input_tokens, 0)
  const outputTokens = asFiniteNumber(usageRaw?.output_tokens, 0)
  const usage: RewriteUsage | undefined = usageRaw
    ? {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens: asFiniteNumber(usageRaw.cache_read_input_tokens, 0),
        cacheWriteTokens: asFiniteNumber(usageRaw.cache_creation_input_tokens, 0),
      }
    : undefined

  return {
    rewrittenQuery: rewrittenText,
    model: payload.model,
    usage,
  }
}

function parseOpenAIRewriteOutput(payload: OpenAIRewriteResponse): {
  rewrittenQuery: string
  model?: string
  usage?: RewriteUsage
} | null {
  const content = payload.choices?.[0]?.message?.content
  const rewrittenText = sanitizeRewriteResult(
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part?.text ?? "").join("")
        : ""
  )

  if (!rewrittenText) return null

  const usageRaw = payload.usage
  const inputTokens = asFiniteNumber(usageRaw?.prompt_tokens, 0)
  const outputTokens = asFiniteNumber(usageRaw?.completion_tokens, 0)
  const usage: RewriteUsage | undefined = usageRaw
    ? {
        inputTokens,
        outputTokens,
        totalTokens: asFiniteNumber(usageRaw?.total_tokens, inputTokens + outputTokens),
      }
    : undefined

  return {
    rewrittenQuery: rewrittenText,
    model: payload.model,
    usage,
  }
}

function usageBoostFromDoc(doc: TypesenseHit["document"]): number {
  const priority = clamp(asFiniteNumber(doc.retrieval_priority, 0), -1, 1)
  const recallCount = Math.max(0, asFiniteNumber(doc.recall_count, 0))
  const priorityFactor = 1 + priority * 0.15
  const recallFactor = 1 + Math.min(0.3, Math.log1p(recallCount) * 0.06)
  return Math.max(0.35, priorityFactor * recallFactor)
}

// Typesense text_match_info.score is on a ~1e18 scale; rank_fusion_score is 0–1.
// When only text_match is available, normalize to 0–1 so scores are comparable.
const TEXT_MATCH_MAX = 1.7e18

function normalizeRawScore(hit: TypesenseHit): number {
  const fusionScore = asFiniteNumber(hit.hybrid_search_info?.rank_fusion_score, -1)
  if (fusionScore >= 0) return fusionScore
  const textScore = asFiniteNumber(hit.text_match_info?.score, 0)
  if (textScore > 1) return Math.min(textScore / TEXT_MATCH_MAX, 1)
  return textScore
}

function applyScoreDecay(hits: TypesenseHit[]): RankedRecallHit[] {
  const now = Date.now()
  return hits.map((hit) => {
    const rawScore = normalizeRawScore(hit)
    const createdAt = typeof hit.document.timestamp === "number"
      ? hit.document.timestamp * 1000
      : now
    const daysSince = Math.max(0, (now - createdAt) / (1000 * 60 * 60 * 24))
    const decayedScore = rawScore * Math.exp(-DECAY_CONSTANT * daysSince) * usageBoostFromDoc(hit.document)
    return {
      ...hit,
      score: rawScore,
      decayedScore,
      usageBoost: usageBoostFromDoc(hit.document),
    }
  })
}

function rankHits(hits: TypesenseHit[]): RankedRecallHit[] {
  const decayed = applyScoreDecay(hits)
  decayed.sort((a, b) => b.decayedScore - a.decayedScore)
  return decayed
}

function trustPassFilter(
  hits: RankedRecallHit[],
  minScore: number,
  options: { includeHold?: boolean; includeDiscard?: boolean } = {}
): { kept: RankedRecallHit[]; dropped: TrustPassDroppedHit[]; filtersApplied: string[] } {
  const dropped: TrustPassDroppedHit[] = []
  const kept: RankedRecallHit[] = []
  const filtersApplied = ["score-decay", "usage-signal", "inject-cap", "write-gate"] as string[]

  for (const hit of hits) {
    const reasons: string[] = []
    const observation = hit.document.observation?.trim() ?? ""
    const recallCount = Math.max(0, asFiniteNumber(hit.document.recall_count, 0))
    const ageDays = toAgeDays(hit.document.timestamp)
    const writeVerdict = hit.document.write_verdict

    if (observation.length < MIN_OBSERVATION_CHARS) reasons.push("too_short")
    if (hit.document.stale === true) reasons.push("stale_tagged")
    if (ageDays > STALENESS_DAYS && recallCount <= 0) reasons.push("stale_age")
    if (!Number.isFinite(hit.decayedScore) || hit.decayedScore <= 0) reasons.push("invalid_score")
    if (hit.decayedScore < minScore) reasons.push("below_min_score")

    if (writeVerdict === "hold" && !options.includeHold) {
      reasons.push("held_by_write_gate")
    }
    if (writeVerdict === "discard" && !options.includeDiscard) {
      reasons.push("discarded_by_write_gate")
    }

    if (reasons.length > 0) {
      dropped.push({
        id: hit.document.id,
        observation: observation.slice(0, 220),
        reasons,
      })
    } else {
      kept.push(hit)
    }
  }

  if (dropped.length > 0) filtersApplied.push("trust-pass")
  if (kept.length === 0 && hits.length > 0) {
    filtersApplied.push("trust-pass-fallback")
    kept.push(hits[0]!)
  }

  return { kept, dropped, filtersApplied }
}

async function emitRecallOtel(input: {
  level: "debug" | "info" | "warn" | "error"
  action: string
  success: boolean
  durationMs?: number
  error?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  if (!RECALL_OTEL_ENABLED) return

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (OTEL_INGEST_TOKEN) headers["x-otel-emit-token"] = OTEL_INGEST_TOKEN

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    await fetch(OTEL_INGEST_URL, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        id: randomUUID(),
        timestamp: Date.now(),
        level: input.level,
        source: "cli",
        component: "recall-cli",
        action: input.action,
        success: input.success,
        duration_ms: input.durationMs,
        error: input.error,
        metadata: input.metadata ?? {},
      }),
    })
  } catch {
    // never fail recall on telemetry transport issues
  } finally {
    clearTimeout(timer)
  }
}

async function runRewriteQueryWith(query: string, options: RewriteRunnerOptions = {}): Promise<RewrittenQuery> {
  const normalized = normalizeQuery(query)
  const rewriteEnabled = options.rewriteEnabled ?? RECALL_REWRITE_ENABLED
  if (!rewriteEnabled || normalized.length < 4) {
    return {
      inputQuery: normalized,
      rewritePrompt: normalized,
      rewrittenQuery: normalized,
      rewritten: false,
      strategy: "disabled",
    }
  }

  const context = options.context ?? process.env.JOELCLAW_RECALL_CONTEXT?.trim()
  const rewritePrompt = [
    "Rewrite the memory recall query for semantic retrieval.",
    "Return ONLY the rewritten query text.",
    `Original query: ${normalized}`,
    context ? `Recent context: ${context}` : "",
  ].filter(Boolean).join("\n")

  const haikuTimeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS
  const openaiTimeoutMs = OPENAI_REWRITE_TIMEOUT_MS
  const startedAt = Date.now()
  const attemptErrors: string[] = []

  function formatRewriteError(error: unknown, timeoutMs: number): string {
    const isAbortError = error instanceof Error && error.name === "AbortError"
    const rawMessage = error instanceof Error ? error.message : String(error)
    const message = isAbortError
      ? `rewrite_timeout_${timeoutMs}`
      : rawMessage
    return message.slice(0, 220)
  }

  async function runHaikuRewrite(): Promise<RewrittenQuery> {
    if (options.spawn) {
      const proc = options.spawn([], rewritePrompt, haikuTimeoutMs)
      const stdoutText = readShellText(proc.stdout)
      const parsedJson = parsePiRewriteJsonOutput(stdoutText)
      const rewrittenQuery = parsedJson?.rewrittenQuery ?? sanitizeRewriteResult(stdoutText)
      const stderr = readShellText(proc.stderr).trim()
      const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : -1

      if (exitCode === 0 && rewrittenQuery.length > 0) {
        return {
          inputQuery: normalized,
          rewritePrompt,
          rewrittenQuery,
          rewritten: rewrittenQuery.toLowerCase() !== normalized.toLowerCase(),
          strategy: "haiku",
          provider: parsedJson?.provider,
          model: parsedJson?.model ?? ANTHROPIC_REWRITE_MODEL,
          usage: parsedJson?.usage,
          durationMs: Date.now() - startedAt,
        }
      }

      throw new Error(stderr || `rewrite_exit_${exitCode}`)
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("anthropic_api_key_missing")
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), haikuTimeoutMs)
    let response: Response
    try {
      response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          model: ANTHROPIC_REWRITE_MODEL,
          max_tokens: 96,
          temperature: 0,
          messages: [{ role: "user", content: rewritePrompt }],
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`anthropic_http_${response.status}:${text.slice(0, 160)}`)
    }

    const payload = await response.json() as AnthropicRewriteResponse
    const parsed = parseAnthropicRewriteOutput(payload)
    if (!parsed) {
      throw new Error("anthropic_empty_response")
    }

    return {
      inputQuery: normalized,
      rewritePrompt,
      rewrittenQuery: parsed.rewrittenQuery,
      rewritten: parsed.rewrittenQuery.toLowerCase() !== normalized.toLowerCase(),
      strategy: "haiku",
      provider: "anthropic",
      model: parsed.model ?? ANTHROPIC_REWRITE_MODEL,
      usage: parsed.usage,
      durationMs: Date.now() - startedAt,
    }
  }

  async function runOpenAIRewrite(): Promise<RewrittenQuery> {
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("openai_api_key_missing")
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), openaiTimeoutMs)
    let response: Response
    try {
      response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_REWRITE_MODEL,
          max_tokens: 96,
          temperature: 0,
          messages: [{ role: "user", content: rewritePrompt }],
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`openai_http_${response.status}:${text.slice(0, 160)}`)
    }

    const payload = await response.json() as OpenAIRewriteResponse
    const parsed = parseOpenAIRewriteOutput(payload)
    if (!parsed) {
      throw new Error("openai_empty_response")
    }

    return {
      inputQuery: normalized,
      rewritePrompt,
      rewrittenQuery: parsed.rewrittenQuery,
      rewritten: parsed.rewrittenQuery.toLowerCase() !== normalized.toLowerCase(),
      strategy: "openai",
      provider: "openai",
      model: parsed.model ?? OPENAI_REWRITE_MODEL,
      usage: parsed.usage,
      durationMs: Date.now() - startedAt,
    }
  }

  try {
    return await runHaikuRewrite()
  } catch (error) {
    attemptErrors.push(formatRewriteError(error, haikuTimeoutMs))
  }

  if (!options.spawn) {
    try {
      return await runOpenAIRewrite()
    } catch (error) {
      attemptErrors.push(formatRewriteError(error, openaiTimeoutMs))
    }
  }

  return {
    inputQuery: normalized,
    rewritePrompt,
    rewrittenQuery: normalized,
    rewritten: false,
    strategy: "fallback",
    durationMs: Date.now() - startedAt,
    error: attemptErrors.join(" | ").slice(0, 220),
  }
}

async function runRewriteQuery(query: string): Promise<RewrittenQuery> {
  return runRewriteQueryWith(query)
}

/** Hybrid semantic+keyword search over memory_observations */
async function searchTypesense(
  query: string,
  limit: number,
  apiKey: string,
  options?: { fetchMultiplier?: number; filterBy?: string },
): Promise<{ hits: TypesenseHit[]; found: number }> {
  const bounded = Math.min(Math.max(limit, 1), MAX_INJECT)
  const fetchMultiplier = options?.fetchMultiplier && Number.isFinite(options.fetchMultiplier)
    ? Math.max(1, options.fetchMultiplier)
    : 3
  const fetchLimit = Math.min(Math.max(Math.ceil(bounded * fetchMultiplier), bounded + 4), 60)
  const params = new URLSearchParams({
    q: query,
    query_by: "embedding,observation",
    vector_query: "embedding:([], alpha: 0.7)",
    per_page: String(fetchLimit),
    exclude_fields: "embedding",
  })
  if (options?.filterBy) {
    params.set("filter_by", options.filterBy)
  }

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/memory_observations/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Typesense search failed (${resp.status}): ${text}`)
  }

  const data = await resp.json() as { found: number; hits: TypesenseHit[] }
  return { hits: data.hits ?? [], found: data.found ?? 0 }
}

const query = Args.text({ name: "query" })
const limit = Options.integer("limit").pipe(Options.withDefault(5))
const minScore = Options.float("min-score").pipe(Options.withDefault(0))
const raw = Options.boolean("raw").pipe(Options.withDefault(false))
const includeHold = Options.boolean("include-hold").pipe(Options.withDefault(false))
const includeDiscard = Options.boolean("include-discard").pipe(Options.withDefault(false))
const budget = Options.text("budget").pipe(Options.withDefault("auto"))
const category = Options.text("category").pipe(Options.withDefault(""))

export const recallCmd = Command.make(
  "recall",
  { query, limit, minScore, raw, includeHold, includeDiscard, budget, category },
  ({ query, limit, minScore, raw, includeHold, includeDiscard, budget, category }) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const budgetPlan = resolveBudgetPlan(budget, query)
      const resolvedCategory = normalizeCategoryFilter(category)
      const categoryFilterBy = resolvedCategory ? `category_id:=${resolvedCategory}` : undefined
      const rewrite = yield* Effect.promise(() => runRewriteQueryWith(query, {
        rewriteEnabled: budgetPlan.rewriteEnabled,
      }))

      yield* Effect.promise(() => traceRecallRewrite({
        query,
        rewritePrompt: rewrite.rewritePrompt,
        rewrittenQuery: rewrite.rewrittenQuery,
        rewritten: rewrite.rewritten,
        strategy: rewrite.strategy,
        provider: rewrite.provider,
        model: rewrite.model,
        usage: rewrite.usage,
        durationMs: rewrite.durationMs,
        error: rewrite.error,
        budgetRequested: budgetPlan.requested,
        budgetApplied: budgetPlan.applied,
        budgetReason: budgetPlan.reason,
      }))

      try {
        const apiKey = resolveTypesenseApiKey()
        yield* Effect.promise(() => emitRecallOtel({
          level: "debug",
          action: "memory.recall.started",
          success: true,
          metadata: {
            query,
            rewrittenQuery: rewrite.rewrittenQuery,
            rewriteStrategy: rewrite.strategy,
            rewriteModel: rewrite.model,
            rewriteProvider: rewrite.provider,
            rewriteUsage: rewrite.usage,
            rewriteDurationMs: rewrite.durationMs,
            rewriteError: rewrite.error,
            includeHold,
            includeDiscard,
            categoryInput: category,
            categoryResolved: resolvedCategory,
            categoryFilterBy: categoryFilterBy ?? null,
            budgetRequested: budgetPlan.requested,
            budgetApplied: budgetPlan.applied,
            budget_profile: budgetPlan.applied,
            budgetReason: budgetPlan.reason,
          },
        }))

        let categoryFilterApplied = Boolean(categoryFilterBy)
        let categoryFilterReason = categoryFilterBy ? "applied" : "none"

        const result = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await searchTypesense(rewrite.rewrittenQuery, limit, apiKey, {
                fetchMultiplier: budgetPlan.fetchMultiplier,
                filterBy: categoryFilterBy,
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (categoryFilterBy && /filter field named `category_id`/iu.test(message)) {
                categoryFilterApplied = false
                categoryFilterReason = "schema_missing_fallback"
                return await searchTypesense(rewrite.rewrittenQuery, limit, apiKey, {
                  fetchMultiplier: budgetPlan.fetchMultiplier,
                })
              }
              throw error
            }
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })

        const ranked = rankHits(result.hits)
        const trust = trustPassFilter(ranked, Math.max(0, minScore), {
          includeHold,
          includeDiscard,
        })
        if (categoryFilterBy && categoryFilterApplied) {
          trust.filtersApplied.push("category-filter")
        }
        if (categoryFilterBy && !categoryFilterApplied) {
          trust.filtersApplied.push("category-filter-fallback")
        }
        const cappedLimit = Math.min(Math.max(limit, 1), budgetPlan.maxInject, MAX_INJECT)
        const finalHits = trust.kept.slice(0, cappedLimit)

        yield* Effect.promise(() => emitRecallOtel({
          level: "info",
          action: "memory.recall.completed",
          success: true,
          durationMs: Date.now() - startedAt,
          metadata: {
            query,
            rewrittenQuery: rewrite.rewrittenQuery,
            rewriteStrategy: rewrite.strategy,
            rewriteModel: rewrite.model,
            rewriteProvider: rewrite.provider,
            rewriteUsage: rewrite.usage,
            rewriteDurationMs: rewrite.durationMs,
            filtersApplied: trust.filtersApplied,
            droppedByTrustPass: trust.dropped.length,
            includeHold,
            includeDiscard,
            categoryInput: category,
            categoryResolved: resolvedCategory,
            categoryFilterBy: categoryFilterBy ?? null,
            categoryFilterApplied,
            categoryFilterReason,
            budgetRequested: budgetPlan.requested,
            budgetApplied: budgetPlan.applied,
            budget_profile: budgetPlan.applied,
            budgetReason: budgetPlan.reason,
            found: result.found,
            returned: finalHits.length,
          },
        }))

        if (raw) {
          const lines = finalHits.map((h) => h.document.observation)
          yield* Console.log(lines.join("\n"))
          return
        }

        yield* Console.log(
          respond("recall", {
            query,
            rewrittenQuery: rewrite.rewrittenQuery,
            rewrite: {
              rewritten: rewrite.rewritten,
              strategy: rewrite.strategy,
              model: rewrite.model,
              provider: rewrite.provider,
              usage: rewrite.usage,
              durationMs: rewrite.durationMs,
              error: rewrite.error,
            },
            filtersApplied: trust.filtersApplied,
            includeHold,
            includeDiscard,
            categoryFilter: {
              input: category,
              resolved: resolvedCategory,
              queryFilter: categoryFilterBy ?? null,
              applied: categoryFilterApplied,
              reason: categoryFilterReason,
            },
            budget: {
              requested: budgetPlan.requested,
              applied: budgetPlan.applied,
              reason: budgetPlan.reason,
              fetchMultiplier: budgetPlan.fetchMultiplier,
              maxInject: budgetPlan.maxInject,
              rewriteEnabled: budgetPlan.rewriteEnabled,
            },
            droppedByTrustPass: trust.dropped.length,
            droppedDiagnostics: trust.dropped.slice(0, 10),
            hits: finalHits.map((h) => ({
              id: h.document.id,
              score: h.decayedScore,
              rawScore: h.score,
              usageBoost: h.usageBoost,
              observation: h.document.observation,
              type: h.document.observation_type || "unknown",
              source: h.document.source || "unknown",
              writeVerdict: h.document.write_verdict || "allow",
              categoryId: h.document.category_id || "unknown",
              categoryConfidence: asFiniteNumber(h.document.category_confidence, 0),
              categorySource: h.document.category_source || "unknown",
              taxonomyVersion: h.document.taxonomy_version || "unknown",
              session: h.document.session_id || "unknown",
              timestamp: toIsoTimestamp(h.document.timestamp) || "unknown",
              recallCount: asFiniteNumber(h.document.recall_count, 0),
              retrievalPriority: asFiniteNumber(h.document.retrieval_priority, 0),
            })),
            count: finalHits.length,
            found: result.found,
            backend: "typesense",
          }, [
            {
              command: `joelclaw recall "${query}" --limit 10`,
              description: "Get more results",
            },
            {
              command: `joelclaw search "${query}"`,
              description: "Search all collections (vault, blog, slog too)",
            },
            {
              command: `joelclaw recall "${query}" --raw`,
              description: "Raw observations for injection",
            },
            {
              command: `joelclaw recall "${query}" --budget deep --limit 10`,
              description: "Run deeper retrieval for difficult queries",
            },
            {
              command: `joelclaw recall "${query}" --category jc:memory-system --limit 10`,
              description: "Constrain retrieval to a specific memory category",
            },
          ])
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield* Effect.promise(() => emitRecallOtel({
          level: "error",
          action: "memory.recall.failed",
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          metadata: {
            query,
            rewrittenQuery: rewrite.rewrittenQuery,
            rewriteStrategy: rewrite.strategy,
            rewriteModel: rewrite.model,
            rewriteProvider: rewrite.provider,
            rewriteUsage: rewrite.usage,
            rewriteDurationMs: rewrite.durationMs,
            includeHold,
            includeDiscard,
            categoryInput: category,
            categoryResolved: resolvedCategory,
            categoryFilterBy: categoryFilterBy ?? null,
            budgetRequested: budgetPlan.requested,
            budgetApplied: budgetPlan.applied,
            budget_profile: budgetPlan.applied,
            budgetReason: budgetPlan.reason,
          },
        }))

        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "recall",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }

        if (message.includes("Typesense") || message.includes("Connection refused") || message.includes("ECONNREFUSED")) {
          yield* Console.log(respondError(
            "recall", message, "TYPESENSE_UNREACHABLE",
            "kubectl port-forward -n joelclaw svc/typesense 8108:8108 &",
            [{ command: "joelclaw status", description: "Check all services" }]
          ))
          return
        }

        yield* Console.log(respondError(
          "recall", message, "UNKNOWN",
          "Check Typesense (localhost:8108)",
          [{ command: "joelclaw status", description: "Check all services" }]
        ))
      }
    })
)

export const __recallTestUtils = {
  normalizeQuery,
  sanitizeRewriteResult,
  applyScoreDecay,
  rankHits,
  trustPassFilter,
  runRewriteQueryWith,
}
