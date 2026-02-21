/**
 * joelclaw search — unified search across all Typesense collections.
 * ADR-0082: Typesense as unified search layer.
 *
 * Supports hybrid search (keyword + semantic), typo tolerance, faceting.
 * Searches vault_notes, memory_observations, blog_posts, system_log, discoveries, voice_transcripts.
 */
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"

function getApiKey(): string {
  const envKey = process.env.TYPESENSE_API_KEY
  if (envKey) return envKey
  try {
    const { execSync } = require("node:child_process")
    return execSync("secrets lease typesense_api_key --ttl 15m", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Error("No TYPESENSE_API_KEY and secrets lease failed")
  }
}

interface SearchHit {
  collection: string
  title: string
  snippet: string
  path?: string
  score?: number
  type?: string
}

const COLLECTIONS = [
  { name: "vault_notes", queryBy: "title,content", titleField: "title" },
  { name: "memory_observations", queryBy: "observation", titleField: "observation" },
  { name: "blog_posts", queryBy: "title,content", titleField: "title" },
  { name: "system_log", queryBy: "detail,tool,action", titleField: "detail" },
  { name: "discoveries", queryBy: "title,summary", titleField: "title" },
  { name: "voice_transcripts", queryBy: "content", titleField: "content" },
]

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
  const collections = options.collection
    ? COLLECTIONS.filter((c) => c.name === options.collection || c.name.startsWith(options.collection!))
    : COLLECTIONS

  const searches = collections.map((c) => {
    const search: any = {
      collection: c.name,
      q: query,
      query_by: c.queryBy,
      per_page: options.perPage,
      highlight_full_fields: c.queryBy,
    }
    if (options.facet) search.facet_by = options.facet
    if (options.filter) search.filter_by = options.filter

    // If collection has embedding field and semantic requested, do hybrid
    if (options.semantic && c.name !== "system_log") {
      search.query_by = `${c.queryBy},embedding`
      search.vector_query = `embedding:([], k:${options.perPage * 2})`
      search.exclude_fields = "embedding"
    } else {
      search.exclude_fields = "embedding"
    }

    return search
  })

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
  Options.withDescription("Limit to a specific collection (vault_notes, memory_observations, blog_posts, system_log, discoveries, voice_transcripts)"),
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
        const apiKey = getApiKey()
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

        yield* Console.log(respond("joelclaw search", {
          query,
          totalFound: result.totalFound,
          hits: result.hits,
          facets: Object.keys(result.facets).length > 0 ? result.facets : undefined,
        }, [
          {
            command: `joelclaw search "${query}" --semantic`,
            description: "Re-run with hybrid semantic search",
          },
          {
            command: `joelclaw search "${query}" --collection vault_notes --facet type`,
            description: "Search vault with type facets",
          },
          {
            command: `joelclaw search "${query}" --filter "type:=adr"`,
            description: "Filter to ADRs only",
          },
        ]))
      } catch (err: any) {
        yield* Console.log(respondError("joelclaw search", err.message))
      }
    })
)
