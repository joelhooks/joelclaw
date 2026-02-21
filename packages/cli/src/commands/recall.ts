// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Migrated from Qdrant+embed.py to Typesense with built-in auto-embedding.
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

interface TypesenseHit {
  document: {
    id: string
    session_id?: string
    timestamp?: number
    observation_type?: string
    observation: string
    source?: string
  }
  highlights?: Array<{ field: string; snippet?: string }>
  text_match_info?: { score: number }
  hybrid_search_info?: { rank_fusion_score: number }
}

/** Search Typesense memory_observations — keyword search with auto-embedding */
async function searchTypesense(
  query: string,
  limit: number,
): Promise<{ hits: TypesenseHit[]; found: number }> {
  const apiKey = getApiKey()
  const params = new URLSearchParams({
    q: query,
    query_by: "observation",
    per_page: String(limit),
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
const raw = Options.boolean("raw").pipe(Options.withDefault(false))

export const recallCmd = Command.make(
  "recall",
  { query, limit, raw },
  ({ query, limit, raw }) =>
    Effect.gen(function* () {
      try {
        const result = yield* Effect.promise(() => searchTypesense(query, limit))

        if (raw) {
          const lines = result.hits.map((h) => h.document.observation)
          yield* Console.log(lines.join("\n"))
          return
        }

        yield* Console.log(
          respond("recall", {
            query,
            hits: result.hits.map((h) => ({
              score: h.text_match_info?.score || h.hybrid_search_info?.rank_fusion_score || 0,
              observation: h.document.observation,
              type: h.document.observation_type || "unknown",
              session: h.document.session_id || "unknown",
              timestamp: h.document.timestamp
                ? new Date(h.document.timestamp * 1000).toISOString()
                : "unknown",
            })),
            count: result.hits.length,
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
