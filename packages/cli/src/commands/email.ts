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
  return execSync("secrets lease front_api_token --ttl 15m", {
    encoding: "utf-8",
  }).trim()
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
  },
  ({ limit, query }) =>
    Effect.gen(function* () {
      const token = frontToken()
      const q = query._tag === "Some" ? query.value : "is:open"
      const searchQ = encodeURIComponent(q)

      const data = yield* Effect.tryPromise(() =>
        frontGet(
          `/conversations/search/${searchQ}?limit=${Math.min(limit, 100)}`,
          token,
        ),
      )

      const total = data._total ?? "?"
      const conversations = (data._results ?? []).map(mapConversation)

      yield* Console.log(
        respond(
          "email inbox",
          {
            total,
            showing: conversations.length,
            query: q,
            conversations,
          },
          [
            {
              command: "joelclaw email inbox [--query <query>] [--limit <limit>]",
              description: "Show only unread",
              params: {
                query: { description: "Front search query", value: "is:open is:unread", default: "is:open" },
                limit: { description: "Maximum conversations", value: 25, default: 50 },
              },
            },
            {
              command: "joelclaw email archive --id <conversation-id>",
              description: "Archive a conversation",
              params: {
                "conversation-id": { description: "Conversation ID", required: true },
              },
            },
            {
              command: "joelclaw email archive-bulk --query <query> [--confirm]",
              description: "Bulk archive old conversations",
              params: {
                query: { description: "Front search query", value: "is:open before:2026-01-01", required: true },
              },
            },
          ],
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
              name: "archive-bulk",
              description:
                "Bulk archive conversations matching a query. Dry-run by default; pass --confirm to execute.",
              usage:
                'joelclaw email archive-bulk -q "is:open before:2026-01-18" --confirm',
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
            description: "Scan open conversations",
          },
          {
            command: "joelclaw email inbox [--query <query>]",
            description: "Show unread only",
            params: {
              query: { description: "Front search query", value: "is:open is:unread", default: "is:open" },
            },
          },
        ],
      ),
    )
  }),
).pipe(
  Command.withSubcommands([inboxesCmd, inboxCmd, readCmd, archiveCmd, archiveBulkCmd]),
)
