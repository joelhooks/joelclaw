// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Migrated from Qdrant+embed.py (Qdrant fully retired 2026-02-22) to Typesense with built-in auto-embedding.
// ADR-0077 Workstream 1/2: query rewrite + trust pass + usage-signal-aware ranking.

import { Effect, Schema } from "effect"
import { traceRecallRewrite } from "../../lib/langfuse"
import { createOtelEventPayload, ingestOtelPayload } from "../../lib/otel-ingest"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../../lib/typesense-auth"
import { type CapabilityPort, capabilityError } from "../contract"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const MAX_INJECT = 10
const DECAY_CONSTANT = 0.01
const STALENESS_DAYS = 90
const MIN_OBSERVATION_CHARS = 12
// ADR-0192: Bumped default from 2s to 6s. Pi cold-start on M4 Pro is ~3-4s,
// so 2s guaranteed timeout on every first invocation. 6s gives enough headroom
// for cold start + Haiku inference while the circuit breaker catches persistent failures.
const REWRITE_TIMEOUT_MS = Number(process.env.JOELCLAW_RECALL_REWRITE_TIMEOUT) || 6_000
const RECALL_REWRITE_MODEL = process.env.JOELCLAW_RECALL_REWRITE_MODEL?.trim() || "anthropic/claude-haiku-4-5"
const RECALL_OTEL_ENABLED = (process.env.JOELCLAW_RECALL_OTEL ?? "1") !== "0"
const RECALL_REWRITE_ENABLED = (process.env.JOELCLAW_RECALL_REWRITE ?? "1") !== "0"

type InferenceResult = {
  text: string
  data?: unknown
  provider?: string
  model?: string
  usage?: unknown
}

async function runInference(prompt: string, options: Record<string, unknown>): Promise<InferenceResult> {
  const { spawn } = await import("node:child_process")

  const timeoutRaw = options.timeout
  const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
    ? Math.max(1_000, Math.min(timeoutRaw, 10 * 60 * 1_000))
    : REWRITE_TIMEOUT_MS

  const model = typeof options.model === "string" ? options.model.trim() : ""
  const systemPrompt = typeof options.system === "string" ? options.system.trim() : ""
  const shouldPrint = options.print !== false

  const home = process.env.HOME ?? ""
  const pathSegments = [
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.bun/bin` : "",
    process.env.PATH ?? "",
  ].filter(Boolean)

  const args = ["-p", "--no-session", "--no-extensions"]
  if (shouldPrint) args.push("--print")
  if (model) args.push("--models", model)
  if (systemPrompt) args.push("--system-prompt", systemPrompt)

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>((resolve, reject) => {
    const child = spawn("pi", args, {
      env: {
        ...process.env,
        PATH: pathSegments.join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timeoutId = setTimeout(() => {
      if (settled) return
      child.kill("SIGKILL")
      settled = true
      resolve({ stdout, stderr, exitCode: -1 })
    }, timeoutMs)

    function settleWith(result: { stdout: string; stderr: string; exitCode: number }): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(result)
    }

    function settleError(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      reject(error)
    }

    child.stdout?.on("data", (chunk: unknown) => {
      stdout += readShellText(chunk)
    })

    child.stderr?.on("data", (chunk: unknown) => {
      stderr += readShellText(chunk)
    })

    child.on("error", settleError)

    child.on("close", (code) => {
      settleWith({ stdout, stderr, exitCode: typeof code === "number" ? code : -1 })
    })

    child.stdin?.write(prompt)
    child.stdin?.end()
  })

  if (exitCode !== 0) {
    const errorText = sanitizeRewriteResult(stderr) || `rewrite_exit_${exitCode}`
    throw new Error(errorText)
  }

  const parsed = parsePiRewriteJsonOutput(stdout)
  const rewrittenQuery = parsed?.rewrittenQuery ?? sanitizeRewriteResult(stdout)
  if (!rewrittenQuery) {
    throw new Error("inference_rewrite_empty")
  }

  return {
    text: rewrittenQuery,
    data: parsed ? { rewrittenQuery: parsed.rewrittenQuery } : rewrittenQuery,
    provider: parsed?.provider,
    model: parsed?.model ?? (model || undefined),
    usage: parsed?.usage,
  }
}

// ── ADR-0192 V2: Rewrite circuit breaker ────────────────────────
// Track consecutive rewrite failures. After CIRCUIT_OPEN_THRESHOLD
// consecutive failures, open the circuit and skip rewrite entirely.
// After CIRCUIT_COOLDOWN_MS, allow one probe (half-open). If it
// succeeds, close circuit; if it fails, re-open.
//
// State persisted to a temp file so it survives across CLI invocations
// (each `joelclaw` run is a fresh process).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const CIRCUIT_OPEN_THRESHOLD = 3
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

type CircuitState = "closed" | "open" | "half-open"

type CircuitData = {
  state: CircuitState
  consecutiveFailures: number
  lastFailureTs: number
  lastOpenTs: number
  totalOpens: number
}

const CIRCUIT_STATE_DIR = join(process.env.HOME || "/tmp", ".joelclaw", "state")
const CIRCUIT_STATE_FILE = join(CIRCUIT_STATE_DIR, "recall-rewrite-circuit.json")

function loadCircuitState(): CircuitData {
  try {
    if (!existsSync(CIRCUIT_STATE_FILE)) {
      return { state: "closed", consecutiveFailures: 0, lastFailureTs: 0, lastOpenTs: 0, totalOpens: 0 }
    }
    const raw = readFileSync(CIRCUIT_STATE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Partial<CircuitData>
    return {
      state: (parsed.state === "open" || parsed.state === "half-open") ? parsed.state : "closed",
      consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
      lastFailureTs: typeof parsed.lastFailureTs === "number" ? parsed.lastFailureTs : 0,
      lastOpenTs: typeof parsed.lastOpenTs === "number" ? parsed.lastOpenTs : 0,
      totalOpens: typeof parsed.totalOpens === "number" ? parsed.totalOpens : 0,
    }
  } catch {
    return { state: "closed", consecutiveFailures: 0, lastFailureTs: 0, lastOpenTs: 0, totalOpens: 0 }
  }
}

function saveCircuitState(data: CircuitData): void {
  try {
    mkdirSync(CIRCUIT_STATE_DIR, { recursive: true })
    writeFileSync(CIRCUIT_STATE_FILE, JSON.stringify(data), "utf-8")
  } catch {
    // Best-effort persistence — don't crash recall on write failure
  }
}

let rewriteCircuit: CircuitData = loadCircuitState()

function circuitShouldSkip(): { skip: boolean; reason: string } {
  // Reload from disk on each check (cross-process coordination)
  rewriteCircuit = loadCircuitState()

  if (rewriteCircuit.state === "closed") return { skip: false, reason: "" }

  const elapsed = Date.now() - rewriteCircuit.lastOpenTs
  if (rewriteCircuit.state === "open" && elapsed >= CIRCUIT_COOLDOWN_MS) {
    rewriteCircuit.state = "half-open"
    saveCircuitState(rewriteCircuit)
    return { skip: false, reason: "half-open probe" }
  }

  if (rewriteCircuit.state === "open") {
    return { skip: true, reason: `circuit_open (${rewriteCircuit.consecutiveFailures} consecutive failures, ${Math.round(elapsed / 1000)}s/${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s cooldown)` }
  }

  // half-open: let one through
  return { skip: false, reason: "" }
}

function circuitRecordSuccess(): void {
  rewriteCircuit.state = "closed"
  rewriteCircuit.consecutiveFailures = 0
  saveCircuitState(rewriteCircuit)
}

function circuitRecordFailure(): void {
  rewriteCircuit.consecutiveFailures++
  rewriteCircuit.lastFailureTs = Date.now()
  if (rewriteCircuit.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
    rewriteCircuit.state = "open"
    rewriteCircuit.lastOpenTs = Date.now()
    rewriteCircuit.totalOpens++
  }
  saveCircuitState(rewriteCircuit)
}

// ── ADR-0192 V3: Rewrite result cache ──────────────────────────
// File-persisted cache keyed on normalized query.
// Avoids redundant LLM calls for identical queries across CLI invocations.
const REWRITE_CACHE_TTL_MS = 3 * 60 * 1000 // 3 minutes
const REWRITE_CACHE_MAX_SIZE = 50
const REWRITE_CACHE_FILE = join(CIRCUIT_STATE_DIR, "recall-rewrite-cache.json")

type RewriteCacheEntry = {
  rewrittenQuery: string
  strategy: RewriteStrategy
  model?: string
  provider?: string
  cachedAt: number
}

type CacheStore = Record<string, RewriteCacheEntry>

const rewriteCache = new Map<string, RewriteCacheEntry>()

function loadCache(): void {
  try {
    if (!existsSync(REWRITE_CACHE_FILE)) return
    const raw = readFileSync(REWRITE_CACHE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as CacheStore
    const now = Date.now()
    rewriteCache.clear()
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.cachedAt === "number" && now - entry.cachedAt <= REWRITE_CACHE_TTL_MS) {
        rewriteCache.set(key, entry)
      }
    }
  } catch {
    // Best-effort — don't crash on corrupt cache
  }
}

function saveCache(): void {
  try {
    mkdirSync(CIRCUIT_STATE_DIR, { recursive: true })
    const obj: CacheStore = {}
    for (const [key, entry] of rewriteCache) {
      obj[key] = entry
    }
    writeFileSync(REWRITE_CACHE_FILE, JSON.stringify(obj), "utf-8")
  } catch {
    // Best-effort persistence
  }
}

// Load cache on module init
loadCache()

function cacheGet(normalizedQuery: string): RewriteCacheEntry | null {
  const entry = rewriteCache.get(normalizedQuery)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > REWRITE_CACHE_TTL_MS) {
    rewriteCache.delete(normalizedQuery)
    saveCache()
    return null
  }
  return entry
}

function cacheSet(normalizedQuery: string, entry: Omit<RewriteCacheEntry, "cachedAt">): void {
  // Evict oldest if at capacity
  if (rewriteCache.size >= REWRITE_CACHE_MAX_SIZE) {
    const oldest = rewriteCache.keys().next().value
    if (oldest) rewriteCache.delete(oldest)
  }
  rewriteCache.set(normalizedQuery, { ...entry, cachedAt: Date.now() })
  saveCache()
}

type RewriteStrategy = "haiku" | "openai" | "fallback" | "disabled" | "skipped"
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
  rewriteReason: string
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

function detectRewriteSkipReason(query: string): string | null {
  if (!query) return "skip.empty_query"

  const tokenCount = query.split(/\s+/gu).filter(Boolean).length
  if (query.length <= 24 && tokenCount <= 3) {
    return "skip.short_query"
  }

  if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
    return "skip.literal_query"
  }

  if (/^[\w./:-]+$/u.test(query) && /[/:.]/u.test(query)) {
    return "skip.direct_identifier"
  }

  if (/^(show|find|list|get|open)\b/iu.test(query)) {
    return "skip.command_like"
  }

  return null
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

function normalizeFromUnknownString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const sanitized = sanitizeRewriteResult(value)
  return sanitized.length > 0 ? sanitized : null
}

function parseInferenceRewriteOutput(data: unknown, fallbackText: string): string | null {
  const directText = normalizeFromUnknownString(data)
  if (directText) return directText

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const parsed = data as Record<string, unknown>
    const candidateValues = [
      parsed.rewrittenQuery,
      parsed.rewritten_query,
      parsed.query,
      parsed.text,
      parsed.output,
    ]

    for (const candidate of candidateValues) {
      const candidateText = normalizeFromUnknownString(candidate)
      if (candidateText) return candidateText
    }
  }

  return normalizeFromUnknownString(fallbackText) ?? null
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

  const payload = createOtelEventPayload({
    level: input.level,
    source: "cli",
    component: "recall-cli",
    action: input.action,
    success: input.success,
    durationMs: input.durationMs,
    error: input.error,
    metadata: input.metadata,
  })

  await ingestOtelPayload(payload, { timeoutMs: 1500 })
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
      rewriteReason: "disabled",
    }
  }

  const skipReason = detectRewriteSkipReason(normalized)
  if (skipReason) {
    return {
      inputQuery: normalized,
      rewritePrompt: normalized,
      rewrittenQuery: normalized,
      rewritten: false,
      strategy: "skipped",
      rewriteReason: skipReason,
    }
  }

  // ADR-0192 V2: Circuit breaker check
  const circuitCheck = circuitShouldSkip()
  if (circuitCheck.skip) {
    return {
      inputQuery: normalized,
      rewritePrompt: normalized,
      rewrittenQuery: normalized,
      rewritten: false,
      strategy: "skipped",
      rewriteReason: `circuit_open`,
      error: circuitCheck.reason,
    }
  }

  // ADR-0192 V3: Cache lookup
  const cached = cacheGet(normalized)
  if (cached) {
    return {
      inputQuery: normalized,
      rewritePrompt: normalized,
      rewrittenQuery: cached.rewrittenQuery,
      rewritten: cached.rewrittenQuery.toLowerCase() !== normalized.toLowerCase(),
      strategy: cached.strategy,
      rewriteReason: "cache_hit",
      model: cached.model,
      provider: cached.provider,
      durationMs: 0,
    }
  }

  const context = options.context ?? process.env.JOELCLAW_RECALL_CONTEXT?.trim()
  const rewritePrompt = [
    "Rewrite the memory recall query for semantic retrieval.",
    "Return ONLY the rewritten query text.",
    `Original query: ${normalized}`,
    context ? `Recent context: ${context}` : "",
  ].filter(Boolean).join("\n")

  const rewriteTimeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS
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

  function toFailureReasonTag(value: string): string {
    const normalizedReason = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 80)
    return normalizedReason || "rewrite_failed"
  }

  async function runSpawnRewrite(): Promise<RewrittenQuery> {
    if (options.spawn) {
      const proc = options.spawn([], rewritePrompt, rewriteTimeoutMs)
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
          rewriteReason: "success",
          provider: parsedJson?.provider,
          model: parsedJson?.model ?? RECALL_REWRITE_MODEL,
          usage: parsedJson?.usage,
          durationMs: Date.now() - startedAt,
        }
      }

      throw new Error(stderr || `rewrite_exit_${exitCode}`)
    }

    throw new Error("spawn_rewrite_not_enabled")
  }

  async function runRouterRewrite(): Promise<RewrittenQuery> {
    const result = await runInference(rewritePrompt, {
      task: "rewrite",
      model: RECALL_REWRITE_MODEL,
      print: true,
      system: "Rewrite the memory recall query for semantic retrieval. Return only the rewritten query text.",
      component: "recall-cli",
      action: "recall.rewrite",
      timeout: rewriteTimeoutMs,
      json: true,
      requireJson: true,
      requireTextOutput: true,
    })

    const rewrittenQuery = parseInferenceRewriteOutput(result.data, result.text)
    if (!rewrittenQuery) {
      throw new Error("inference_rewrite_empty")
    }

    const strategy = result.provider?.toLowerCase().includes("openai") ? "openai" : "haiku"

    return {
      inputQuery: normalized,
      rewritePrompt,
      rewrittenQuery,
      rewritten: rewrittenQuery.toLowerCase() !== normalized.toLowerCase(),
      strategy,
      rewriteReason: "success",
      provider: result.provider,
      model: result.model ?? RECALL_REWRITE_MODEL,
      usage: result.usage,
      durationMs: Date.now() - startedAt,
    }
  }

  try {
    let result: RewrittenQuery
    if (options.spawn) {
      result = await runSpawnRewrite()
    } else {
      result = await runRouterRewrite()
    }

    // ADR-0192 V2: Record success → close circuit
    circuitRecordSuccess()

    // ADR-0192 V3: Cache successful rewrite
    if (result.rewritten && result.rewrittenQuery.length > 0) {
      cacheSet(normalized, {
        rewrittenQuery: result.rewrittenQuery,
        strategy: result.strategy,
        model: result.model,
        provider: result.provider,
      })
    }

    return result
  } catch (error) {
    attemptErrors.push(formatRewriteError(error, rewriteTimeoutMs))

    // ADR-0192 V2: Record failure → may open circuit
    circuitRecordFailure()
  }

  const lastError = attemptErrors[attemptErrors.length - 1] ?? "rewrite_failed"

  return {
    inputQuery: normalized,
    rewritePrompt,
    rewrittenQuery: normalized,
    rewritten: false,
    strategy: "fallback",
    rewriteReason: `failure.${toFailureReasonTag(lastError)}`,
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

type RecallCapabilityArgs = {
  query: string
  limit: number
  minScore: number
  raw: boolean
  includeHold: boolean
  includeDiscard: boolean
  budget: string
  category: string
}

type RecallCapabilityResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

const RecallQueryArgsSchema = Schema.Struct({
  query: Schema.String,
  limit: Schema.Number,
  minScore: Schema.Number,
  raw: Schema.Boolean,
  includeHold: Schema.Boolean,
  includeDiscard: Schema.Boolean,
  budget: Schema.String,
  category: Schema.String,
})

const RecallQueryResultSchema = Schema.Struct({
  raw: Schema.Boolean,
  text: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
})

const commands = {
  query: {
    summary: "Recall semantic memory from Typesense",
    argsSchema: RecallQueryArgsSchema,
    resultSchema: RecallQueryResultSchema,
  },
} as const

type RecallCommandName = keyof typeof commands

function decodeArgs<K extends RecallCommandName>(
  subcommand: K,
  args: unknown
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "RECALL_INVALID_ARGS",
        Schema.formatIssueSync(error),
        "Check `joelclaw recall --help` for valid options."
      )
    )
  )
}

function runRecallCapability(args: RecallCapabilityArgs): Effect.Effect<RecallCapabilityResult, ReturnType<typeof capabilityError>> {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    const budgetPlan = resolveBudgetPlan(args.budget, args.query)
    const resolvedCategory = normalizeCategoryFilter(args.category)
    const categoryFilterBy = resolvedCategory ? `category_id:=${resolvedCategory}` : undefined
    const rewrite = yield* Effect.promise(() => runRewriteQueryWith(args.query, {
      rewriteEnabled: budgetPlan.rewriteEnabled,
    }))

    yield* Effect.promise(() => traceRecallRewrite({
      query: args.query,
      rewritePrompt: rewrite.rewritePrompt,
      rewrittenQuery: rewrite.rewrittenQuery,
      rewritten: rewrite.rewritten,
      strategy: rewrite.strategy,
      rewriteReason: rewrite.rewriteReason,
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
          query: args.query,
          rewrittenQuery: rewrite.rewrittenQuery,
          rewriteStrategy: rewrite.strategy,
          rewriteReason: rewrite.rewriteReason,
          rewriteModel: rewrite.model,
          rewriteProvider: rewrite.provider,
          rewriteUsage: rewrite.usage,
          rewriteDurationMs: rewrite.durationMs,
          rewriteError: rewrite.error,
          includeHold: args.includeHold,
          includeDiscard: args.includeDiscard,
          categoryInput: args.category,
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
            return await searchTypesense(rewrite.rewrittenQuery, args.limit, apiKey, {
              fetchMultiplier: budgetPlan.fetchMultiplier,
              filterBy: categoryFilterBy,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (categoryFilterBy && /filter field named `category_id`/iu.test(message)) {
              categoryFilterApplied = false
              categoryFilterReason = "schema_missing_fallback"
              return await searchTypesense(rewrite.rewrittenQuery, args.limit, apiKey, {
                fetchMultiplier: budgetPlan.fetchMultiplier,
              })
            }
            throw error
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      const ranked = rankHits(result.hits)
      const trust = trustPassFilter(ranked, Math.max(0, args.minScore), {
        includeHold: args.includeHold,
        includeDiscard: args.includeDiscard,
      })
      if (categoryFilterBy && categoryFilterApplied) {
        trust.filtersApplied.push("category-filter")
      }
      if (categoryFilterBy && !categoryFilterApplied) {
        trust.filtersApplied.push("category-filter-fallback")
      }
      const cappedLimit = Math.min(Math.max(args.limit, 1), budgetPlan.maxInject, MAX_INJECT)
      const finalHits = trust.kept.slice(0, cappedLimit)

      yield* Effect.promise(() => emitRecallOtel({
        level: "info",
        action: "memory.recall.completed",
        success: true,
        durationMs: Date.now() - startedAt,
        metadata: {
          query: args.query,
          rewrittenQuery: rewrite.rewrittenQuery,
          rewriteStrategy: rewrite.strategy,
          rewriteReason: rewrite.rewriteReason,
          rewriteModel: rewrite.model,
          rewriteProvider: rewrite.provider,
          rewriteUsage: rewrite.usage,
          rewriteDurationMs: rewrite.durationMs,
          filtersApplied: trust.filtersApplied,
          droppedByTrustPass: trust.dropped.length,
          includeHold: args.includeHold,
          includeDiscard: args.includeDiscard,
          categoryInput: args.category,
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

      if (args.raw) {
        const lines = finalHits.map((h) => h.document.observation)
        return {
          raw: true,
          text: lines.join("\n"),
        }
      }

      return {
        raw: false,
        payload: {
          query: args.query,
          rewrittenQuery: rewrite.rewrittenQuery,
          rewrite: {
            rewritten: rewrite.rewritten,
            strategy: rewrite.strategy,
            reason: rewrite.rewriteReason,
            model: rewrite.model,
            provider: rewrite.provider,
            usage: rewrite.usage,
            durationMs: rewrite.durationMs,
            error: rewrite.error,
          },
          filtersApplied: trust.filtersApplied,
          includeHold: args.includeHold,
          includeDiscard: args.includeDiscard,
          categoryFilter: {
            input: args.category,
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
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield* Effect.promise(() => emitRecallOtel({
        level: "error",
        action: "memory.recall.failed",
        success: false,
        durationMs: Date.now() - startedAt,
        error: message,
        metadata: {
          query: args.query,
          rewrittenQuery: rewrite.rewrittenQuery,
          rewriteStrategy: rewrite.strategy,
          rewriteReason: rewrite.rewriteReason,
          rewriteModel: rewrite.model,
          rewriteProvider: rewrite.provider,
          rewriteUsage: rewrite.usage,
          rewriteDurationMs: rewrite.durationMs,
          includeHold: args.includeHold,
          includeDiscard: args.includeDiscard,
          categoryInput: args.category,
          categoryResolved: resolvedCategory,
          categoryFilterBy: categoryFilterBy ?? null,
          budgetRequested: budgetPlan.requested,
          budgetApplied: budgetPlan.applied,
          budget_profile: budgetPlan.applied,
          budgetReason: budgetPlan.reason,
        },
      }))

      if (isTypesenseApiKeyError(error)) {
        return yield* Effect.fail(
          capabilityError(error.code, error.message, error.fix)
        )
      }

      if (message.includes("Typesense") || message.includes("Connection refused") || message.includes("ECONNREFUSED")) {
        return yield* Effect.fail(
          capabilityError(
            "TYPESENSE_UNREACHABLE",
            message,
            "kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
          )
        )
      }

      return yield* Effect.fail(
        capabilityError(
          "UNKNOWN",
          message,
          "Check Typesense (localhost:8108)"
        )
      )
    }
  })
}

export const typesenseRecallAdapter: CapabilityPort<typeof commands> = {
  capability: "recall",
  adapter: "typesense-recall",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "query": {
          const args = yield* decodeArgs("query", rawArgs)
          return yield* runRecallCapability(args)
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "RECALL_SUBCOMMAND_UNSUPPORTED",
              `Unsupported recall subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __recallTestUtils = {
  normalizeQuery,
  sanitizeRewriteResult,
  applyScoreDecay,
  rankHits,
  trustPassFilter,
  runRewriteQueryWith,
  // ADR-0192 testing exports
  detectRewriteSkipReason,
  get rewriteCircuit() { return rewriteCircuit },
  resetCircuit() {
    rewriteCircuit = {
      state: "closed",
      consecutiveFailures: 0,
      lastFailureTs: 0,
      lastOpenTs: 0,
      totalOpens: 0,
    }
    rewriteCache.clear()
  },
  circuitShouldSkip,
  circuitRecordSuccess,
  circuitRecordFailure,
  cacheGet,
  cacheSet,
  get rewriteCache() { return rewriteCache },
}
