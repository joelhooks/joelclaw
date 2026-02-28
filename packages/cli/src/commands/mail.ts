import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { callMcpTool, fetchMailApi, getAgentMailUrl } from "../lib/agent-mail"
import type { NextAction } from "../response"
import { respond, respondError } from "../response"

const defaultProject = Options.text("project").pipe(
  Options.withDefault("/Users/joel/Code/joelhooks/joelclaw"),
  Options.withDescription("Project key — absolute path (default: joelclaw repo)"),
)

const defaultAgent = Options.text("agent").pipe(
  Options.withDefault("GreenPanda"),
  Options.withDescription("Agent name — AdjectiveNoun format (default: GreenPanda)"),
)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const parseJsonText = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const attempt = <T>(op: () => Promise<T>): Effect.Effect<T, Error> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => new Error(errorMessage(error)),
  })

const commandError = (
  command: string,
  code: string,
  fix: string,
  nextActions: readonly NextAction[],
) =>
  (error: unknown) =>
    Console.log(respondError(command, errorMessage(error), code, fix, nextActions))

const normalizeToolResult = (result: unknown): unknown => {
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

const toRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : []

const extractMessages = (input: unknown): Record<string, unknown>[] => {
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

const messageIdOf = (message: Record<string, unknown>): string | undefined =>
  asString(message.id)
  ?? asString(message.message_id)
  ?? asString(message.messageId)
  ?? asString(message.uuid)

const isUnreadMessage = (message: Record<string, unknown>): boolean => {
  if (typeof message.unread === "boolean") return message.unread
  if (typeof message.is_unread === "boolean") return message.is_unread
  if (typeof message.read === "boolean") return !message.read
  if (typeof message.read_at === "string") return message.read_at.trim().length === 0
  if (typeof message.status === "string") return message.status.toLowerCase() === "unread"
  return false
}

const pathListFromCsv = (paths: string): string[] =>
  paths
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)

const projectFromMessage = (message: Record<string, unknown>): string | undefined => {
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

const summarizeUnifiedInbox = (unifiedInbox: unknown): Record<string, unknown> => {
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

const asBoolOk = (value: unknown): boolean => {
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

const statusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const liveness = yield* attempt(() => fetchMailApi("/health/liveness"))
    const unifiedInbox = yield* attempt(() => fetchMailApi("/mail/api/unified-inbox"))

    yield* Console.log(
      respond(
        "mail status",
        {
          base_url: getAgentMailUrl(),
          liveness,
          unified_inbox: summarizeUnifiedInbox(unifiedInbox),
        },
        [
          {
            command: "joelclaw mail inbox",
            description: "View inbox for default agent",
          },
          {
            command: "joelclaw mail locks",
            description: "View active file reservations",
          },
        ],
        asBoolOk(liveness),
      ),
    )
  }).pipe(
    Effect.catchAll(
      commandError(
        "mail status",
        "MAIL_STATUS_FAILED",
        "Ensure mcp_agent_mail is running on http://127.0.0.1:8765",
        [{ command: "joelclaw mail status", description: "Retry mail status" }],
      ),
    ),
  ),
).pipe(Command.withDescription("Server liveness + unified inbox summary"))

const registerCmd = Command.make(
  "register",
  {
    project: defaultProject,
    agent: defaultAgent,
    program: Options.text("program").pipe(
      Options.withDefault("pi"),
      Options.withDescription("Agent program (e.g. pi, codex-cli, claude-code)"),
    ),
    model: Options.text("model").pipe(
      Options.withDefault("claude-sonnet-4"),
      Options.withDescription("Underlying model"),
    ),
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Short task description"),
    ),
  },
  ({ project, agent, program, model, task }) =>
    Effect.gen(function* () {
      // ensure_project first (idempotent) — needs human_key (abs path)
      yield* attempt(() => callMcpTool("ensure_project", { human_key: project }))

      const args: Record<string, unknown> = {
        project_key: project,
        name: agent,
        program,
        model,
      }
      if (task._tag === "Some") args.task_description = task.value

      const result = normalizeToolResult(
        yield* attempt(() => callMcpTool("register_agent", args)),
      )

      yield* Console.log(
        respond(
          "mail register",
          {
            project,
            agent,
            program,
            model,
            task: task._tag === "Some" ? task.value : undefined,
            result,
          },
          [
            {
              command: "joelclaw mail status",
              description: "Check server and mailbox health",
            },
            {
              command: "joelclaw mail inbox",
              description: "Fetch inbox for registered agent",
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail register",
          "MAIL_REGISTER_FAILED",
          "Verify project/agent and mcp_agent_mail availability",
          [{ command: "joelclaw mail register --project <project> --agent <agent>", description: "Retry register" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Register an agent"))

const sendCmd = Command.make(
  "send",
  {
    project: defaultProject,
    from: Options.text("from").pipe(Options.withDescription("Sender agent name")),
    to: Options.text("to").pipe(Options.withDescription("Recipient agent name")),
    subject: Options.text("subject").pipe(Options.withDescription("Message subject")),
    body: Args.text({ name: "body" }).pipe(Args.withDescription("Message body")),
  },
  ({ project, from, to, subject, body }) =>
    Effect.gen(function* () {
      const result = normalizeToolResult(
        yield* attempt(() =>
          callMcpTool("send_message", {
            project_key: project,
            sender_name: from,
            to: [to],
            subject,
            body_md: body,
          }),
        ),
      )

      yield* Console.log(
        respond(
          "mail send",
          {
            project,
            from,
            to,
            subject,
            body,
            result,
          },
          [
            {
              command: "joelclaw mail inbox --project <project> --agent <agent>",
              description: "Check recipient inbox",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: to, required: true, description: "Recipient agent" },
              },
            },
            {
              command: "joelclaw mail search --project <project> --query <text>",
              description: "Search the new message",
              params: {
                project: { value: project, required: true, description: "Project key" },
                text: { value: subject, required: true, description: "Search query" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail send",
          "MAIL_SEND_FAILED",
          "Verify sender/recipient and retry",
          [{ command: "joelclaw mail send --project <project> --from <agent> --to <agent> --subject <subject> <body>", description: "Retry send" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Send a message"))

const inboxCmd = Command.make(
  "inbox",
  {
    project: defaultProject,
    agent: defaultAgent,
    unread: Options.boolean("unread").pipe(
      Options.withDefault(false),
      Options.withDescription("Only unread messages"),
    ),
  },
  ({ project, agent, unread }) =>
    Effect.gen(function* () {
      const raw = yield* attempt(() =>
        callMcpTool("fetch_inbox", {
          project_key: project,
          agent_name: agent,
        }),
      )

      const normalized = normalizeToolResult(raw)
      const allMessages = extractMessages(normalized)
      const messages = unread ? allMessages.filter(isUnreadMessage) : allMessages

      yield* Console.log(
        respond(
          "mail inbox",
          {
            project,
            agent,
            unread_only: unread,
            total_messages: allMessages.length,
            unread_messages: allMessages.filter(isUnreadMessage).length,
            count: messages.length,
            messages,
            raw: allMessages.length > 0 ? undefined : normalized,
          },
          [
            {
              command: "joelclaw mail read --project <project> --agent <agent> --id <message_id>",
              description: "Mark and view a message",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: agent, required: true, description: "Agent name" },
                message_id: {
                  value: messageIdOf(messages[0] ?? {}) ?? "MESSAGE_ID",
                  required: true,
                  description: "Message identifier",
                },
              },
            },
            {
              command: "joelclaw mail inbox --project <project> --agent <agent> --unread",
              description: "Show unread only",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: agent, required: true, description: "Agent name" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail inbox",
          "MAIL_INBOX_FAILED",
          "Verify project/agent and server availability",
          [{ command: "joelclaw mail inbox --project <project> --agent <agent>", description: "Retry inbox fetch" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Fetch inbox messages"))

const readCmd = Command.make(
  "read",
  {
    project: defaultProject,
    agent: defaultAgent,
    id: Options.text("id").pipe(Options.withDescription("Message ID")),
  },
  ({ project, agent, id }) =>
    Effect.gen(function* () {
      const marked = normalizeToolResult(
        yield* attempt(() =>
          callMcpTool("mark_message_read", {
            project_key: project,
            agent_name: agent,
            message_id: id,
          }),
        ),
      )

      const inboxRaw = yield* attempt(() =>
        callMcpTool("fetch_inbox", {
          project_key: project,
          agent_name: agent,
        }),
      )

      const message =
        extractMessages(inboxRaw).find((candidate) => messageIdOf(candidate) === id) ?? null

      yield* Console.log(
        respond(
          "mail read",
          {
            project,
            agent,
            message_id: id,
            marked_read: marked,
            message,
          },
          [
            {
              command: "joelclaw mail inbox --project <project> --agent <agent>",
              description: "Back to inbox",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: agent, required: true, description: "Agent name" },
              },
            },
            {
              command: "joelclaw mail search --project <project> --query <text>",
              description: "Search related messages",
              params: {
                project: { value: project, required: true, description: "Project key" },
                text: { value: id, required: true, description: "Search query" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail read",
          "MAIL_READ_FAILED",
          "Verify message id and retry",
          [{ command: "joelclaw mail read --project <project> --agent <agent> --id <message_id>", description: "Retry read" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Mark message read and display it"))

const reserveCmd = Command.make(
  "reserve",
  {
    project: defaultProject,
    agent: defaultAgent,
    paths: Options.text("paths").pipe(
      Options.withDescription("Comma-separated paths"),
    ),
  },
  ({ project, agent, paths }) =>
    Effect.gen(function* () {
      const parsedPaths = pathListFromCsv(paths)
      if (parsedPaths.length === 0) {
        yield* Console.log(
          respondError(
            "mail reserve",
            "--paths must include at least one path",
            "MAIL_RESERVE_PATHS_REQUIRED",
            "Provide comma-separated paths via --paths",
            [{ command: "joelclaw mail reserve --project <project> --agent <agent> --paths <comma-separated-paths>", description: "Retry with valid paths" }],
          ),
        )
        return
      }

      const result = normalizeToolResult(
        yield* attempt(() =>
          callMcpTool("file_reservation_paths", {
            project_key: project,
            agent_name: agent,
            paths: parsedPaths,
          }),
        ),
      )

      yield* Console.log(
        respond(
          "mail reserve",
          {
            project,
            agent,
            paths: parsedPaths,
            result,
          },
          [
            {
              command: "joelclaw mail locks --project <project>",
              description: "View active locks",
              params: {
                project: { value: project, required: true, description: "Project key" },
              },
            },
            {
              command: "joelclaw mail release --project <project> --agent <agent> --paths <paths>",
              description: "Release the same paths",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: agent, required: true, description: "Agent name" },
                paths: { value: parsedPaths.join(","), required: true, description: "Paths CSV" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail reserve",
          "MAIL_RESERVE_FAILED",
          "Verify paths and registration, then retry",
          [{ command: "joelclaw mail reserve --project <project> --agent <agent> --paths <comma-separated-paths>", description: "Retry reserve" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Reserve file paths"))

const releaseCmd = Command.make(
  "release",
  {
    project: defaultProject,
    agent: defaultAgent,
    paths: Options.text("paths").pipe(
      Options.optional,
      Options.withDescription("Comma-separated paths"),
    ),
    all: Options.boolean("all").pipe(
      Options.withDefault(false),
      Options.withDescription("Release all agent locks"),
    ),
  },
  ({ project, agent, paths, all }) =>
    Effect.gen(function* () {
      const parsedPaths = paths._tag === "Some" ? pathListFromCsv(paths.value) : []
      if (!all && parsedPaths.length === 0) {
        yield* Console.log(
          respondError(
            "mail release",
            "Provide --all or --paths",
            "MAIL_RELEASE_SCOPE_REQUIRED",
            "Use --all to release everything or --paths for specific files",
            [
              { command: "joelclaw mail release --project <project> --agent <agent> --all", description: "Release all for an agent" },
              { command: "joelclaw mail release --project <project> --agent <agent> --paths <comma-separated-paths>", description: "Release selected paths" },
            ],
          ),
        )
        return
      }

      const args: Record<string, unknown> = {
        project_key: project,
        agent_name: agent,
      }
      if (all) args.all = true
      if (parsedPaths.length > 0) args.paths = parsedPaths

      const result = normalizeToolResult(
        yield* attempt(() => callMcpTool("release_file_reservations", args)),
      )

      yield* Console.log(
        respond(
          "mail release",
          {
            project,
            agent,
            all,
            paths: parsedPaths,
            result,
          },
          [
            {
              command: "joelclaw mail locks --project <project>",
              description: "Check active locks",
              params: {
                project: { value: project, required: true, description: "Project key" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail release",
          "MAIL_RELEASE_FAILED",
          "Verify release scope and retry",
          [{ command: "joelclaw mail release --project <project> --agent <agent> [--paths <paths>] [--all]", description: "Retry release" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Release file reservations"))

const locksCmd = Command.make(
  "locks",
  {
    project: defaultProject,
  },
  ({ project }) =>
    Effect.gen(function* () {
      const locks = yield* attempt(() =>
        fetchMailApi("/mail/api/locks"),
      )

      const lockRows = toRecordArray(locks)
      const count = lockRows.length > 0
        ? lockRows.length
        : asNumber(asRecord(locks)?.count) ?? 0

      yield* Console.log(
        respond(
          "mail locks",
          {
            project,
            count,
            locks,
          },
          [
            {
              command: "joelclaw mail reserve --project <project> --agent <agent> --paths <paths>",
              description: "Reserve additional files",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: "panda", required: true, description: "Agent name" },
                paths: { value: "packages/cli/src/cli.ts", required: true, description: "Paths CSV" },
              },
            },
            {
              command: "joelclaw mail release --project <project> --agent <agent> --all",
              description: "Release all locks",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: "panda", required: true, description: "Agent name" },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail locks",
          "MAIL_LOCKS_FAILED",
          "Verify project and server availability",
          [{ command: "joelclaw mail locks --project <project>", description: "Retry locks query" }],
        ),
      ),
    ),
).pipe(Command.withDescription("List active file reservations"))

const searchCmd = Command.make(
  "search",
  {
    project: defaultProject,
    query: Options.text("query").pipe(Options.withDescription("Search text")),
  },
  ({ project, query }) =>
    Effect.gen(function* () {
      const raw = yield* attempt(() =>
        callMcpTool("search_messages", {
          project_key: project,
          query,
        }),
      )

      const normalized = normalizeToolResult(raw)
      const messages = extractMessages(normalized)

      yield* Console.log(
        respond(
          "mail search",
          {
            project,
            query,
            count: messages.length,
            messages: messages.length > 0 ? messages : undefined,
            result: messages.length > 0 ? undefined : normalized,
          },
          [
            {
              command: "joelclaw mail inbox --project <project> --agent <agent>",
              description: "Open inbox for inspection",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: "panda", required: true, description: "Agent name" },
              },
            },
            {
              command: "joelclaw mail read --project <project> --agent <agent> --id <message_id>",
              description: "Open a matching message",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: "panda", required: true, description: "Agent name" },
                message_id: {
                  value: messageIdOf(messages[0] ?? {}) ?? "MESSAGE_ID",
                  required: true,
                  description: "Message id from result",
                },
              },
            },
          ],
        ),
      )
    }).pipe(
      Effect.catchAll(
        commandError(
          "mail search",
          "MAIL_SEARCH_FAILED",
          "Verify query/project and retry",
          [{ command: "joelclaw mail search --project <project> --query <text>", description: "Retry search" }],
        ),
      ),
    ),
).pipe(Command.withDescription("Search project mailbox"))

export const mailCmd = Command.make("mail", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      respond(
        "mail",
        {
          description: "Agent mail coordination commands (ADR-0172 phase 1)",
          base_url: getAgentMailUrl(),
          commands: {
            status: "joelclaw mail status",
            register: "joelclaw mail register --project <project> --agent <agent> [--role <role>]",
            send: "joelclaw mail send --project <project> --from <agent> --to <agent> --subject <subject> <body>",
            inbox: "joelclaw mail inbox --project <project> --agent <agent> [--unread]",
            read: "joelclaw mail read --project <project> --agent <agent> --id <message_id>",
            reserve: "joelclaw mail reserve --project <project> --agent <agent> --paths <comma-separated-paths>",
            release: "joelclaw mail release --project <project> --agent <agent> [--paths <paths>] [--all]",
            locks: "joelclaw mail locks --project <project>",
            search: "joelclaw mail search --project <project> --query <text>",
          },
        },
        [
          {
            command: "joelclaw mail status",
            description: "Check mail service health",
          },
          {
            command: "joelclaw mail register",
            description: "Register default agent (joelclaw/panda)",
          },
          {
            command: "joelclaw mail inbox",
            description: "Fetch inbox for default agent",
          },
        ],
      ),
    )
  }),
).pipe(
  Command.withDescription("Agent-to-agent mail coordination via mcp_agent_mail"),
  Command.withSubcommands([
    statusCmd,
    registerCmd,
    sendCmd,
    inboxCmd,
    readCmd,
    reserveCmd,
    releaseCmd,
    locksCmd,
    searchCmd,
  ]),
)
