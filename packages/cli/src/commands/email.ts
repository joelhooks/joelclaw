import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

/**
 * Email CLI — agent-first inbox operations via Front API.
 *
 * Uses the Front REST API directly (not the email port adapter)
 * for CLI-level operations. The email port is for programmatic
 * use within Inngest functions and agent loops.
 *
 * Hexagonal Architecture: ADR-0052
 */

// ── Helpers ─────────────────────────────────────────────────────────

function frontToken(): string {
  const { execSync } = require("child_process")
  const output = execSync("secrets lease front_api_token --ttl 15m", {
    encoding: "utf-8",
  }).trim()
  
  // Handle agent-secrets JSON response format
  try {
    const parsed = JSON.parse(output)
    if (!parsed.ok) {
      throw new Error(parsed.error?.message || "Failed to get Front token")
    }
    // If parsed successfully but has ok:true, something is wrong
    throw new Error("Unexpected JSON response from secrets lease")
  } catch (e) {
    // If it's not JSON, it's the raw token (expected)
    if (e instanceof SyntaxError) {
      return output
    }
    throw e
  }
}

async function frontGet(path: string, token: string): Promise<any> {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Front API ${res.status}: ${body}`)
  }
  return res.json()
}

async function frontPatch(
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<void> {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok && res.status !== 204) {
    const text = await res.text()
    throw new Error(`Front API ${res.status}: ${text}`)
  }
}

type Conversation = {
  id: string
  subject: string
  status: string
  from: { name: string; email: string }
  date: string
  tags: string[]
}

function mapConversation(c: any): Conversation {
  const r = c.recipient ?? {}
  const ts = c.last_message_at ?? c.created_at ?? 0
  return {
    id: c.id,
    subject: c.subject ?? "(no subject)",
    status: c.status ?? "unknown",
    from: {
      name: (r.name ?? "").slice(0, 40),
      email: r.handle ?? "unknown",
    },
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    tags: (c.tags ?? []).map((t: any) => t.name),
  }
}

// ── Commands ────────────────────────────────────────────────────────

const inboxesCmd = Command.make("inboxes", {}, () =>
  Effect.gen(function* () {
    const token = frontToken()
    const data = yield* Effect.tryPromise(() =>
      frontGet("/teammates/tea_hjx3/inboxes", token),
    )
    const inboxes = (data._results ?? []).map((i: any) => ({
      id: i.id,
      name: i.name,
      type: i.type ?? "unknown",
      address: i.address ?? null,
    }))

    yield* Console.log(
      respond("email inboxes", { count: inboxes.length, inboxes }, [
        {
          command: "joelclaw email inbox",
          description: "Scan open conversations across all inboxes",
        },
      ]),
    )
  }),
)

/**
 * Build a Front search query from structured options.
 *
 * Front search API reference (authoritative):
 *   Endpoint: GET /conversations/search/{url_encoded_query}
 *   Filters (AND logic between different filters, OR for multiple from:/to:/cc:/bcc:):
 *     is:open|archived|assigned|unassigned|snoozed|trashed|unreplied|waiting|resolved
 *     from:<handle>        — sender handle (email, social, etc.)
 *     to:<handle>          — recipient (to/cc/bcc)
 *     cc:<handle>          — CC recipient
 *     bcc:<handle>         — BCC recipient
 *     recipient:<handle>   — any role (from, to, cc, bcc)
 *     inbox:<inbox_id>     — e.g. inbox:inb_41w25
 *     tag:<tag_id>         — e.g. tag:tag_13o8r1
 *     link:<link_id>       — linked record
 *     contact:<contact_id> — contact in any recipient role
 *     assignee:<tea_id>    — assigned teammate
 *     participant:<tea_id> — any participating teammate
 *     author:<tea_id>      — message author (teammate)
 *     mention:<tea_id>     — mentioned teammate
 *     commenter:<tea_id>   — commenting teammate
 *     before:<unix_ts>     — messages/comments before timestamp (seconds)
 *     after:<unix_ts>      — messages/comments after timestamp (seconds)
 *     during:<unix_ts>     — messages/comments on same day as timestamp
 *     custom_field:"<name>=<value>"
 *   Free text: searches subject + body. Phrases in quotes.
 *   No negation support (no -from:, no NOT).
 *   Results sorted by last activity date (not configurable).
 *   Pagination via _pagination.next URL with page_token param.
 */
function dateToUnix(dateStr: string): number | null {
  const ts = Math.floor(new Date(dateStr).getTime() / 1000)
  return isNaN(ts) ? null : ts
}

function buildFrontQuery(opts: {
  base?: string
  from?: string
  before?: string  // YYYY-MM-DD → converted to unix ts
  after?: string   // YYYY-MM-DD → converted to unix ts
}): string {
  const parts: string[] = []
  if (opts.base) parts.push(opts.base)
  if (opts.from) parts.push(`from:${opts.from}`)
  if (opts.before) {
    const ts = dateToUnix(opts.before)
    if (ts) parts.push(`before:${ts}`)
  }
  if (opts.after) {
    const ts = dateToUnix(opts.after)
    if (ts) parts.push(`after:${ts}`)
  }
  return parts.join(" ") || "is:open"
}

const inboxCmd = Command.make(
  "inbox",
  {
    limit: Options.integer("limit").pipe(
      Options.withDefault(50),
      Options.withAlias("n"),
    ),
    query: Options.text("query").pipe(
      Options.withAlias("q"),
      Options.optional,
    ),
    from: Options.text("from").pipe(
      Options.withDescription("Filter by sender email/handle"),
      Options.optional,
    ),
    before: Options.text("before").pipe(
      Options.withDescription("Before date (YYYY-MM-DD) — converted to unix timestamp"),
      Options.optional,
    ),
    after: Options.text("after").pipe(
      Options.withDescription("After date (YYYY-MM-DD) — converted to unix timestamp"),
      Options.optional,
    ),
    pageToken: Options.text("page-token").pipe(
      Options.withDescription("Pagination token from previous response"),
      Options.optional,
    ),
  },
  ({ limit, query, from, before, after, pageToken }) =>
    Effect.gen(function* () {
      const token = frontToken()
      const baseQ = query._tag === "Some" ? query.value : "is:open"
      const q = buildFrontQuery({
        base: baseQ,
        from: from._tag === "Some" ? from.value : undefined,
        before: before._tag === "Some" ? before.value : undefined,
        after: after._tag === "Some" ? after.value : undefined,
      })
      const searchQ = encodeURIComponent(q)
      let url = `/conversations/search/${searchQ}?limit=${Math.min(limit, 100)}`
      if (pageToken._tag === "Some" && pageToken.value) {
        url += `&page_token=${encodeURIComponent(pageToken.value)}`
      }

      const data = yield* Effect.tryPromise(() =>
        frontGet(url, token),
      )

      const total = data._total ?? "?"
      const conversations = (data._results ?? []).map(mapConversation)
      const nextPageToken = data._pagination?.next
        ? new URL(data._pagination.next).searchParams.get("page_token")
        : null

      const actions: any[] = [
        {
          command: "joelclaw email archive --id <conversation-id>",
          description: "Archive a conversation",
          params: {
            "conversation-id": { description: "Conversation ID", required: true },
          },
        },
        {
          command: "joelclaw email archive-ids --ids <id1,id2,...>",
          description: "Archive multiple conversations by ID (comma-separated)",
        },
        {
          command: `joelclaw email archive-bulk -q "${q}" --confirm`,
          description: "Bulk archive all matching conversations",
        },
      ]
      if (nextPageToken) {
        actions.unshift({
          command: `joelclaw email inbox -q "${q}" -n ${limit} --page-token "${nextPageToken}"`,
          description: "Next page of results",
        })
      }

      yield* Console.log(
        respond(
          "email inbox",
          {
            total,
            showing: conversations.length,
            query: q,
            conversations,
            ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
          },
          actions,
        ),
      )
    }),
)

const archiveCmd = Command.make(
  "archive",
  {
    conversationId: Options.text("id").pipe(Options.withAlias("i")),
  },
  ({ conversationId }) =>
    Effect.gen(function* () {
      const token = frontToken()
      yield* Effect.tryPromise(() =>
        frontPatch(`/conversations/${conversationId}`, { status: "archived" }, token),
      )

      yield* Console.log(
        respond(
          "email archive",
          { archived: conversationId },
          [
            {
              command: "joelclaw email inbox",
              description: "Check remaining open conversations",
            },
          ],
        ),
      )
    }),
)

const archiveIdsCmd = Command.make(
  "archive-ids",
  {
    ids: Options.text("ids").pipe(
      Options.withDescription("Comma-separated conversation IDs to archive"),
    ),
  },
  ({ ids }) =>
    Effect.gen(function* () {
      const token = frontToken()
      const idList = ids.split(",").map((s) => s.trim()).filter(Boolean)

      if (idList.length === 0) {
        yield* Console.log(
          respondError(
            "email archive-ids",
            "No conversation IDs provided",
            "MISSING_IDS",
            "Pass comma-separated IDs: --ids cnv_abc,cnv_def",
          ),
        )
        return
      }

      // Archive in parallel batches of 10 (Front rate limit: 50 req/s)
      const batchSize = 10
      let archived = 0
      let errors = 0
      const failed: string[] = []

      for (let i = 0; i < idList.length; i += batchSize) {
        const batch = idList.slice(i, i + batchSize)
        const results = yield* Effect.all(
          batch.map((id) =>
            Effect.tryPromise(() =>
              frontPatch(`/conversations/${id}`, { status: "archived" }, token),
            ).pipe(
              Effect.map(() => ({ id, ok: true })),
              Effect.catchAll(() => Effect.succeed({ id, ok: false })),
            ),
          ),
          { concurrency: batchSize },
        )
        for (const r of results) {
          if (r.ok) archived++
          else { errors++; failed.push(r.id) }
        }
      }

      yield* Console.log(
        respond(
          "email archive-ids",
          {
            archived,
            errors,
            total: idList.length,
            ...(failed.length > 0 ? { failed } : {}),
          },
          [
            {
              command: "joelclaw email inbox",
              description: "Check remaining open conversations",
            },
          ],
        ),
      )
    }),
)

const archiveBulkCmd = Command.make(
  "archive-bulk",
  {
    query: Options.text("query").pipe(Options.withAlias("q")),
    confirm: Options.boolean("confirm").pipe(Options.withDefault(false)),
    limit: Options.integer("limit").pipe(Options.withDefault(100)),
  },
  ({ query, confirm, limit }) =>
    Effect.gen(function* () {
      const token = frontToken()
      const searchQ = encodeURIComponent(query)
      const data = yield* Effect.tryPromise(() =>
        frontGet(`/conversations/search/${searchQ}?limit=${limit}`, token),
      )

      const total = data._total ?? 0
      const ids = (data._results ?? []).map((c: any) => c.id)

      if (!confirm) {
        yield* Console.log(
          respond(
            "email archive-bulk",
            {
              dry_run: true,
              query,
              total_matching: total,
              batch_size: ids.length,
              sample: (data._results ?? []).slice(0, 5).map(mapConversation),
            },
            [
              {
                command: "joelclaw email archive-bulk --query <query> [--confirm]",
                description: `Archive ${ids.length} conversations (pass --confirm to execute)`,
                params: {
                  query: { description: "Front search query", value: query, required: true },
                },
              },
            ],
          ),
        )
        return
      }

      // Execute archive
      let archived = 0
      let errors = 0
      for (const id of ids) {
        const archiveResult = yield* Effect.tryPromise(() =>
          frontPatch(`/conversations/${id}`, { status: "archived" }, token),
        ).pipe(Effect.either)
        if (archiveResult._tag === "Right") {
          archived++
        } else {
          errors++
        }
      }

      yield* Console.log(
        respond(
          "email archive-bulk",
          { query, archived, errors, total_matching: total },
          [
            {
              command: "joelclaw email inbox",
              description: "Check remaining open conversations",
            },
            {
              command: "joelclaw email archive-bulk --query <query> [--confirm]",
              description: "Archive next batch (if more remain)",
              params: {
                query: { description: "Front search query", value: query, required: true },
              },
            },
          ],
        ),
      )
    }),
)

const readCmd = Command.make(
  "read",
  {
    conversationId: Options.text("id").pipe(Options.withAlias("i")),
  },
  ({ conversationId }) =>
    Effect.gen(function* () {
      const token = frontToken()
      const conv = yield* Effect.tryPromise(() =>
        frontGet(`/conversations/${conversationId}`, token),
      )
      const msgs = yield* Effect.tryPromise(() =>
        frontGet(`/conversations/${conversationId}/messages`, token),
      )

      const messages = (msgs._results ?? []).map((m: any) => ({
        id: m.id,
        from: {
          name:
            m.author?.first_name
              ? `${m.author.first_name} ${m.author.last_name ?? ""}`.trim()
              : (
                  m.recipients?.find((r: any) => r.role === "from")?.name ??
                  "unknown"
                ),
          email:
            m.author?.email ??
            m.recipients?.find((r: any) => r.role === "from")?.handle ??
            "unknown",
        },
        date: new Date((m.created_at ?? 0) * 1000).toISOString(),
        is_inbound: m.is_inbound,
        body_preview: (m.text ?? m.body ?? "").slice(0, 500),
      }))

      yield* Console.log(
        respond(
          "email read",
          {
            conversation: mapConversation(conv),
            messages,
          },
          [
            {
              command: "joelclaw email archive --id <conversation-id>",
              description: "Archive this conversation",
              params: {
                "conversation-id": { description: "Conversation ID", value: conversationId, required: true },
              },
            },
            {
              command: "joelclaw email inbox",
              description: "Back to inbox",
            },
          ],
        ),
      )
    }),
)

// ── Root ─────────────────────────────────────────────────────────────

export const emailCmd = Command.make("email", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      respond(
        "email",
        {
          description: "Email inbox operations via Front API",
          commands: [
            {
              name: "inboxes",
              description: "List available inboxes",
              usage: "joelclaw email inboxes",
            },
            {
              name: "inbox",
              description:
                "List open conversations (default: is:open). Use -q for custom queries, -n for limit.",
              usage: 'joelclaw email inbox -q "is:open" -n 50',
            },
            {
              name: "read",
              description: "Read a conversation's messages",
              usage: "joelclaw email read --id cnv_xxx",
            },
            {
              name: "archive",
              description: "Archive a single conversation",
              usage: "joelclaw email archive --id cnv_xxx",
            },
            {
              name: "archive-ids",
              description: "Archive multiple conversations by ID (parallel, batched)",
              usage: "joelclaw email archive-ids --ids cnv_abc,cnv_def,cnv_ghi",
            },
            {
              name: "archive-bulk",
              description:
                "Bulk archive conversations matching a Front search query. Dry-run by default; pass --confirm to execute.",
              usage:
                'joelclaw email archive-bulk -q "is:open before:1705536000" --confirm',
            },
          ],
        },
        [
          {
            command: "joelclaw email inboxes",
            description: "List your inboxes",
          },
          {
            command: "joelclaw email inbox",
            description: "Scan open conversations (default: is:open)",
          },
          {
            command: 'joelclaw email inbox -q "is:open is:unreplied"',
            description: "Show conversations awaiting reply",
          },
          {
            command: 'joelclaw email inbox --from notifications@github.com',
            description: "Filter by sender",
          },
          {
            command: 'joelclaw email inbox --before 2026-01-01',
            description: "Conversations with messages before a date",
          },
        ],
      ),
    )
  }),
).pipe(
  Command.withSubcommands([inboxesCmd, inboxCmd, readCmd, archiveCmd, archiveIdsCmd, archiveBulkCmd]),
)
