import { typesenseRecallAdapter as legacyTypesenseRecallAdapter } from "@joelclaw/sdk"
import { Effect } from "effect"
import { searchCriticalDb } from "../../lib/critical-search"
import type { AnyCapabilityPort } from "../contract"

export { __recallTestUtils } from "@joelclaw/sdk"

type RecallArgs = {
  query: string
  limit: number
  minScore: number
  raw: boolean
  includeHold: boolean
  includeDiscard: boolean
  budget: string
  category: string
}

type RecallResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

function sqliteRecall(args: RecallArgs): RecallResult {
  const result = searchCriticalDb({
    query: args.query,
    limit: Math.min(Math.max(args.limit * 3, args.limit), 60),
  })
  const category = args.category.trim().toLowerCase()
  const filtered = result.hits.filter((hit) => {
    const verdict = typeof hit.payload?.write_verdict === "string" ? hit.payload.write_verdict : "allow"
    if (verdict === "hold" && !args.includeHold) return false
    if (verdict === "discard" && !args.includeDiscard) return false
    if (category && category !== "all") {
      const categoryId = typeof hit.payload?.category_id === "string" ? hit.payload.category_id.toLowerCase() : ""
      if (categoryId && categoryId !== category) return false
    }
    return hit.score >= Math.max(0, args.minScore)
  }).slice(0, Math.min(Math.max(args.limit, 1), 20))

  if (args.raw) {
    return { raw: true, text: filtered.map((hit) => hit.content).join("\n") }
  }

  return {
    raw: false,
    payload: {
      query: args.query,
      rewrittenQuery: args.query,
      rewrite: {
        rewritten: false,
        strategy: "sqlite-fts5",
        reason: "sqlite_exact_query",
      },
      filtersApplied: ["sqlite-first", ...(category ? ["category-best-effort"] : [])],
      includeHold: args.includeHold,
      includeDiscard: args.includeDiscard,
      categoryFilter: {
        input: args.category,
        resolved: category || null,
        applied: Boolean(category),
        reason: category ? "payload_category_id_when_present" : "none",
      },
      budget: {
        requested: args.budget,
        applied: "sqlite-fts5",
        rewriteEnabled: false,
      },
      queryContract: {
        tokenMatching: "OR token-drop approximation",
        ranking: "SQLite FTS5 BM25; scores are not comparable with Typesense",
        rewrite: "disabled on the critical availability path",
        trustFilters: "hold, discard, and category filters retained when payload fields exist",
        collections: "observations, memory_observations, brain_pages, system_knowledge, vault_notes",
      },
      droppedByTrustPass: result.hits.length - filtered.length,
      hits: filtered.map((hit) => ({
        id: hit.id,
        score: hit.score,
        rawScore: hit.rank,
        usageBoost: 0,
        observation: hit.snippet,
        type: hit.type,
        source: hit.source,
        collection: hit.collection,
        writeVerdict: typeof hit.payload?.write_verdict === "string" ? hit.payload.write_verdict : "allow",
        categoryId: typeof hit.payload?.category_id === "string" ? hit.payload.category_id : "unknown",
        categoryConfidence: typeof hit.payload?.category_confidence === "number" ? hit.payload.category_confidence : 0,
        privacy: hit.privacy ?? "private",
        path: hit.path,
        observerRunId: hit.runId,
        observerRunReference: hit.runId
          ? { kind: "source-label", value: hit.runId, resolvableInRunsDev: false }
          : undefined,
        sourceFreshness: hit.sourceFreshness,
        session: hit.sessionId ?? "unknown",
        timestamp: hit.createdAt ? new Date(hit.createdAt * 1_000).toISOString() : "unknown",
        title: hit.title,
      })),
      count: filtered.length,
      found: result.found,
      backend: "sqlite-fts5",
      freshness: result.freshness,
      queryDurationMs: result.durationMs,
      dbPath: result.dbPath,
    },
  }
}

const legacy = legacyTypesenseRecallAdapter as AnyCapabilityPort

export const __sqliteRecallTestUtils = { sqliteRecall }

/** SQLite-first recall with the existing Typesense adapter retained as an availability fallback. */
export const typesenseRecallAdapter: AnyCapabilityPort = {
  ...legacy,
  execute(subcommand, rawArgs, context) {
    if (subcommand !== "query") return legacy.execute(subcommand, rawArgs, context)
    return Effect.try({
      try: () => sqliteRecall(rawArgs as RecallArgs),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((sqliteError) => legacy.execute(subcommand, rawArgs, context).pipe(
        Effect.map((fallback) => {
          const value = fallback as RecallResult
          if (!value.payload) return value
          return {
            ...value,
            payload: {
              ...value.payload,
              fallback: {
                from: "sqlite-fts5",
                to: "typesense",
                reason: sqliteError instanceof Error ? sqliteError.message : "critical.db unavailable or unreadable",
              },
              freshness: {
                status: "unavailable",
                detail: "critical.db unavailable or unreadable",
              },
            },
          }
        }),
      )),
    )
  },
}
