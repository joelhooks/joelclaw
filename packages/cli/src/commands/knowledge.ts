import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"
import { resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const VAULT_DIR = process.env.VAULT_DIR || `${process.env.HOME}/Vault`
const SKILLS_DIR = process.env.JOELCLAW_SKILLS_DIR || `${process.env.HOME}/Code/joelhooks/joelclaw/skills`

const COLLECTION = "system_knowledge"
const TURN_SKIP_REASONS = ["routine-heartbeat", "duplicate-signal", "no-new-information"] as const

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

type OptionalValue<T> = { _tag: "Some"; value: T } | { _tag: "None" }

type KnowledgeNoteInput = {
  source: string
  agent: string
  channel?: string
  session: string
  turn: number
  turnId?: string
  summary?: string
  decision?: string
  evidence?: string
  usefulness?: string
  skipReason?: (typeof TURN_SKIP_REASONS)[number]
  project?: string
  loopId?: string
  storyId?: string
  runId?: string
  tools?: string
}

type KnowledgeNoteValidated = {
  source: string
  agent: string
  channel?: string
  session: string
  turn: number
  turnId: string
  summary?: string
  decision?: string
  evidence: string[]
  usefulnessTags: string[]
  skipReason?: (typeof TURN_SKIP_REASONS)[number]
  context: {
    project?: string
    loopId?: string
    storyId?: string
    runId?: string
    toolNames?: string[]
  }
}

function optionalText(value: OptionalValue<string>): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseCsvList(value: string | undefined, max = 20): string[] {
  if (!value) return []
  const unique = new Set<string>()
  for (const entry of value.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    unique.add(trimmed)
    if (unique.size >= max) break
  }
  return Array.from(unique)
}

function buildTurnId(input: {
  source: string
  agent: string
  channel?: string
  session: string
  turn: number
}): string {
  const channel = input.channel?.trim() ? input.channel.trim() : "internal"
  return `${input.source}:${input.agent}:${channel}:${input.session}:${input.turn}`
}

function validateKnowledgeNoteInput(input: KnowledgeNoteInput): {
  ok: true
  value: KnowledgeNoteValidated
} | {
  ok: false
  message: string
} {
  const source = input.source.trim()
  const agent = input.agent.trim()
  const session = input.session.trim()
  const channel = input.channel?.trim() || undefined
  const turn = Number.isFinite(input.turn) ? Math.floor(input.turn) : Number.NaN
  const summary = input.summary?.trim() || undefined
  const decision = input.decision?.trim() || undefined
  const skipReason = input.skipReason
  const evidence = parseCsvList(input.evidence, 30)
  const usefulnessTags = parseCsvList(input.usefulness, 20).map((tag) =>
    tag.toLowerCase().replace(/\s+/g, "-")
  )
  const toolNames = parseCsvList(input.tools, 20)

  if (!source) return { ok: false, message: "--source is required" }
  if (!agent) return { ok: false, message: "--agent is required" }
  if (!session) return { ok: false, message: "--session is required" }
  if (!Number.isFinite(turn) || turn < 0) {
    return { ok: false, message: "--turn must be a non-negative integer" }
  }
  if (!skipReason && !summary) {
    return { ok: false, message: "--summary is required unless --skip-reason is provided" }
  }

  return {
    ok: true,
    value: {
      source,
      agent,
      channel,
      session,
      turn,
      turnId: input.turnId?.trim() || buildTurnId({ source, agent, channel, session, turn }),
      summary,
      decision,
      evidence,
      usefulnessTags,
      skipReason,
      context: {
        project: input.project?.trim() || undefined,
        loopId: input.loopId?.trim() || undefined,
        storyId: input.storyId?.trim() || undefined,
        runId: input.runId?.trim() || undefined,
        toolNames: toolNames.length > 0 ? toolNames : undefined,
      },
    },
  }
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

type KnowledgeSyncResult = {
  created: boolean
  indexed: Record<string, number>
}

async function syncKnowledgeIndex(options: {
  adrsOnly?: boolean
  skillsOnly?: boolean
} = {}): Promise<KnowledgeSyncResult> {
  const { created } = await ensureCollection()
  const syncAll = !options.adrsOnly && !options.skillsOnly
  const indexed: Record<string, number> = {}

  if (syncAll || options.adrsOnly) {
    const adrs = await indexAdrs()
    indexed.adrs = adrs.count
  }

  if (syncAll || options.skillsOnly) {
    const skills = await indexSkills()
    indexed.skills = skills.count
  }

  return { created, indexed }
}

function isMissingKnowledgeCollection(status: number, body: string): boolean {
  return status === 404 && /collection not found/i.test(body)
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
      const result = yield* Effect.promise(() => syncKnowledgeIndex({ adrsOnly, skillsOnly }))
      if (result.created) {
        yield* Console.log(`Created collection: ${COLLECTION}`)
      }

      yield* Console.log(
        respond("knowledge sync", {
          collection: COLLECTION,
          created: result.created,
          indexed: result.indexed,
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
      Options.withDescription("Filter by type (adr, skill, lesson, pattern, retro, failed_target, turn_note)"),
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

      let resp = yield* Effect.promise(() =>
        fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${params}`, { headers: h }),
      )

      let repair: KnowledgeSyncResult | undefined
      if (!resp.ok) {
        const text = yield* Effect.promise(() => resp.text())

        if (isMissingKnowledgeCollection(resp.status, text)) {
          repair = yield* Effect.promise(() => syncKnowledgeIndex())
          resp = yield* Effect.promise(() =>
            fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${params}`, { headers: h }),
          )
        } else {
          yield* Console.log(
            respondError(
              "knowledge search",
              `Search failed: ${resp.status} ${text}`,
              "KNOWLEDGE_SEARCH_FAILED",
              "Check Typesense health on localhost:8108 and run `joelclaw knowledge sync` if the system_knowledge index drifted.",
              [
                { command: "joelclaw knowledge sync", description: "Rebuild the system_knowledge collection" },
                { command: "joelclaw status", description: "Check core runtime health" },
              ],
            ),
          )
          return
        }
      }

      if (!resp.ok) {
        const text = yield* Effect.promise(() => resp.text())
        yield* Console.log(
          respondError(
            "knowledge search",
            `Search failed after auto-repair: ${resp.status} ${text}`,
            "KNOWLEDGE_SEARCH_FAILED",
            "Run `joelclaw knowledge sync` explicitly and inspect Typesense health if the collection is still missing or unreadable.",
            [
              { command: "joelclaw knowledge sync", description: "Rebuild the system_knowledge collection" },
              { command: "joelclaw status", description: "Check core runtime health" },
            ],
          ),
        )
        return
      }

      const data = yield* Effect.promise(() => resp.json()) as any
      const hits = data.hits ?? []

      yield* Console.log(
        respond("knowledge search", {
          query,
          found: data.found ?? 0,
          ...(repair ? { autoRepair: repair } : {}),
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

const noteCmd = Command.make(
  "note",
  {
    source: Options.text("source").pipe(Options.withAlias("s"), Options.withDescription("Origin source (gateway, agent-loop, etc.)")),
    agent: Options.text("agent").pipe(Options.withAlias("a"), Options.withDescription("Agent or component name")),
    channel: Options.text("channel").pipe(Options.withDescription("Channel context (telegram, slack, system)"), Options.optional),
    session: Options.text("session").pipe(Options.withDescription("Session or loop context key")),
    turn: Options.integer("turn").pipe(Options.withDescription("Turn number within the session")),
    turnId: Options.text("turn-id").pipe(Options.withDescription("Optional stable turn id (defaults to derived id)"), Options.optional),
    summary: Options.text("summary").pipe(Options.withDescription("Turn summary (required unless --skip-reason)"), Options.optional),
    decision: Options.text("decision").pipe(Options.withDescription("Decision captured from the turn"), Options.optional),
    evidence: Options.text("evidence").pipe(Options.withDescription("Comma-separated evidence pointers"), Options.optional),
    usefulness: Options.text("usefulness").pipe(Options.withDescription("Comma-separated usefulness tags"), Options.optional),
    skipReason: Options.choice("skip-reason", TURN_SKIP_REASONS).pipe(
      Options.withDescription("Explicit skip reason"),
      Options.optional,
    ),
    project: Options.text("project").pipe(Options.withDescription("Optional project context"), Options.optional),
    loopId: Options.text("loop-id").pipe(Options.withDescription("Optional loop id context"), Options.optional),
    storyId: Options.text("story-id").pipe(Options.withDescription("Optional story id context"), Options.optional),
    runId: Options.text("run-id").pipe(Options.withDescription("Optional run id context"), Options.optional),
    tools: Options.text("tools").pipe(Options.withDescription("Comma-separated tools used in the turn"), Options.optional),
  },
  ({ source, agent, channel, session, turn, turnId, summary, decision, evidence, usefulness, skipReason, project, loopId, storyId, runId, tools }) =>
    Effect.gen(function* () {
      const validated = validateKnowledgeNoteInput({
        source,
        agent,
        channel: optionalText(channel),
        session,
        turn,
        turnId: optionalText(turnId),
        summary: optionalText(summary),
        decision: optionalText(decision),
        evidence: optionalText(evidence),
        usefulness: optionalText(usefulness),
        skipReason: skipReason._tag === "Some" ? skipReason.value : undefined,
        project: optionalText(project),
        loopId: optionalText(loopId),
        storyId: optionalText(storyId),
        runId: optionalText(runId),
        tools: optionalText(tools),
      })

      if (!validated.ok) {
        yield* Console.log(
          respondError(
            "knowledge note",
            validated.message,
            "INVALID_KNOWLEDGE_NOTE",
            "Provide required turn context and summary/skip-reason fields",
            [
              { command: "joelclaw knowledge note --source <source> --agent <agent> --session <session> --turn <turn> --summary <summary>", description: "Retry with required fields" },
            ],
          ),
        )
        return
      }

      const note = validated.value
      const inngestClient = yield* Inngest
      const result = yield* inngestClient.send("knowledge/turn.write.requested", {
        source: note.source,
        agent: note.agent,
        channel: note.channel,
        session: note.session,
        turnId: note.turnId,
        turnNumber: note.turn,
        summary: note.summary,
        decision: note.decision,
        evidence: note.evidence,
        usefulnessTags: note.usefulnessTags,
        skipReason: note.skipReason,
        context: note.context,
        occurredAt: new Date().toISOString(),
      })

      yield* Console.log(
        respond("knowledge note", {
          queued: true,
          event: "knowledge/turn.write.requested",
          turnId: note.turnId,
          skipReason: note.skipReason ?? null,
          response: result,
        }, [
          { command: "joelclaw runs --count 3", description: "Inspect recent worker runs" },
          { command: "joelclaw otel search knowledge.turn_write --hours 1", description: "Verify write OTEL lifecycle events" },
          { command: "joelclaw knowledge search turn_note --type turn_note --limit 5", description: "Verify indexed turn notes" },
        ]),
      )
    }),
)

// ── clear-failed ──

const clearFailedTarget = Args.text({ name: "target" }).pipe(
  Args.withDescription("Story ID or ADR number to clear from failed targets"),
)

const clearFailedCmd = Command.make(
  "clear-failed",
  { target: clearFailedTarget },
).pipe(
  Command.withDescription("Remove a failed target from system_knowledge"),
  Command.withHandler(({ target }) =>
    Effect.gen(function* () {
      const apiKey = yield* resolveTypesenseApiKey()

      // Search for matching failed_target docs
      const searchResp = yield* Effect.promise(() =>
        fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?q=${encodeURIComponent(target)}&query_by=title,content&filter_by=type:=failed_target&per_page=50`, {
          headers: { "X-TYPESENSE-API-KEY": apiKey },
        }),
      )

      if (!searchResp.ok) {
        yield* Console.error(`Search failed: ${searchResp.status}`)
        return
      }

      const data = yield* Effect.promise(() => searchResp.json()) as any
      const hits = data.hits ?? []
      let deleted = 0

      for (const hit of hits) {
        const id = hit.document?.id
        if (!id) continue
        const delResp = yield* Effect.promise(() =>
          fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/${id}`, {
            method: "DELETE",
            headers: { "X-TYPESENSE-API-KEY": apiKey },
          }),
        )
        if (delResp.ok) deleted++
      }

      yield* Console.log(
        respond("clear-failed", {
          target,
          found: hits.length,
          deleted,
        }, [
          { command: "joelclaw knowledge search failed_target", description: "List remaining failed targets" },
        ]),
      )
    }),
  ),
)

export const knowledgeCmd = Command.make("knowledge").pipe(
  Command.withDescription("System knowledge index — sync/search plus turn-level knowledge note writes"),
  Command.withSubcommands([syncCmd, searchCmd, noteCmd, clearFailedCmd]),
)

export const __knowledgeTestUtils = {
  parseCsvList,
  buildTurnId,
  validateKnowledgeNoteInput,
}
