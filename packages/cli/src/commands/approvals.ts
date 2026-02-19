import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import {
  approveRequest,
  denyRequest,
  getHistory,
  listAutoApproveCategories,
  listPending,
  resetAutoApproveCategories,
} from "../../../system-bus/src/approvals/core.ts"
import { respond, respondError } from "../response"

/**
 * ADR-0067: CLI approval patterns adapted from local-approvals by shaiss (openclaw/skills, MIT).
 */

const redisOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
  connectTimeout: 3000,
  commandTimeout: 5000,
}

const reviewer = process.env.JOELCLAW_APPROVAL_REVIEWER ?? "joel"

const withRedis = <A>(fn: (redis: Redis) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const redis = new Redis(redisOptions)
      await redis.connect()
      try {
        return await fn(redis)
      } finally {
        try {
          await redis.quit()
        } catch {
          redis.disconnect()
        }
      }
    },
    catch: (error) => new Error(`${error}`),
  })

const listCmd = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const pending = yield* withRedis((redis) => listPending(redis))
    const sorted = pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    yield* Console.log(
      respond(
        "approvals list",
        {
          pending_count: sorted.length,
          approvals: sorted.map((item) => ({
            ...item,
            _actions: [
              { command: `joelclaw approvals approve ${item.requestId}`, description: "Approve this request" },
              { command: `joelclaw approvals deny ${item.requestId}`, description: "Deny this request" },
            ],
          })),
        },
        [
          { command: "joelclaw approvals categories", description: "List auto-approval categories" },
          { command: "joelclaw approvals approve <id> [--learn]", description: "Approve one request" },
          { command: "joelclaw approvals deny <id>", description: "Deny one request" },
        ]
      )
    )
  })
)

const approveCmd = Command.make(
  "approve",
  {
    requestId: Args.text({ name: "id" }),
    learn: Options.boolean("learn").pipe(
      Options.withDefault(false),
      Options.withDescription("Also learn this category for future auto-approvals")
    ),
  },
  ({ requestId, learn }) =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        withRedis((redis) => approveRequest(redis, requestId, { reviewer, learn }))
      )

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "approvals approve",
            result.left.message,
            "APPROVAL_APPROVE_FAILED",
            "Check the request ID with `joelclaw approvals` and try again.",
            [
              { command: "joelclaw approvals", description: "List pending approvals" },
              { command: "joelclaw approvals categories", description: "Review learned categories" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "approvals approve",
          { request_id: requestId, decision: "approved", reviewer, learn },
          [
            { command: "joelclaw approvals", description: "List remaining pending approvals" },
            { command: "joelclaw approvals categories", description: "Review auto-approval categories" },
          ]
        )
      )
    })
)

const denyCmd = Command.make(
  "deny",
  {
    requestId: Args.text({ name: "id" }),
  },
  ({ requestId }) =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        withRedis((redis) => denyRequest(redis, requestId, { reviewer }))
      )

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "approvals deny",
            result.left.message,
            "APPROVAL_DENY_FAILED",
            "Check the request ID with `joelclaw approvals` and try again.",
            [
              { command: "joelclaw approvals", description: "List pending approvals" },
              { command: "joelclaw approvals categories", description: "Review learned categories" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "approvals deny",
          { request_id: requestId, decision: "denied", reviewer },
          [
            { command: "joelclaw approvals", description: "List remaining pending approvals" },
            { command: "joelclaw approvals categories", description: "Review auto-approval categories" },
          ]
        )
      )
    })
)

const categoriesCmd = Command.make(
  "categories",
  {
    agent: Options.optional(Options.text("agent").pipe(Options.withDescription("Filter to a single agent"))),
  },
  ({ agent }) =>
    Effect.gen(function* () {
      const categories = yield* withRedis((redis) => listAutoApproveCategories(redis, agent))

      yield* Console.log(
        respond(
          "approvals categories",
          {
            agent: agent ?? null,
            count: categories.length,
            categories,
          },
          [
            { command: "joelclaw approvals", description: "List pending approvals" },
            { command: "joelclaw approvals reset <agent>", description: "Reset categories for one agent" },
          ]
        )
      )
    })
)

const historyCmd = Command.make(
  "history",
  {
    limit: Options.integer("limit").pipe(
      Options.withDefault(50),
      Options.withDescription("Maximum number of history entries to return")
    ),
  },
  ({ limit }) =>
    Effect.gen(function* () {
      const history = yield* withRedis((redis) => getHistory(redis, limit))

      yield* Console.log(
        respond(
          "approvals history",
          {
            count: history.length,
            limit,
            history,
          },
          [
            { command: "joelclaw approvals", description: "List pending approvals" },
            { command: "joelclaw approvals categories", description: "Review learned auto-approval categories" },
          ]
        )
      )
    })
)

const resetCmd = Command.make(
  "reset",
  {
    agent: Args.text({ name: "agent" }),
  },
  ({ agent }) =>
    Effect.gen(function* () {
      const removed = yield* withRedis((redis) => resetAutoApproveCategories(redis, agent))

      yield* Console.log(
        respond(
          "approvals reset",
          {
            agent,
            reset: removed,
            message: removed ? "Auto-approval categories cleared." : "No auto-approval categories were set.",
          },
          [
            { command: "joelclaw approvals categories", description: "List auto-approval categories" },
            { command: "joelclaw approvals", description: "List pending approvals" },
          ]
        )
      )
    })
)

export const approvalsCmd = Command.make("approvals", {}, () =>
  Effect.gen(function* () {
    const pending = yield* withRedis((redis) => listPending(redis))
    const sorted = pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    yield* Console.log(
      respond(
        "approvals",
        {
          pending_count: sorted.length,
          approvals: sorted.map((item) => ({
            ...item,
            _actions: [
              { command: `joelclaw approvals approve ${item.requestId}`, description: "Approve this request" },
              { command: `joelclaw approvals deny ${item.requestId}`, description: "Deny this request" },
            ],
          })),
        },
        [
          { command: "joelclaw approvals categories", description: "List auto-approval categories" },
          { command: "joelclaw approvals approve <id> [--learn]", description: "Approve one request" },
          { command: "joelclaw approvals deny <id>", description: "Deny one request" },
          { command: "joelclaw approvals history [--limit <n>]", description: "View approval history" },
          { command: "joelclaw approvals reset <agent>", description: "Clear learned categories for an agent" },
        ]
      )
    )
  })
).pipe(
  Command.withSubcommands([listCmd, approveCmd, denyCmd, categoriesCmd, historyCmd, resetCmd])
)
