import { randomUUID } from "node:crypto"
import { Args, Command, Options } from "@effect/cli"
import {
  init,
  lookupQueueEvent,
  Priority,
  persist,
  type QueueConfig,
  type QueueEventEnvelope,
} from "@joelclaw/queue"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import { loadConfig } from "../config"
import { Inngest } from "../inngest"
import { respond } from "../response"

const cfg = loadConfig()
const REDIS_URL = process.env.REDIS_URL ?? cfg.redisUrl ?? "redis://localhost:6379"
const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:cli",
  consumerName: "cli-discover",
}

function isQueuePilotEnabled(name: string): boolean {
  return new Set(
    (process.env.QUEUE_PILOTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ).has(name.trim().toLowerCase())
}

async function enqueueDiscoveryEvent(data: Record<string, unknown>): Promise<{
  streamId: string;
  eventId: string;
  priority: number;
}> {
  const redis = new Redis(REDIS_URL)

  try {
    await init(redis, QUEUE_CONFIG)

    const priority = lookupQueueEvent("discovery/noted")?.priority ?? Priority.P2
    const eventId = randomUUID()
    const envelope: QueueEventEnvelope = {
      id: eventId,
      name: "discovery/noted",
      source: "cli/discover",
      ts: Date.now(),
      data,
      priority,
    }

    const result = await persist({
      payload: envelope as Record<string, unknown>,
      priority,
      metadata: {
        envelope_version: "1",
        source: "cli/discover",
      },
    })

    if (!result) {
      throw new Error("discovery/noted event was rejected by queue filter")
    }

    return {
      streamId: result.streamId,
      eventId,
      priority: result.priority,
    }
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

export const discoverCmd = Command.make(
  "discover",
  {
    url: Args.text({ name: "url" }).pipe(
      Args.withDescription("URL to capture (repo, article, etc.)")
    ),
    context: Options.text("context").pipe(
      Options.withAlias("c"),
      Options.withDescription("What's interesting about it"),
      Options.optional
    ),
  },
  ({ url, context }) =>
    Effect.gen(function* () {
      const data: Record<string, unknown> = { url }
      if (context._tag === "Some") {
        data.context = context.value
      }

      if (isQueuePilotEnabled("discovery")) {
        const queued = yield* Effect.tryPromise({
          try: () => enqueueDiscoveryEvent(data),
          catch: (error) => new Error(`Failed to enqueue discovery/noted: ${error}`),
        })

        yield* Console.log(respond("discover", {
          url,
          context: context._tag === "Some" ? context.value : undefined,
          event: "discovery/noted",
          mode: "queue",
          streamId: queued.streamId,
          eventId: queued.eventId,
          priority: queued.priority,
        }, [
          {
            command: "joelclaw queue inspect <stream-id>",
            description: "Inspect the queued discovery event",
            params: {
              "stream-id": { description: "Redis stream ID", value: queued.streamId, required: true },
            },
          },
          {
            command: "joelclaw queue depth",
            description: "Check queue depth",
            params: {},
          },
          { command: `ls ~/Vault/Resources/discoveries/`, description: "Check vault output" },
        ]))

        return
      }

      const inngestClient = yield* Inngest
      const result = yield* inngestClient.send("discovery/noted", data)
      const ids = (result as any)?.ids ?? []

      yield* Console.log(respond("discover", {
        url,
        context: context._tag === "Some" ? context.value : undefined,
        event: "discovery/noted",
        mode: "inngest",
        response: result,
      }, [
        {
          command: "joelclaw runs [--count <count>]",
          description: "Check discovery-capture progress",
          params: {
            count: { description: "Number of runs", value: 3, default: 10 },
          },
        },
        {
          command: "joelclaw run <run-id>",
          description: "Inspect the run",
          params: {
            "run-id": { description: "Run ID", value: ids[0] ?? "RUN_ID", required: true },
          },
        },
        { command: `ls ~/Vault/Resources/discoveries/`, description: "Check vault output" },
      ]))
    })
)
