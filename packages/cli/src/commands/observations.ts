import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { respond, respondError } from "../response"
import { resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const COLLECTION = "observations"
const OBSERVATIONS_DIR = process.env.JOELCLAW_OBSERVATIONS_DIR || join(process.env.HOME ?? "", "Code/joelhooks/dark-wizard/.brain/observations")

const SCHEMA = {
  name: COLLECTION,
  fields: [
    { name: "sessionId", type: "string" }, { name: "machine", type: "string", facet: true },
    { name: "agent", type: "string", facet: true }, { name: "started", type: "string" },
    { name: "ended", type: "string" }, { name: "started_at", type: "int64", sort: true },
    { name: "tokens", type: "int64" }, { name: "repos", type: "string[]", facet: true },
    { name: "privacy", type: "string", facet: true }, { name: "slug", type: "string" },
    { name: "gist", type: "string" }, { name: "observations", type: "string[]" },
    { name: "decisions", type: "string[]" }, { name: "open_questions", type: "string[]" },
    { name: "url", type: "string" },
  ],
  default_sorting_field: "started_at",
} as const

type ObservationDocument = {
  id: string; sessionId: string; machine: string; agent: string; started: string; ended: string
  started_at: number; tokens: number; repos: string[]; privacy: string; slug: string; gist: string
  observations: string[]; decisions: string[]; open_questions: string[]; url: string
}

type SearchHit = { document?: ObservationDocument; highlights?: Array<{ snippet?: string; value?: string }> }

function section(body: string, heading: string): string[] {
  const match = body.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$)`, "im"))
  if (!match) return []
  return match[1].split("\n").map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim()).filter((value): value is string => Boolean(value))
}

export function parseObservation(path: string): ObservationDocument {
  const content = readFileSync(path, "utf8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error(`Invalid observation frontmatter: ${path}`)
  const frontmatter = Bun.YAML.parse(match[1]) as Record<string, unknown>
  if (frontmatter.type !== "observation" || frontmatter.schemaVersion !== 1) throw new Error(`Unsupported observation schema: ${path}`)
  const requiredStrings = ["sessionId", "machine", "agent", "started", "ended"] as const
  for (const field of requiredStrings) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) throw new Error(`Invalid observation ${field}: ${path}`)
  }
  if (typeof frontmatter.tokens !== "number" || !Number.isFinite(frontmatter.tokens) || frontmatter.tokens < 0) throw new Error(`Invalid observation tokens: ${path}`)
  if (!Array.isArray(frontmatter.repos) || !frontmatter.repos.every((repo) => typeof repo === "string")) throw new Error(`Invalid observation repos: ${path}`)
  if (!new Set(["public", "private", "sensitive"]).has(String(frontmatter.privacy))) throw new Error(`Invalid observation privacy: ${path}`)
  const slug = basename(path, ".svx")
  const body = match[2].trim()
  const gist = body.split(/^## /m)[0].trim().replace(/\s+/g, " ")
  const started = String(frontmatter.started ?? "")
  return {
    id: slug, sessionId: String(frontmatter.sessionId ?? ""), machine: String(frontmatter.machine ?? ""),
    agent: String(frontmatter.agent ?? ""), started, ended: String(frontmatter.ended ?? ""),
    started_at: Number.isFinite(Date.parse(started)) ? Date.parse(started) : 0,
    tokens: Number(frontmatter.tokens ?? 0), repos: Array.isArray(frontmatter.repos) ? frontmatter.repos.map(String) : [],
    privacy: String(frontmatter.privacy ?? "private"), slug, gist,
    observations: section(body, "Observations"), decisions: section(body, "Decisions"),
    open_questions: section(body, "Open questions / next actions"),
    url: `https://brain.joelclaw.com/user/observations/${slug}/`,
  }
}

function headers(apiKey: string) { return { "X-TYPESENSE-API-KEY": apiKey, "Content-Type": "application/json" } }

async function recreateCollection(apiKey: string): Promise<void> {
  const deleted = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}`, { method: "DELETE", headers: headers(apiKey) })
  if (!deleted.ok && deleted.status !== 404) throw new Error(`Delete observations collection failed (${deleted.status}): ${await deleted.text()}`)
  const response = await fetch(`${TYPESENSE_URL}/collections`, { method: "POST", headers: headers(apiKey), body: JSON.stringify(SCHEMA) })
  if (!response.ok) throw new Error(`Create observations collection failed (${response.status}): ${await response.text()}`)
}

async function indexObservations(rebuild: boolean) {
  const apiKey = resolveTypesenseApiKey()
  const check = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}`, { headers: headers(apiKey) })
  if (rebuild || check.status === 404) await recreateCollection(apiKey)
  else if (!check.ok) throw new Error(`Check observations collection failed (${check.status}): ${await check.text()}`)
  else {
    const cleared = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents?filter_by=started_at:>=0`, {
      method: "DELETE",
      headers: headers(apiKey),
    })
    if (!cleared.ok) throw new Error(`Clear observations projection failed (${cleared.status}): ${await cleared.text()}`)
  }
  const paths = readdirSync(OBSERVATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".svx"))
    .map((entry) => join(OBSERVATIONS_DIR, entry.name))
    .filter((path) => /^type:\s*observation\s*$/m.test(readFileSync(path, "utf8")))
  // One invalid page must not strand the batch: index the valid, report the broken loudly.
  const skipped: Array<{ file: string; error: string }> = []
  const docs = paths.flatMap((path) => {
    try {
      return [parseObservation(path)]
    } catch (error) {
      skipped.push({ file: path, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  })
    .sort((a, b) => a.slug.localeCompare(b.slug))
  if (docs.length > 0) {
    const response = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/import?action=upsert`, {
      method: "POST", headers: headers(apiKey), body: docs.map((doc) => JSON.stringify(doc)).join("\n"),
    })
    if (!response.ok) throw new Error(`Index observations failed (${response.status}): ${await response.text()}`)
    const results = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { success?: boolean; error?: string })
    const failures = results.filter((result) => !result.success)
    if (failures.length) throw new Error(`Index observations failed for ${failures.length} documents: ${failures[0].error ?? "unknown error"}`)
  }
  return { collection: COLLECTION, directory: OBSERVATIONS_DIR, rebuilt: rebuild, indexed: docs.length, skipped }
}

export async function searchObservations(query: string, limit: number, machine: string, runtime: string) {
  const apiKey = resolveTypesenseApiKey()
  const params = new URLSearchParams({ q: query, query_by: "gist,observations,decisions", per_page: String(limit), highlight_fields: "gist,observations,decisions", sort_by: "_text_match:desc,started_at:desc" })
  const filters: string[] = []
  if (machine !== "all") filters.push(`machine:=${JSON.stringify(machine)}`)
  if (runtime !== "all") filters.push(`agent:=${JSON.stringify(runtime === "claude-code" ? "claude" : runtime)}`)
  if (filters.length) params.set("filter_by", filters.join(" && "))
  const response = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${params}`, { headers: headers(apiKey) })
  if (!response.ok) throw new Error(`Typesense observation search failed (${response.status}): ${await response.text()}`)
  const result = await response.json() as { found?: number; hits?: SearchHit[] }
  return { found: result.found ?? 0, hits: (result.hits ?? []).flatMap((hit) => {
    const doc = hit.document
    if (!doc) return []
    const snippet = hit.highlights?.find((value) => value.snippet)?.snippet ?? doc.gist
    return [{ ...doc, label: doc.privacy === "sensitive" ? "[sensitive]" : undefined, snippet }]
  }) }
}

const rebuildOpt = Options.boolean("rebuild").pipe(Options.withDefault(false), Options.withDescription("Drop and recreate the observations collection before indexing"))
const indexCmd = Command.make("index", { rebuild: rebuildOpt }, ({ rebuild }) => Effect.gen(function* () {
  try { yield* Effect.promise(() => indexObservations(rebuild)).pipe(Effect.flatMap((result) => Effect.sync(() => console.log(respond("observations index", result))))) }
  catch (error) { console.log(respondError("observations index", error instanceof Error ? error.message : String(error), "OBSERVATIONS_INDEX_FAILED", "Check observation files, Typesense reachability, and credentials")) }
}))

export const observationsCmd = Command.make("observations", {}, () => Effect.void).pipe(Command.withDescription("Build and query the observation-page projection"), Command.withSubcommands([indexCmd]))
