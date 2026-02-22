// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Migrated from Qdrant+embed.py (Qdrant fully retired 2026-02-22) to Typesense with built-in auto-embedding.
// ADR-0077 Workstream 1/2: query rewrite + trust pass + usage-signal-aware ranking.
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const OTEL_INGEST_URL = process.env.JOELCLAW_OTEL_INGEST_URL || "http://localhost:3111/observability/emit"
const OTEL_INGEST_TOKEN = process.env.OTEL_EMIT_TOKEN?.trim()
const MAX_INJECT = 10
const DECAY_CONSTANT = 0.01
const STALENESS_DAYS = 90
const MIN_OBSERVATION_CHARS = 12
const REWRITE_TIMEOUT_MS = 20_000
const RECALL_OTEL_ENABLED = (process.env.JOELCLAW_RECALL_OTEL ?? "1") !== "0"
const RECALL_REWRITE_ENABLED = (process.env.JOELCLAW_RECALL_REWRITE ?? "1") !== "0"

type RewriteStrategy = "haiku" | "openai" | "fallback" | "disabled"

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

type RewrittenQuery = {
  inputQuery: string
  rewrittenQuery: string
  rewritten: boolean
  strategy: RewriteStrategy
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
  minScore: number
): { kept: RankedRecallHit[]; dropped: TrustPassDroppedHit[]; filtersApplied: string[] } {
  const dropped: TrustPassDroppedHit[] = []
  const kept: RankedRecallHit[] = []
  const filtersApplied = ["score-decay", "usage-signal", "inject-cap"] as string[]

  for (const hit of hits) {
    const reasons: string[] = []
    const observation = hit.document.observation?.trim() ?? ""
    const recallCount = Math.max(0, asFiniteNumber(hit.document.recall_count, 0))
    const ageDays = toAgeDays(hit.document.timestamp)

    if (observation.length < MIN_OBSERVATION_CHARS) reasons.push("too_short")
    if (hit.document.stale === true) reasons.push("stale_tagged")
    if (ageDays > STALENESS_DAYS && recallCount <= 0) reasons.push("stale_age")
    if (!Number.isFinite(hit.decayedScore) || hit.decayedScore <= 0) reasons.push("invalid_score")
    if (hit.decayedScore < minScore) reasons.push("below_min_score")

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

function runRewriteQueryWith(query: string, options: RewriteRunnerOptions = {}): RewrittenQuery {
  const normalized = normalizeQuery(query)
  const rewriteEnabled = options.rewriteEnabled ?? RECALL_REWRITE_ENABLED
  if (!rewriteEnabled || normalized.length < 4) {
    return {
      inputQuery: normalized,
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

  const timeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS

  const models: Array<{ model: string; strategy: RewriteStrategy }> = [
    { model: "anthropic/claude-haiku", strategy: "haiku" },
    { model: "openai/gpt-5.3-codex-spark", strategy: "openai" },
  ]

  let lastError = ""
  for (const { model, strategy } of models) {
    try {
      const args = [
        "pi",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--print",
        "--mode",
        "text",
        "--model",
        model,
        rewritePrompt,
      ]
      const proc = options.spawn
        ? options.spawn(args, rewritePrompt, timeoutMs)
        : Bun.spawnSync(args, {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            timeout: timeoutMs,
            env: { ...process.env, TERM: "dumb" },
          })

      const stdout = sanitizeRewriteResult(readShellText(proc.stdout))
      const stderr = readShellText(proc.stderr).trim()
      const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : -1
      if (exitCode === 0 && stdout.length > 0) {
        return {
          inputQuery: normalized,
          rewrittenQuery: stdout,
          rewritten: stdout.toLowerCase() !== normalized.toLowerCase(),
          strategy,
        }
      }
      lastError = (stderr || `rewrite_exit_${exitCode}`).slice(0, 220)
    } catch (error) {
      lastError = (error instanceof Error ? error.message : String(error)).slice(0, 220)
    }
  }

  return {
    inputQuery: normalized,
    rewrittenQuery: normalized,
    rewritten: false,
    strategy: "fallback",
    error: lastError,
  }
}

function runRewriteQuery(query: string): RewrittenQuery {
  return runRewriteQueryWith(query)
}

/** Hybrid semantic+keyword search over memory_observations */
async function searchTypesense(
  query: string,
  limit: number,
  apiKey: string,
): Promise<{ hits: TypesenseHit[]; found: number }> {
  const bounded = Math.min(Math.max(limit, 1), MAX_INJECT)
  const fetchLimit = Math.min(Math.max(bounded * 3, bounded + 4), 40)
  const params = new URLSearchParams({
    q: query,
    query_by: "embedding,observation",
    vector_query: "embedding:([], alpha: 0.7)",
    per_page: String(fetchLimit),
    exclude_fields: "embedding",
  })

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

export const recallCmd = Command.make(
  "recall",
  { query, limit, minScore, raw },
  ({ query, limit, minScore, raw }) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const rewrite = runRewriteQuery(query)

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
            rewriteError: rewrite.error,
          },
        }))

        const result = yield* Effect.promise(() =>
          searchTypesense(rewrite.rewrittenQuery, limit, apiKey)
        )

        const ranked = rankHits(result.hits)
        const trust = trustPassFilter(ranked, Math.max(0, minScore))
        const cappedLimit = Math.min(Math.max(limit, 1), MAX_INJECT)
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
            filtersApplied: trust.filtersApplied,
            droppedByTrustPass: trust.dropped.length,
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
              error: rewrite.error,
            },
            filtersApplied: trust.filtersApplied,
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
