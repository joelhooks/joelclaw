#!/usr/bin/env bun

import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { Inngest } from "./inngest"
import { respond } from "./response"
import { ALLOWED_MODELS } from "../../gateway/src/commands/config.ts"

import { sendCmd } from "./commands/send"
import { runsCmd, runCmd } from "./commands/runs"
import { statusCmd, functionsCmd } from "./commands/status"
import { capabilitiesCmd } from "./commands/capabilities"
import { recoverCmd } from "./commands/recover"
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
import { vaultCmd } from "./commands/vault"
import { docsCmd } from "./commands/docs"
import { search } from "./commands/search"
import { nasCmd } from "./commands/nas"
import { inngestCmd } from "./commands/inngest"
import { otelCmd } from "./commands/otel"
import { langfuseCmd } from "./commands/langfuse"

// ── Root ─────────────────────────────────────────────────────────────

const modelsList = Options.boolean("list").pipe(
  Options.withDefault(false),
  Options.withDescription("List allowed gateway model IDs"),
)

const modelsPlain = Options.boolean("plain").pipe(
  Options.withDefault(false),
  Options.withDescription("Emit newline-delimited model IDs for shell scripts"),
)

const modelsCmd = Command.make("models", { list: modelsList, plain: modelsPlain }, ({ list, plain }) =>
  Effect.gen(function* () {
    const shouldList = list || plain
    const models = [...ALLOWED_MODELS]

    if (!shouldList) {
      yield* Console.log(respond(
        "models",
        { description: "Use --list to show allowed gateway model IDs" },
        [
          { command: "joelclaw models --list", description: "List allowed gateway model IDs" },
          { command: "joelclaw models --list --plain", description: "Emit newline-delimited model IDs for scripts" },
        ],
        true
      ))
      return
    }

    if (plain) {
      yield* Console.log(models.join("\n"))
      return
    }

    yield* Console.log(respond(
      "models --list",
      { count: models.length, models },
      [{ command: "joelclaw models --list --plain", description: "Emit newline-delimited model IDs for scripts" }],
      true
    ))
  })
).pipe(
  Command.withDescription("List allowed gateway model IDs from gateway config"),
)

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
          capabilities: "joelclaw capabilities",
          recover: "joelclaw recover <error-code> [--phase fix] [--execute]",
          logs: "joelclaw logs [worker|errors|server|analyze] [-n lines] [--grep text]", 
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
          search: "joelclaw search <query> [-c collection] [-n limit] [-f filter] [--semantic]",
          docs: "joelclaw docs {add|search|context|list|show|status|enrich|reindex}",
          vault: "joelclaw vault {read|search|ls|tree}",
          email: "joelclaw email {inboxes|inbox|read|archive|archive-bulk}",
          models: "joelclaw models --list [--plain]",
          nas: "joelclaw nas {status|runs|review}",
          otel: "joelclaw otel {list|search|stats}",
          langfuse: "joelclaw langfuse {aggregate}",
          inngest: "joelclaw inngest {status|workers|register|restart-worker|reconcile|memory-e2e|memory-weekly|memory-gate|memory-schema-reconcile|memory-health}",
          schema: "joelclaw schema",
          refresh: "joelclaw refresh",
        },
      },
      [
        { command: "joelclaw status", description: "Health check all components" },
        { command: "joelclaw capabilities", description: "Discover goal-oriented command flows" },
        { command: "joelclaw recover list", description: "List deterministic recovery runbooks" },
        { command: "joelclaw loop status", description: "Active loop status (Redis)" },
        { command: "joelclaw runs", description: "List recent runs" },
        { command: "joelclaw langfuse aggregate --hours 24", description: "Aggregate cloud LLM trace trends" },
        { command: "joelclaw schema", description: "Event types and payloads" },
      ],
      Object.values(checks).every((c) => c.ok)
    ))
  })
).pipe(
  Command.withSubcommands([discoverCmd, noteCmd, sendCmd, runsCmd, runCmd, eventCmd, eventsCmd, functionsCmd, statusCmd, capabilitiesCmd, recoverCmd, logsCmd, schemaCmd, loopCmd, watchCmd, refresh, gatewayCmd, tuiCmd, reviewCmd, approvalsCmd, recallCmd, vaultCmd, docsCmd, emailCmd, callCmd, search, modelsCmd, nasCmd, otelCmd, langfuseCmd, inngestCmd])
)

const cli = Command.run(root, {
  name: "joelclaw",
  version: "0.2.0",
})

// Backward-compatibility no-op flags: --json/--toon.
// CLI now always emits JSON envelopes; these are ignored to avoid breaking older callers.
const argv = process.argv.filter(a => a !== "--toon" && a !== "--json")

cli(argv).pipe(
  Effect.provide(Inngest.Default),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
