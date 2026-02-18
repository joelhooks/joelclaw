import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import { Inngest } from "../inngest"
import { respond } from "../response"

const REVIEW_PENDING_KEY = "memory:review:pending"
const proposalKey = (id: string) => `memory:review:proposal:${id}`
const EXPIRY_REASON = "Expired after 7 days without review"
const EXPIRY_WINDOW_DAYS = 7
const EXPIRY_WINDOW_MS = EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000

type ProposalHash = Record<string, string>

const withRedis = <A>(fn: (redis: Redis) => Promise<A>): Promise<A> => {
  const redis = new Redis()
  return fn(redis).finally(() => {
    try {
      redis.disconnect()
    } catch {
      // no-op
    }
  })
}

const readPendingProposals = (): Promise<Array<{ id: string; proposal: ProposalHash }>> =>
  withRedis(async (redis) => {
    const ids = await redis.lrange(REVIEW_PENDING_KEY, 0, -1)
    const proposals = await Promise.all(
      ids.map(async (id) => ({
        id,
        proposal: await redis.hgetall(proposalKey(id)),
      }))
    )
    return proposals
  })

const extractCreatedAt = (proposalId: string, proposal: ProposalHash): number | null => {
  const fromFields = proposal.createdAt ?? proposal.created_at
  if (fromFields) {
    const parsed = Date.parse(fromFields)
    if (Number.isFinite(parsed)) return parsed
  }

  const proposalIdMatch = /^p-(\d{4})(\d{2})(\d{2})-\d+$/u.exec(proposalId)
  if (!proposalIdMatch) return null

  const [, y, m, d] = proposalIdMatch
  const parsed = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : null
}

const isOlderThanSevenDays = (proposalId: string, proposal: ProposalHash): boolean => {
  const createdAt = extractCreatedAt(proposalId, proposal)
  if (createdAt === null) return false
  return Date.now() - createdAt > EXPIRY_WINDOW_MS
}

const listPayload = (items: Array<{ id: string; proposal: ProposalHash }>) =>
  items.map(({ id, proposal }) => ({
    id,
    ...proposal,
    _actions: [
      { command: `joelclaw review approve ${id}`, description: "Approve this proposal" },
      { command: `joelclaw review reject ${id} --reason \"reason here\"`, description: "Reject this proposal" },
    ],
  }))

const listCmd = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const proposals = yield* Effect.tryPromise({
      try: () => readPendingProposals(),
      catch: (error) => error,
    })

    const result = {
      pending_count: proposals.length,
      proposals: listPayload(proposals),
      _actions: [
        { command: "joelclaw review approve-all", description: "Approve all pending proposals" },
        { command: "joelclaw review expire", description: "Run an expiry check for stale proposals" },
      ],
    }

    yield* Console.log(
      respond("review list", result, [
        { command: "joelclaw review approve-all", description: "Approve every pending proposal" },
        { command: "joelclaw review expire", description: "Expire proposals older than 7 days" },
      ])
    )
  })
)

const approveCmd = Command.make(
  "approve",
  {
    proposalId: Args.text({ name: "proposal-id" }),
  },
  ({ proposalId }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const response = yield* inngestClient.send("memory/proposal.approved", {
        proposalId,
        approvedBy: "joel",
      })

      yield* Console.log(
        respond("review approve", { proposalId, sent: response }, [
          { command: "joelclaw review", description: "See remaining pending proposals" },
          { command: "joelclaw runs --count 5", description: "Confirm processing run" },
        ])
      )
    })
)

const rejectCmd = Command.make(
  "reject",
  {
    proposalId: Args.text({ name: "proposal-id" }),
    reason: Options.text("reason").pipe(
      Options.withDescription("Reason for rejection")
    ),
  },
  ({ proposalId, reason }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const response = yield* inngestClient.send("memory/proposal.rejected", {
        proposalId,
        reason,
        rejectedBy: "joel",
      })

      yield* Console.log(
        respond("review reject", { proposalId, reason, sent: response }, [
          { command: "joelclaw review", description: "See remaining pending proposals" },
          { command: "joelclaw runs --count 5", description: "Confirm processing run" },
        ])
      )
    })
)

const approveAllCmd = Command.make("approve-all", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest
    const proposalIds = yield* Effect.tryPromise({
      try: () => withRedis((redis) => redis.lrange(REVIEW_PENDING_KEY, 0, -1)),
      catch: (error) => error,
    })

    const sent = [] as Array<{ proposalId: string; response: unknown }>

    for (const proposalId of proposalIds) {
      const response = yield* inngestClient.send("memory/proposal.approved", {
        proposalId,
        approvedBy: "joel",
      })
      sent.push({ proposalId, response })
    }

    yield* Console.log(
      respond("review approve-all", { count: sent.length, proposals: sent }, [
        { command: "joelclaw review", description: "See remaining pending proposals" },
        { command: "joelclaw runs --count 10", description: "Inspect resulting runs" },
      ])
    )
  })
)

const expireCmd = Command.make("expire", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest
    const pending = yield* Effect.tryPromise({
      try: () => readPendingProposals(),
      catch: (error) => error,
    })

    const expiredCandidates = pending
      .filter(({ id, proposal }) => isOlderThanSevenDays(id, proposal))
      .map(({ id }) => id)

    const sent = [] as Array<{ proposalId: string; response: unknown }>

    for (const proposalId of expiredCandidates) {
      const response = yield* inngestClient.send("memory/proposal.rejected", {
        proposalId,
        reason: EXPIRY_REASON,
        rejectedBy: "joel",
      })
      sent.push({ proposalId, response })
    }

    yield* Console.log(
      respond("review expire", {
        checked: pending.length,
        expired: expiredCandidates.length,
        reason: EXPIRY_REASON,
        proposals: sent,
      }, [
        { command: "joelclaw review", description: "See remaining pending proposals" },
        { command: "joelclaw runs --count 10", description: "Inspect resulting runs" },
      ])
    )
  })
)

export const reviewCmd = Command.make("review", {}, () =>
  Effect.gen(function* () {
    const proposals = yield* Effect.tryPromise({
      try: () => readPendingProposals(),
      catch: (error) => error,
    })

    yield* Console.log(
      respond("review", {
        pending_count: proposals.length,
        proposals: listPayload(proposals),
      }, [
        { command: "joelclaw review approve-all", description: "Approve every pending proposal" },
        { command: "joelclaw review expire", description: "Expire proposals older than 7 days" },
      ])
    )
  })
).pipe(
  Command.withSubcommands([listCmd, approveCmd, rejectCmd, approveAllCmd, expireCmd])
)
