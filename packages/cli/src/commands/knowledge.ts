import { readdir, readFile } from "node:fs/promises"
import { join, basename } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { resolveTypesenseApiKey } from "../typesense-auth"
import { respond } from "../response"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const VAULT_DIR = process.env.VAULT_DIR || `${process.env.HOME}/Vault`
const SKILLS_DIR = process.env.JOELCLAW_SKILLS_DIR || `${process.env.HOME}/Code/joelhooks/joelclaw/skills`

const COLLECTION = "system_knowledge"

const SCHEMA = {
  name: COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "type", type: "string", facet: true },
    { name: "title", type: "string" },
    { name: "content", type: "string" },
    { name: "source", type: "string", optional: true },
    { name: "project", type: "string", optional: true, facet: true },
    { name: "loop_id", type: "string", optional: true },
    { name: "status", type: "string", optional: true, facet: true },
    { name: "score", type: "int32", optional: true },
    { name: "tags", type: "string[]", optional: true, facet: true },
    { name: "created_at", type: "int64" },
    { name: "embedding", type: "float[]", num_dim: 384, optional: true },
  ],
  default_sorting_field: "created_at",
  enable_nested_fields: false,
}

async function headers(): Promise<Record<string, string>> {
  const apiKey = await resolveTypesenseApiKey()
  return {
    "X-TYPESENSE-API-KEY": apiKey,
    "Content-Type": "application/json",
  }
}

async function ensureCollection(): Promise<{ created: boolean }> {
  const h = await headers()

  // Check if collection exists
  const check = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}`, { headers: h })
  if (check.ok) return { created: false }

  // Create it
  const resp = await fetch(`${TYPESENSE_URL}/collections`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(SCHEMA),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to create collection: ${resp.status} ${text}`)
  }
  return { created: true }
}

async function bulkUpsert(docs: Record<string, unknown>[]): Promise<{ success: number; errors: number }> {
  if (docs.length === 0) return { success: 0, errors: 0 }
  const h = await headers()
  const body = docs.map((d) => JSON.stringify(d)).join("\n")
  const resp = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/import?action=upsert`, {
    method: "POST",
    headers: h,
    body,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Bulk upsert failed: ${resp.status} ${text}`)
  }
  const text = await resp.text()
  const lines = text.trim().split("\n")
  let success = 0
  let errors = 0
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      if (r.success) success++
      else errors++
    } catch {
      errors++
    }
  }
  return { success, errors }
}

// --- ADR parsing ---

function parseAdrFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  // ADRs use "Key: Value" lines at the top
  const lines = content.split("\n")
  for (const line of lines) {
    const match = line.match(/^(Status|Date|Updated|Supersedes|Superseded by|Related|Tags):\s*(.+)/i)
    if (match) {
      result[match[1].toLowerCase().replace(/ /g, "_")] = match[2].trim()
    }
    // Stop at first heading after frontmatter-ish lines
    if (line.startsWith("## ")) break
  }
  return result
}

async function indexAdrs(): Promise<{ count: number }> {
  const adrDir = join(VAULT_DIR, "docs", "decisions")
  const files = await readdir(adrDir).catch(() => [] as string[])
  const adrFiles = files.filter((f) => f.match(/^\d{4}-.*\.md$/))

  const docs: Record<string, unknown>[] = []
  for (const file of adrFiles) {
    const content = await readFile(join(adrDir, file), "utf-8")
    const num = file.match(/^(\d{4})/)?.[1] ?? ""
    const slug = file.replace(/\.md$/, "")
    const titleMatch = content.match(/^#\s+(.+)/m)
    const title = titleMatch?.[1] ?? slug
    const meta = parseAdrFrontmatter(content)
    const tags: string[] = ["adr"]
    if (meta.tags) tags.push(...meta.tags.split(",").map((t) => t.trim()))

    docs.push({
      id: `adr:${num}`,
      type: "adr",
      title,
      content: content.slice(0, 8000),
      source: `vault:docs/decisions/${file}`,
      status: meta.status || "unknown",
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })
  }

  const result = await bulkUpsert(docs)
  return { count: result.success }
}

// --- Skill parsing ---

async function indexSkills(): Promise<{ count: number }> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory())

  const docs: Record<string, unknown>[] = []
  for (const dir of dirs) {
    const skillPath = join(SKILLS_DIR, dir.name, "SKILL.md")
    const content = await readFile(skillPath, "utf-8").catch(() => null)
    if (!content) continue

    // Extract description from frontmatter
    const descMatch = content.match(/^description:\s*(.+)/m)
    const desc = descMatch?.[1]?.replace(/^['"]|['"]$/g, "") ?? ""

    docs.push({
      id: `skill:${dir.name}`,
      type: "skill",
      title: dir.name,
      content: `${desc}\n\n${content.slice(0, 6000)}`,
      source: `skills/${dir.name}/SKILL.md`,
      tags: ["skill"],
      created_at: Math.floor(Date.now() / 1000),
    })
  }

  const result = await bulkUpsert(docs)
  return { count: result.success }
}

// --- Commands ---

const syncCmd = Command.make(
  "sync",
  {
    adrsOnly: Options.boolean("adrs-only").pipe(Options.withDescription("Only sync ADRs"), Options.withDefault(false)),
    skillsOnly: Options.boolean("skills-only").pipe(Options.withDescription("Only sync skills"), Options.withDefault(false)),
  },
  ({ adrsOnly, skillsOnly }) =>
    Effect.gen(function* () {
      const { created } = yield* Effect.promise(() => ensureCollection())
      if (created) {
        yield* Console.log(`Created collection: ${COLLECTION}`)
      }

      const syncAll = !adrsOnly && !skillsOnly
      const results: Record<string, number> = {}

      if (syncAll || adrsOnly) {
        const adrs = yield* Effect.promise(() => indexAdrs())
        results.adrs = adrs.count
      }

      if (syncAll || skillsOnly) {
        const skills = yield* Effect.promise(() => indexSkills())
        results.skills = skills.count
      }

      yield* Console.log(
        respond("knowledge sync", {
          collection: COLLECTION,
          created,
          indexed: results,
        }, [
          {
            command: "joelclaw knowledge search <query>",
            description: "Search system knowledge",
          },
          {
            command: "joelclaw recall <query>",
            description: "Search across all collections including system_knowledge",
          },
        ]),
      )
    }),
)

const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }).pipe(Args.withDescription("Search query")),
    type: Options.text("type").pipe(
      Options.withAlias("t"),
      Options.withDescription("Filter by type (adr, skill, lesson, pattern, retro, failed_target)"),
      Options.optional,
    ),
    limit: Options.integer("limit").pipe(
      Options.withAlias("n"),
      Options.withDescription("Max results"),
      Options.withDefault(10),
    ),
  },
  ({ query, type, limit }) =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => headers())

      const params = new URLSearchParams({
        q: query,
        query_by: "title,content",
        per_page: String(limit),
        exclude_fields: "embedding",
      })

      if (type._tag === "Some") {
        params.set("filter_by", `type:=${type.value}`)
      }

      const resp = yield* Effect.promise(() =>
        fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${params}`, { headers: h }),
      )

      if (!resp.ok) {
        const text = yield* Effect.promise(() => resp.text())
        yield* Console.error(`Search failed: ${resp.status} ${text}`)
        return
      }

      const data = yield* Effect.promise(() => resp.json()) as any
      const hits = data.hits ?? []

      yield* Console.log(
        respond("knowledge search", {
          query,
          found: data.found ?? 0,
          hits: hits.map((h: any) => ({
            id: h.document?.id,
            type: h.document?.type,
            title: h.document?.title,
            score: h.text_match_info?.score ?? h.hybrid_search_info?.rank_fusion_score,
            snippet: String(h.document?.content ?? "").slice(0, 200),
          })),
        }, [
          {
            command: "joelclaw knowledge sync",
            description: "Re-sync ADRs and skills",
          },
        ]),
      )
    }),
)

export const knowledgeCmd = Command.make("knowledge").pipe(
  Command.withDescription("System knowledge index — sync and search ADRs, skills, retros, lessons"),
  Command.withSubcommands([syncCmd, searchCmd]),
)
