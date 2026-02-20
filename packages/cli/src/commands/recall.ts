// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { respond, respondError } from "../response"

const QDRANT_URL = "http://localhost:6333"
const QDRANT_COLLECTION = "memory_observations"
const EMBED_SCRIPT = join(__dirname, "..", "..", "..", "system-bus", "scripts", "embed.py")

interface QdrantHit {
  id: string
  score: number
  payload: {
    session_id: string
    timestamp: string
    observation_type: string
    observation: string
    superseded_by?: string
    supersedes?: string
  }
}

/** Embed a query string using local all-mpnet-base-v2 (768-dim) */
function embedQuery(query: string): number[] {
  const input = JSON.stringify({ id: "q", text: query })
  const output = execSync(
    `echo '${input.replace(/'/g, "'\\''")}' | uv run --with sentence-transformers ${EMBED_SCRIPT}`,
    {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    }
  )
  const results: Array<{ id: string; vector: number[] }> = JSON.parse(output.trim())
  if (!results[0]?.vector) throw new Error("Embedding returned no vector")
  return results[0].vector
}

/** Search Qdrant for nearest observations */
async function searchQdrant(
  vector: number[],
  limit: number,
  minScore: number,
  includeSuperseded: boolean
): Promise<QdrantHit[]> {
  const requestedLimit = includeSuperseded ? limit : Math.max(limit * 3, limit)
  const resp = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: requestedLimit,
      with_payload: true,
      score_threshold: minScore,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Qdrant search failed (${resp.status}): ${text}`)
  }

  const data = await resp.json() as { result: QdrantHit[] }
  const hits = data.result ?? []
  const filteredHits = includeSuperseded
    ? hits
    : hits.filter((hit) => !hit.payload?.superseded_by)
  return filteredHits.slice(0, limit)
}

const query = Args.text({ name: "query" })
const limit = Options.integer("limit").pipe(Options.withDefault(5))
const minScore = Options.float("min-score").pipe(Options.withDefault(0.25))
const raw = Options.boolean("raw").pipe(Options.withDefault(false))
const includeSuperseded = Options.boolean("include-superseded").pipe(Options.withDefault(false))

export const recallCmd = Command.make(
  "recall",
  { query, limit, minScore, raw, includeSuperseded },
  ({ query, limit, minScore, raw, includeSuperseded }) =>
    Effect.gen(function* () {
      try {
        const vector = embedQuery(query)
        const hits = yield* Effect.promise(() =>
          searchQdrant(vector, limit, minScore, includeSuperseded)
        )

        if (raw) {
          // Raw mode: just observations, one per line — for piping/injection
          const lines = hits.map((h) => h.payload.observation)
          yield* Console.log(lines.join("\n"))
          return
        }

        yield* Console.log(
          respond("recall", {
            query,
            hits: hits.map((h) => ({
              score: Math.round(h.score * 1000) / 1000,
              observation: h.payload.observation,
              type: h.payload.observation_type,
              session: h.payload.session_id,
              timestamp: h.payload.timestamp,
            })),
            count: hits.length,
            collection: QDRANT_COLLECTION,
            totalPoints: "520+",
            includeSuperseded,
          }, [
            {
              command: "recall <query> [--limit <limit>]",
              description: "Get more results",
              params: {
                query: { description: "Recall search query", value: query, required: true },
                limit: { description: "Maximum results", value: 10, default: 5 },
              },
            },
            {
              command: "recall <query> [--min-score <min-score>]",
              description: "Stricter relevance",
              params: {
                query: { description: "Recall search query", value: query, required: true },
                "min-score": { description: "Minimum similarity score", value: 0.35, default: 0.25 },
              },
            },
            {
              command: "recall <query> [--include-superseded]",
              description: "Include older superseded observations",
              params: {
                query: { description: "Recall search query", value: query, required: true },
              },
            },
            {
              command: "recall <query> [--raw]",
              description: "Raw observations for injection",
              params: {
                query: { description: "Recall search query", value: query, required: true },
              },
            },
          ])
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (message.includes("Qdrant") || message.includes("Connection refused")) {
          yield* Console.log(respondError(
            "recall", message, "QDRANT_UNREACHABLE",
            "kubectl port-forward -n joelclaw svc/qdrant-svc 6333:6333",
            [{ command: "status", description: "Check all services" }]
          ))
          return
        }

        if (message.includes("uv") || message.includes("sentence-transformers")) {
          yield* Console.log(respondError(
            "recall", message, "EMBED_FAILED",
            "uv run --with sentence-transformers python3 -c 'import sentence_transformers; print(\"ok\")'",
            [{ command: "status", description: "Check all services" }]
          ))
          return
        }

        yield* Console.log(respondError(
          "recall", message, "UNKNOWN",
          "Check Qdrant (localhost:6333) and embed.py script",
          [{ command: "status", description: "Check all services" }]
        ))
      }
    })
)
