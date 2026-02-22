/**
 * joelclaw search — unified search across all Typesense collections.
 * ADR-0082: Typesense as unified search layer.
 *
 * Supports hybrid search (keyword + semantic), typo tolerance, faceting.
 * Searches vault_notes, memory_observations, blog_posts, system_log,
 * discoveries, voice_transcripts, and otel_events.
 */
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"

interface SearchHit {
  collection: string
  title: string
  snippet: string
  path?: string
  score?: number
  type?: string
}

type SearchCollection = {
  readonly name: string
  readonly queryBy: string
  readonly titleField: string
  readonly supportsSemantic: boolean
}

const COLLECTIONS: readonly SearchCollection[] = [
  { name: "vault_notes", queryBy: "title,content", titleField: "title", supportsSemantic: true },
  { name: "memory_observations", queryBy: "observation", titleField: "observation", supportsSemantic: true },
  { name: "blog_posts", queryBy: "title,content", titleField: "title", supportsSemantic: true },
  { name: "system_log", queryBy: "detail,tool,action", titleField: "detail", supportsSemantic: false },
  { name: "discoveries", queryBy: "title,summary", titleField: "title", supportsSemantic: true },
  { name: "voice_transcripts", queryBy: "content", titleField: "content", supportsSemantic: true },
  { name: "otel_events", queryBy: "action,error,component,source,metadata_json,search_text", titleField: "action", supportsSemantic: false },
]

const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name)

class CollectionSelectionError extends Error {
  readonly code = "INVALID_COLLECTION"

  constructor(readonly collection: string) {
    super(
      `Unsupported collection '${collection}'. Allowed: ${COLLECTION_NAMES.join(", ")}`
    )
    this.name = "CollectionSelectionError"
  }
}

function resolveRequestedCollections(collection?: string): readonly SearchCollection[] {
  if (!collection) return COLLECTIONS

  const requested = collection.trim()
  if (requested.length === 0) return COLLECTIONS

  const matches = COLLECTIONS.filter(
    (candidate) =>
      candidate.name === requested || candidate.name.startsWith(requested)
  )

  if (matches.length === 0) {
    throw new CollectionSelectionError(requested)
  }

  return matches
}

function buildSearchRequest(
  collection: SearchCollection,
  query: string,
  options: {
    perPage: number
    semantic?: boolean
    filter?: string
    facet?: string
  }
): Record<string, unknown> {
  const search: Record<string, unknown> = {
    collection: collection.name,
    q: query,
    query_by: collection.queryBy,
    per_page: options.perPage,
    highlight_full_fields: collection.queryBy,
    exclude_fields: "embedding",
  }

  if (options.facet) search.facet_by = options.facet
  if (options.filter) search.filter_by = options.filter

  if (options.semantic && collection.supportsSemantic) {
    search.query_by = `${collection.queryBy},embedding`
    search.vector_query = `embedding:([], k:${options.perPage * 2})`
  }

  return search
}

async function multiSearch(
  query: string,
  apiKey: string,
  options: {
    collection?: string
    perPage: number
    facet?: string
    filter?: string
    semantic?: boolean
  }
): Promise<{ hits: SearchHit[]; facets: Record<string, { value: string; count: number }[]>; totalFound: number }> {
  const collections = resolveRequestedCollections(options.collection)

  const searches = collections.map((collection) =>
    buildSearchRequest(collection, query, {
      perPage: options.perPage,
      semantic: options.semantic,
      filter: options.filter,
      facet: options.facet,
    })
  )

  const resp = await fetch(`${TYPESENSE_URL}/multi_search`, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ searches }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Typesense search failed (${resp.status}): ${text}`)
  }

  const data = (await resp.json()) as any
  const hits: SearchHit[] = []
  const allFacets: Record<string, { value: string; count: number }[]> = {}
  let totalFound = 0

  for (const result of data.results) {
    const collName = result.request_params?.collection_name || "unknown"
    totalFound += result.found || 0

    for (const h of result.hits || []) {
      const doc = h.document
      const coll = COLLECTIONS.find((c) => c.name === collName)
      const titleField = coll?.titleField || "title"

      // Get highlighted snippet or raw content
      let snippet = ""
      for (const hl of h.highlights || []) {
        if (hl.snippet) {
          snippet = hl.snippet
          break
        }
      }
      if (!snippet) {
        const raw = doc[titleField] || doc.content || doc.observation || doc.detail || ""
        snippet = typeof raw === "string" ? raw.slice(0, 200) : String(raw)
      }

      const title = doc.title || doc[titleField] || ""

      hits.push({
        collection: collName,
        title: typeof title === "string" ? title.slice(0, 120) : String(title).slice(0, 120),
        snippet: snippet.slice(0, 300),
        path: doc.path || doc.slug || undefined,
        score: h.text_match_info?.score || h.hybrid_search_info?.rank_fusion_score || undefined,
        type: doc.type || collName.replace("_", "-"),
      })
    }

    for (const fc of result.facet_counts || []) {
      if (!allFacets[fc.field_name]) allFacets[fc.field_name] = []
      allFacets[fc.field_name].push(...fc.counts.map((c: any) => ({ value: c.value, count: c.count })))
    }
  }

  return { hits, facets: allFacets, totalFound }
}

// --- CLI Definition ---

const queryArg = Args.text({ name: "query" }).pipe(Args.withDescription("Search query"))

const collectionOpt = Options.text("collection").pipe(
  Options.withAlias("c"),
  Options.withDescription(`Limit to a specific collection (${COLLECTION_NAMES.join(", ")})`),
  Options.optional
)

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Results per collection"),
  Options.withDefault(5)
)

const filterOpt = Options.text("filter").pipe(
  Options.withAlias("f"),
  Options.withDescription("Typesense filter_by expression (e.g. type:=adr)"),
  Options.optional
)

const facetOpt = Options.text("facet").pipe(
  Options.withDescription("Facet by field (e.g. type, tags, source)"),
  Options.optional
)

const semanticOpt = Options.boolean("semantic").pipe(
  Options.withAlias("s"),
  Options.withDescription("Enable hybrid semantic+keyword search"),
  Options.withDefault(false)
)

export const search = Command.make(
  "search",
  { query: queryArg, collection: collectionOpt, limit: limitOpt, filter: filterOpt, facet: facetOpt, semantic: semanticOpt },
  ({ query, collection, limit, filter, facet, semantic }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const collValue = collection._tag === "Some" ? collection.value : undefined
        const filterValue = filter._tag === "Some" ? filter.value : undefined
        const facetValue = facet._tag === "Some" ? facet.value : undefined

        const result = yield* Effect.promise(() =>
          multiSearch(query, apiKey, {
            collection: collValue,
            perPage: limit,
            filter: filterValue,
            facet: facetValue,
            semantic,
          })
        )

        yield* Console.log(respond("search", {
          query,
          collection: collValue,
          semantic,
          totalFound: result.totalFound,
          hits: result.hits,
          facets: Object.keys(result.facets).length > 0 ? result.facets : undefined,
        }, [
          {
            command: `search "${query}" --semantic`,
            description: "Re-run with hybrid semantic search",
          },
          {
            command: `search "${query}" --collection otel_events`,
            description: "Search observability events only",
          },
          {
            command: `search "${query}" --collection vault_notes --facet type`,
            description: "Search vault with type facets",
          },
          {
            command: `search "${query}" --filter "type:=adr"`,
            description: "Filter to ADRs only",
          },
        ]))
      } catch (err: any) {
        if (isTypesenseApiKeyError(err)) {
          yield* Console.log(respondError(
            "search",
            err.message,
            err.code,
            err.fix,
            [
              { command: "status", description: "Check system health" },
              { command: "inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }

        if (err instanceof CollectionSelectionError) {
          yield* Console.log(
            respondError(
              "search",
              err.message,
              err.code,
              `Use one of: ${COLLECTION_NAMES.join(", ")}`,
              [
                { command: "capabilities", description: "Discover supported search flows" },
                { command: "otel search <query>", description: "Search OTEL events", params: { query: { required: true } } },
              ]
            )
          )
          return
        }

        const message = err instanceof Error ? err.message : String(err)
        const isUnreachable = message.includes("ECONNREFUSED") || message.includes("Connection refused")
        yield* Console.log(respondError(
          "search",
          message,
          isUnreachable ? "TYPESENSE_UNREACHABLE" : "SEARCH_FAILED",
          isUnreachable
            ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
            : "Check Typesense health and search parameters",
          [{ command: "status", description: "Check all services" }]
        ))
      }
    })
)

export const __searchTestUtils = {
  COLLECTIONS,
  resolveRequestedCollections,
  buildSearchRequest,
  CollectionSelectionError,
}
