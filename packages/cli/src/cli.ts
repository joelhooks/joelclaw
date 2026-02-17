#!/usr/bin/env bun

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { Inngest } from "./inngest"
import { respond } from "./response"

import { sendCmd } from "./commands/send"
import { runsCmd, runCmd } from "./commands/runs"
import { statusCmd, functionsCmd } from "./commands/status"
import { schemaCmd } from "./commands/schema"
import { loopCmd } from "./commands/loop"
import { discoverCmd } from "./commands/discover"
import { refresh } from "./commands/refresh"
import { eventsCmd } from "./commands/events"
import { logsCmd } from "./commands/logs"
import { watchCmd } from "./commands/watch"

// ── Root ─────────────────────────────────────────────────────────────

const root = Command.make("joelclaw", {}, () =>
  Effect.gen(function* () {
    const igs = yield* Inngest

    const checks = yield* igs.health()
    const fns = yield* igs.functions()
    const recent = yield* igs.runs({ count: 5 })

    yield* Console.log(respond(
      "",
      {
        description: "joelclaw — Inngest CLI for agents (HATEOAS JSON, Effect)",
        health: checks,
        functions: fns.map((f) => ({
          name: f.name,
          triggers: f.triggers.map((t) => t.value),
        })),
        recent_runs: recent.map((r: any) => ({
          id: r.id,
          function: r.functionName,
          status: r.status,
          started: r.startedAt,
        })),
        commands: {
          send: "joelclaw send <event> [-d JSON]",
          runs: "joelclaw runs [--count N] [--status S] [--hours H]",
          run: "joelclaw run <run-id>",
          events: "joelclaw events [--prefix P] [--hours H] [--count N]",
          functions: "joelclaw functions",
          status: "joelclaw status",
          logs: "joelclaw logs [worker|errors|server] [-n lines] [--grep text]",
          loop: "joelclaw loop {start|status|list|cancel|restart|nuke}",
          watch: "joelclaw watch [LOOP_ID] [-i 15]",
          discover: "joelclaw discover <url> [-c context]",
          schema: "joelclaw schema",
          refresh: "joelclaw refresh",
        },
      },
      [
        { command: "joelclaw status", description: "Health check all components" },
        { command: "joelclaw loop status", description: "Active loop status (Redis)" },
        { command: "joelclaw runs", description: "List recent runs" },
        { command: "joelclaw schema", description: "Event types and payloads" },
      ],
      Object.values(checks).every((c) => c.ok)
    ))
  })
).pipe(
  Command.withSubcommands([discoverCmd, sendCmd, runsCmd, runCmd, eventsCmd, functionsCmd, statusCmd, logsCmd, schemaCmd, loopCmd, watchCmd, refresh])
)

const cli = Command.run(root, {
  name: "joelclaw",
  version: "0.2.0",
})

cli(process.argv).pipe(
  Effect.provide(Inngest.Default),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
