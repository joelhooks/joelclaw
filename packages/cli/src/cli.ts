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
import { eventCmd } from "./commands/event"
import { eventsCmd } from "./commands/events"
import { logsCmd } from "./commands/logs"
import { watchCmd } from "./commands/watch"
import { noteCmd } from "./commands/note"
import { gatewayCmd } from "./commands/gateway"
import { tuiCmd } from "./commands/tui"
import { reviewCmd } from "./commands/review"
import { recallCmd } from "./commands/recall"
import { emailCmd } from "./commands/email"
import { approvalsCmd } from "./commands/approvals"
import { callCmd } from "./commands/call"

// ── Root ─────────────────────────────────────────────────────────────

const root = Command.make("joelclaw", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest

    const checks = yield* inngestClient.health()
    const fns = yield* inngestClient.functions()
    const recent = yield* inngestClient.runs({ count: 5 })

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
          event: "joelclaw event <event-id>",
          events: "joelclaw events [--prefix P] [--hours H] [--count N]",
          functions: "joelclaw functions",
          status: "joelclaw status",
          logs: "joelclaw logs [worker|errors|server] [-n lines] [--grep text]",
          loop: "joelclaw loop {start|status|list|cancel|restart|nuke}",
          watch: "joelclaw watch [LOOP_ID] [-i 15]",
          discover: "joelclaw discover <url> [-c context]",
          note: "joelclaw note <text> [--source source] [--tags a,b,c]",
          gateway: "joelclaw gateway {status|events|push|drain|test}",
          tui: "joelclaw tui [--url ws://127.0.0.1:3018] [--observe]",
          review: "joelclaw review {list|approve|reject|approve-all|expire}",
          approvals: "joelclaw approvals {list|approve|deny|categories|history|reset}",
          call: "joelclaw call <message> [--to <phone>]",
          recall: "joelclaw recall <query> [--limit N] [--min-score F] [--raw]",
          email: "joelclaw email {inboxes|inbox|read|archive|archive-bulk}",
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
  Command.withSubcommands([discoverCmd, noteCmd, sendCmd, runsCmd, runCmd, eventCmd, eventsCmd, functionsCmd, statusCmd, logsCmd, schemaCmd, loopCmd, watchCmd, refresh, gatewayCmd, tuiCmd, reviewCmd, approvalsCmd, recallCmd, emailCmd, callCmd])
)

const cli = Command.run(root, {
  name: "joelclaw",
  version: "0.2.0",
})

// Strip --toon/--json before Effect CLI sees it (handled in response.ts via process.argv check)
const argv = process.argv.filter(a => a !== "--toon" && a !== "--json")

cli(argv).pipe(
  Effect.provide(Inngest.Default),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
