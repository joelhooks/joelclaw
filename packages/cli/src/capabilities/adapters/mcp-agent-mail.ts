import { Effect, Schema } from "effect"
import { callMcpTool, fetchMailApi, getAgentMailUrl } from "../../lib/agent-mail"
import { type CapabilityPort, capabilityError } from "../contract"

const MailStatusArgsSchema = Schema.Struct({})
const MailStatusResultSchema = Schema.Unknown

const MailRegisterArgsSchema = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  program: Schema.String,
  model: Schema.String,
  task: Schema.optional(Schema.String),
})
const MailRegisterResultSchema = Schema.Unknown

const MailSendArgsSchema = Schema.Struct({
  project: Schema.String,
  from: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
})
const MailSendResultSchema = Schema.Unknown

const MailInboxArgsSchema = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  unread: Schema.Boolean,
})
const MailInboxResultSchema = Schema.Unknown

const MailReadArgsSchema = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  id: Schema.String,
})
const MailReadResultSchema = Schema.Unknown

const MailReserveArgsSchema = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  paths: Schema.Array(Schema.String),
})
const MailReserveResultSchema = Schema.Unknown

const MailReleaseArgsSchema = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  paths: Schema.Array(Schema.String),
  all: Schema.Boolean,
})
const MailReleaseResultSchema = Schema.Unknown

const MailLocksArgsSchema = Schema.Struct({
  project: Schema.String,
})
const MailLocksResultSchema = Schema.Unknown

const MailSearchArgsSchema = Schema.Struct({
  project: Schema.String,
  query: Schema.String,
})
const MailSearchResultSchema = Schema.Unknown

const commands = {
  status: {
    summary: "Server liveness + unified inbox summary",
    argsSchema: MailStatusArgsSchema,
    resultSchema: MailStatusResultSchema,
  },
  register: {
    summary: "Register an agent",
    argsSchema: MailRegisterArgsSchema,
    resultSchema: MailRegisterResultSchema,
  },
  send: {
    summary: "Send a message",
    argsSchema: MailSendArgsSchema,
    resultSchema: MailSendResultSchema,
  },
  inbox: {
    summary: "Fetch inbox messages",
    argsSchema: MailInboxArgsSchema,
    resultSchema: MailInboxResultSchema,
  },
  read: {
    summary: "Mark message read and display it",
    argsSchema: MailReadArgsSchema,
    resultSchema: MailReadResultSchema,
  },
  reserve: {
    summary: "Reserve file paths",
    argsSchema: MailReserveArgsSchema,
    resultSchema: MailReserveResultSchema,
  },
  release: {
    summary: "Release file reservations",
    argsSchema: MailReleaseArgsSchema,
    resultSchema: MailReleaseResultSchema,
  },
  locks: {
    summary: "List active file reservations",
    argsSchema: MailLocksArgsSchema,
    resultSchema: MailLocksResultSchema,
  },
  search: {
    summary: "Search project mailbox",
    argsSchema: MailSearchArgsSchema,
    resultSchema: MailSearchResultSchema,
  },
} as const

type MailCommandName = keyof typeof commands

function decodeArgs<K extends MailCommandName>(
  subcommand: K,
  args: unknown
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "MAIL_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw mail ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function normalizeToolResult(result: unknown): unknown {
  const record = asRecord(result)
  if (!record) return result

  if (record.structuredContent !== undefined) {
    return record.structuredContent
  }

  if (Array.isArray(record.content)) {
    const texts = record.content
      .map((item) => {
        const entry = asRecord(item)
        if (!entry) return undefined
        return asString(entry.text)
      })
      .filter((value): value is string => Boolean(value))

    if (texts.length === 1) return parseJsonText(texts[0])
    if (texts.length > 1) return texts.map(parseJsonText)
  }

  return result
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : []
}

function extractMessages(input: unknown): Record<string, unknown>[] {
  const normalized = normalizeToolResult(input)
  const direct = toRecordArray(normalized)
  if (direct.length > 0) return direct

  const record = asRecord(normalized)
  if (!record) return []

  const candidates = [record.messages, record.inbox, record.items, record.results, record.result, record.data]
  for (const candidate of candidates) {
    const rows = toRecordArray(candidate)
    if (rows.length > 0) return rows

    const nested = asRecord(candidate)
    if (!nested) continue

    const nestedRows = [nested.messages, nested.inbox, nested.items, nested.results, nested.data]
    for (const nestedCandidate of nestedRows) {
      const list = toRecordArray(nestedCandidate)
      if (list.length > 0) return list
    }
  }

  return []
}

function messageIdOf(message: Record<string, unknown>): string | undefined {
  return asString(message.id)
    ?? asString(message.message_id)
    ?? asString(message.messageId)
    ?? asString(message.uuid)
}

function isUnreadMessage(message: Record<string, unknown>): boolean {
  if (typeof message.unread === "boolean") return message.unread
  if (typeof message.is_unread === "boolean") return message.is_unread
  if (typeof message.read === "boolean") return !message.read
  if (typeof message.read_at === "string") return message.read_at.trim().length === 0
  if (typeof message.status === "string") return message.status.toLowerCase() === "unread"
  return false
}

function projectFromMessage(message: Record<string, unknown>): string | undefined {
  const direct =
    asString(message.project_key)
    ?? asString(message.projectKey)
    ?? asString(message.project_id)
    ?? asString(message.project)
  if (direct) return direct

  const nestedProject = asRecord(message.project)
  if (!nestedProject) return undefined

  return (
    asString(nestedProject.key)
    ?? asString(nestedProject.project_key)
    ?? asString(nestedProject.name)
    ?? asString(nestedProject.id)
  )
}

function summarizeUnifiedInbox(unifiedInbox: unknown): Record<string, unknown> {
  const normalized = normalizeToolResult(unifiedInbox)
  const summary: Record<string, unknown> = {}
  const messages = extractMessages(normalized)

  if (messages.length > 0) {
    summary.message_count = messages.length
    summary.unread_count = messages.filter(isUnreadMessage).length

    const projects = new Set<string>()
    for (const message of messages) {
      const project = projectFromMessage(message)
      if (project) projects.add(project)
    }

    summary.project_count = projects.size
    if (projects.size > 0) summary.projects = Array.from(projects).sort()
    return summary
  }

  const record = asRecord(normalized)
  if (!record) {
    return { message_count: 0, unread_count: 0, project_count: 0 }
  }

  summary.message_count =
    asNumber(record.message_count)
    ?? asNumber(record.messages_count)
    ?? asNumber(record.count)
    ?? 0
  summary.unread_count =
    asNumber(record.unread_count)
    ?? asNumber(record.unread)
    ?? 0
  summary.project_count =
    asNumber(record.project_count)
    ?? asNumber(record.projects_count)
    ?? toRecordArray(record.projects).length

  if (Array.isArray(record.projects)) summary.projects = record.projects
  return summary
}

function asBoolOk(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  if (typeof record.ok === "boolean") return record.ok
  if (typeof record.alive === "boolean") return record.alive
  if (typeof record.status === "string") {
    const status = record.status.toLowerCase()
    return status === "ok" || status === "healthy" || status === "alive"
  }
  return true
}

function mapMailError(code: string, fix: string) {
  return (error: unknown) =>
    capabilityError(
      code,
      error instanceof Error ? error.message : String(error),
      fix
    )
}

export const mcpAgentMailAdapter: CapabilityPort<typeof commands> = {
  capability: "mail",
  adapter: "mcp-agent-mail",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "status": {
          yield* decodeArgs("status", rawArgs)
          const liveness = yield* Effect.tryPromise(() => fetchMailApi("/health/liveness")).pipe(
            Effect.mapError(mapMailError("MAIL_STATUS_FAILED", "Ensure mcp_agent_mail is running on http://127.0.0.1:8765"))
          )
          const unifiedInbox = yield* Effect.tryPromise(() => fetchMailApi("/mail/api/unified-inbox")).pipe(
            Effect.mapError(mapMailError("MAIL_STATUS_FAILED", "Ensure mcp_agent_mail is running on http://127.0.0.1:8765"))
          )

          return {
            base_url: getAgentMailUrl(),
            liveness,
            unified_inbox: summarizeUnifiedInbox(unifiedInbox),
            healthy: asBoolOk(liveness),
          }
        }
        case "register": {
          const args = yield* decodeArgs("register", rawArgs)
          yield* Effect.tryPromise(() => callMcpTool("ensure_project", { human_key: args.project })).pipe(
            Effect.mapError(mapMailError("MAIL_REGISTER_FAILED", "Verify project/agent and mcp_agent_mail availability"))
          )

          const registerArgs: Record<string, unknown> = {
            project_key: args.project,
            name: args.agent,
            program: args.program,
            model: args.model,
          }
          if (args.task?.trim()) registerArgs.task_description = args.task

          const result = yield* Effect.tryPromise(() => callMcpTool("register_agent", registerArgs)).pipe(
            Effect.map(normalizeToolResult),
            Effect.mapError(mapMailError("MAIL_REGISTER_FAILED", "Verify project/agent and mcp_agent_mail availability"))
          )

          return {
            project: args.project,
            agent: args.agent,
            program: args.program,
            model: args.model,
            task: args.task,
            result,
          }
        }
        case "send": {
          const args = yield* decodeArgs("send", rawArgs)
          const result = yield* Effect.tryPromise(() =>
            callMcpTool("send_message", {
              project_key: args.project,
              sender_name: args.from,
              to: [args.to],
              subject: args.subject,
              body_md: args.body,
            })
          ).pipe(
            Effect.map(normalizeToolResult),
            Effect.mapError(mapMailError("MAIL_SEND_FAILED", "Verify sender/recipient and retry"))
          )

          return {
            project: args.project,
            from: args.from,
            to: args.to,
            subject: args.subject,
            body: args.body,
            result,
          }
        }
        case "inbox": {
          const args = yield* decodeArgs("inbox", rawArgs)
          const raw = yield* Effect.tryPromise(() =>
            callMcpTool("fetch_inbox", {
              project_key: args.project,
              agent_name: args.agent,
            })
          ).pipe(
            Effect.mapError(mapMailError("MAIL_INBOX_FAILED", "Verify project/agent and server availability"))
          )

          const normalized = normalizeToolResult(raw)
          const allMessages = extractMessages(normalized)
          const messages = args.unread ? allMessages.filter(isUnreadMessage) : allMessages

          return {
            project: args.project,
            agent: args.agent,
            unread_only: args.unread,
            total_messages: allMessages.length,
            unread_messages: allMessages.filter(isUnreadMessage).length,
            count: messages.length,
            messages,
            raw: allMessages.length > 0 ? undefined : normalized,
          }
        }
        case "read": {
          const args = yield* decodeArgs("read", rawArgs)
          const marked = yield* Effect.tryPromise(() =>
            callMcpTool("mark_message_read", {
              project_key: args.project,
              agent_name: args.agent,
              message_id: args.id,
            })
          ).pipe(
            Effect.map(normalizeToolResult),
            Effect.mapError(mapMailError("MAIL_READ_FAILED", "Verify message id and retry"))
          )

          const inboxRaw = yield* Effect.tryPromise(() =>
            callMcpTool("fetch_inbox", {
              project_key: args.project,
              agent_name: args.agent,
            })
          ).pipe(
            Effect.mapError(mapMailError("MAIL_READ_FAILED", "Verify message id and retry"))
          )

          const message =
            extractMessages(inboxRaw).find((candidate) => messageIdOf(candidate) === args.id) ?? null

          return {
            project: args.project,
            agent: args.agent,
            message_id: args.id,
            marked_read: marked,
            message,
          }
        }
        case "reserve": {
          const args = yield* decodeArgs("reserve", rawArgs)
          if (args.paths.length === 0) {
            return yield* Effect.fail(
              capabilityError(
                "MAIL_RESERVE_PATHS_REQUIRED",
                "--paths must include at least one path",
                "Provide comma-separated paths via --paths"
              )
            )
          }
          const result = yield* Effect.tryPromise(() =>
            callMcpTool("file_reservation_paths", {
              project_key: args.project,
              agent_name: args.agent,
              paths: args.paths,
            })
          ).pipe(
            Effect.map(normalizeToolResult),
            Effect.mapError(mapMailError("MAIL_RESERVE_FAILED", "Verify paths and registration, then retry"))
          )

          return {
            project: args.project,
            agent: args.agent,
            paths: args.paths,
            result,
          }
        }
        case "release": {
          const args = yield* decodeArgs("release", rawArgs)
          if (!args.all && args.paths.length === 0) {
            return yield* Effect.fail(
              capabilityError(
                "MAIL_RELEASE_SCOPE_REQUIRED",
                "Provide --all or --paths",
                "Use --all to release everything or --paths for specific files"
              )
            )
          }

          const payload: Record<string, unknown> = {
            project_key: args.project,
            agent_name: args.agent,
          }
          if (args.all) payload.all = true
          if (args.paths.length > 0) payload.paths = args.paths

          const result = yield* Effect.tryPromise(() =>
            callMcpTool("release_file_reservations", payload)
          ).pipe(
            Effect.map(normalizeToolResult),
            Effect.mapError(mapMailError("MAIL_RELEASE_FAILED", "Verify release scope and retry"))
          )

          return {
            project: args.project,
            agent: args.agent,
            all: args.all,
            paths: args.paths,
            result,
          }
        }
        case "locks": {
          const args = yield* decodeArgs("locks", rawArgs)
          const locks = yield* Effect.tryPromise(() => fetchMailApi("/mail/api/locks")).pipe(
            Effect.mapError(mapMailError("MAIL_LOCKS_FAILED", "Verify project and server availability"))
          )
          const lockRows = toRecordArray(locks)
          const count = lockRows.length > 0
            ? lockRows.length
            : asNumber(asRecord(locks)?.count) ?? 0

          return {
            project: args.project,
            count,
            locks,
          }
        }
        case "search": {
          const args = yield* decodeArgs("search", rawArgs)
          const raw = yield* Effect.tryPromise(() =>
            callMcpTool("search_messages", {
              project_key: args.project,
              query: args.query,
            })
          ).pipe(
            Effect.mapError(mapMailError("MAIL_SEARCH_FAILED", "Verify query/project and retry"))
          )

          const normalized = normalizeToolResult(raw)
          const messages = extractMessages(normalized)

          return {
            project: args.project,
            query: args.query,
            count: messages.length,
            messages: messages.length > 0 ? messages : undefined,
            result: messages.length > 0 ? undefined : normalized,
          }
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "MAIL_SUBCOMMAND_UNSUPPORTED",
              `Unsupported mail subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __mailAdapterTestUtils = {
  normalizeToolResult,
  extractMessages,
  summarizeUnifiedInbox,
}
