import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { getAgentMailUrl } from "../lib/agent-mail"
import { type NextAction, respond, respondError } from "../response"

const defaultProject = Options.text("project").pipe(
  Options.withDefault("/Users/joel/Code/joelhooks/joelclaw"),
  Options.withDescription("Project key — absolute path (default: joelclaw repo)"),
)

const defaultAgent = Options.text("agent").pipe(
  Options.withDefault("MaroonReef"),
  Options.withDescription("Agent name — AdjectiveNoun format (default: MaroonReef)"),
)

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function pathListFromCsv(paths: string): string[] {
  return paths
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
}

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function messageIdOf(message: Record<string, unknown>): string | undefined {
  return asString(message.id)
    ?? asString(message.message_id)
    ?? asString(message.messageId)
    ?? asString(message.uuid)
}

const statusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const result = yield* executeCapabilityCommand<{
      base_url: string
      liveness: unknown
      unified_inbox: unknown
      healthy?: boolean
    }>({
      capability: "mail",
      subcommand: "status",
      args: {},
    }).pipe(Effect.either)

    if (result._tag === "Left") {
      const error = result.left
      yield* Console.log(
        respondError(
          "mail status",
          error.message,
          codeOrFallback(error, "MAIL_STATUS_FAILED"),
          fixOrFallback(error, "Ensure mcp_agent_mail is running on http://127.0.0.1:8765"),
          [{ command: "joelclaw mail status", description: "Retry mail status" }],
        ),
      )
      return
    }

    yield* Console.log(
      respond(
        "mail status",
        {
          base_url: result.right.base_url,
          liveness: result.right.liveness,
          unified_inbox: result.right.unified_inbox,
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
        result.right.healthy ?? true,
      ),
    )
  }),
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
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "register",
        args: {
          project,
          agent,
          program,
          model,
          task: parseOptionalText(task),
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail register",
            error.message,
            codeOrFallback(error, "MAIL_REGISTER_FAILED"),
            fixOrFallback(error, "Verify project/agent and mcp_agent_mail availability"),
            [{ command: "joelclaw mail register --project <project> --agent <agent>", description: "Retry register" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail register",
          result.right,
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
    }),
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
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "send",
        args: {
          project,
          from,
          to,
          subject,
          body,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail send",
            error.message,
            codeOrFallback(error, "MAIL_SEND_FAILED"),
            fixOrFallback(error, "Verify sender/recipient and retry"),
            [{ command: "joelclaw mail send --project <project> --from <agent> --to <agent> --subject <subject> <body>", description: "Retry send" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail send",
          result.right,
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
    }),
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
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "inbox",
        args: {
          project,
          agent,
          unread,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail inbox",
            error.message,
            codeOrFallback(error, "MAIL_INBOX_FAILED"),
            fixOrFallback(error, "Verify project/agent and server availability"),
            [{ command: "joelclaw mail inbox --project <project> --agent <agent>", description: "Retry inbox fetch" }],
          ),
        )
        return
      }

      const messageRows = Array.isArray(result.right.messages)
        ? result.right.messages.filter((message): message is Record<string, unknown> => Boolean(asRecord(message)))
        : []

      yield* Console.log(
        respond(
          "mail inbox",
          result.right,
          [
            {
              command: "joelclaw mail read --project <project> --agent <agent> --id <message_id>",
              description: "Mark and view a message",
              params: {
                project: { value: project, required: true, description: "Project key" },
                agent: { value: agent, required: true, description: "Agent name" },
                message_id: {
                  value: messageIdOf(messageRows[0] ?? {}) ?? "MESSAGE_ID",
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
    }),
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
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "read",
        args: {
          project,
          agent,
          id,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail read",
            error.message,
            codeOrFallback(error, "MAIL_READ_FAILED"),
            fixOrFallback(error, "Verify message id and retry"),
            [{ command: "joelclaw mail read --project <project> --agent <agent> --id <message_id>", description: "Retry read" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail read",
          result.right,
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
    }),
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

      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "reserve",
        args: {
          project,
          agent,
          paths: parsedPaths,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail reserve",
            error.message,
            codeOrFallback(error, "MAIL_RESERVE_FAILED"),
            fixOrFallback(error, "Verify paths and registration, then retry"),
            [{ command: "joelclaw mail reserve --project <project> --agent <agent> --paths <comma-separated-paths>", description: "Retry reserve" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail reserve",
          result.right,
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
    }),
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

      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "release",
        args: {
          project,
          agent,
          paths: parsedPaths,
          all,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail release",
            error.message,
            codeOrFallback(error, "MAIL_RELEASE_FAILED"),
            fixOrFallback(error, "Verify release scope and retry"),
            [{ command: "joelclaw mail release --project <project> --agent <agent> [--paths <paths>] [--all]", description: "Retry release" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail release",
          result.right,
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
    }),
).pipe(Command.withDescription("Release file reservations"))

const locksCmd = Command.make(
  "locks",
  {
    project: defaultProject,
  },
  ({ project }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "locks",
        args: {
          project,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail locks",
            error.message,
            codeOrFallback(error, "MAIL_LOCKS_FAILED"),
            fixOrFallback(error, "Verify project and server availability"),
            [{ command: "joelclaw mail locks --project <project>", description: "Retry locks query" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "mail locks",
          result.right,
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
    }),
).pipe(Command.withDescription("List active file reservations"))

const searchCmd = Command.make(
  "search",
  {
    project: defaultProject,
    query: Options.text("query").pipe(Options.withDescription("Search text")),
  },
  ({ project, query }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "mail",
        subcommand: "search",
        args: {
          project,
          query,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "mail search",
            error.message,
            codeOrFallback(error, "MAIL_SEARCH_FAILED"),
            fixOrFallback(error, "Verify query/project and retry"),
            [{ command: "joelclaw mail search --project <project> --query <text>", description: "Retry search" }],
          ),
        )
        return
      }

      const messageRows = Array.isArray(result.right.messages)
        ? result.right.messages.filter((message): message is Record<string, unknown> => Boolean(asRecord(message)))
        : []

      yield* Console.log(
        respond(
          "mail search",
          result.right,
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
                  value: messageIdOf(messageRows[0] ?? {}) ?? "MESSAGE_ID",
                  required: true,
                  description: "Message id from result",
                },
              },
            },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Search project mailbox"))

export const mailCmd = Command.make("mail", {}, () =>
  Effect.gen(function* () {
    const result: Record<string, unknown> = {
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
    }

    const nextActions: NextAction[] = [
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
    ]

    yield* Console.log(respond("mail", result, nextActions))
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
