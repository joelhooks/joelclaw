#!/usr/bin/env bun

import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { Inngest } from "./inngest"
import { respond } from "./response"
import type { NextAction } from "./response"

// ── igs send ─────────────────────────────────────────────────────────

const sendCmd = Command.make(
  "send",
  {
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Event name (e.g. pipeline/video.download, system/log)")
    ),
    data: Options.text("data").pipe(
      Options.withAlias("d"),
      Options.withDescription("JSON data payload"),
      Options.withDefault("{}")
    ),
    url: Options.text("url").pipe(
      Options.withDescription("Shorthand: sets data.url for video.download events"),
      Options.optional
    ),
  },
  ({ event, data, url }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest
      let payload: Record<string, unknown>

      try {
        payload = JSON.parse(data)
      } catch {
        yield* Console.log(respond("send", { error: "Invalid JSON in --data" }, [], false))
        return
      }

      // shorthand: --url for video download events
      if (url._tag === "Some") {
        payload.url = url.value
      }

      const result = yield* igs.send(event, payload)

      yield* Console.log(respond("send", { event, data: payload, response: result }, [
        { command: `igs runs --count 3`, description: "Check if the function picked it up" },
        { command: `igs run ${(result as any)?.ids?.[0] ?? "RUN_ID"}`, description: "Inspect the run once it starts" },
        { command: `igs functions`, description: "See which function handles this event" },
      ]))
    })
)

// ── igs runs ─────────────────────────────────────────────────────────

const runsCmd = Command.make(
  "runs",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(10),
      Options.withDescription("Number of runs to show")
    ),
    status: Options.text("status").pipe(
      Options.withAlias("s"),
      Options.optional,
      Options.withDescription("Filter: COMPLETED, FAILED, RUNNING, QUEUED, CANCELLED")
    ),
    hours: Options.integer("hours").pipe(
      Options.withDefault(24),
      Options.withDescription("Look back N hours (default: 24)")
    ),
  },
  ({ count, status, hours }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest
      const statusVal = status._tag === "Some" ? status.value : undefined
      const result = yield* igs.runs({ count, status: statusVal, hours })

      const next: NextAction[] = result
        .filter((r: any) => r.status === "FAILED" || r.status === "RUNNING")
        .slice(0, 3)
        .map((r: any) => ({
          command: `igs run ${r.id}`,
          description: `Inspect ${r.status.toLowerCase()} ${r.functionName}`,
        }))

      next.push(
        { command: `igs runs --status FAILED`, description: "Show only failures" },
        { command: `igs runs --hours 48 --count 20`, description: "Wider time range" },
      )

      yield* Console.log(respond("runs", { count: result.length, runs: result }, next))
    })
)

// ── igs run <id> ─────────────────────────────────────────────────────

const runCmd = Command.make(
  "run",
  {
    runId: Args.text({ name: "run-id" }).pipe(
      Args.withDescription("Run ID (ULID)")
    ),
  },
  ({ runId }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest
      const result = yield* igs.run(runId)

      const next: NextAction[] = []

      if (result.run.status === "FAILED" && result.errors) {
        next.push({
          command: `tail -30 ~/.local/log/system-bus-worker.err`,
          description: "Check worker stderr for full stack trace",
        })
      }
      if (result.run.status === "RUNNING") {
        next.push({
          command: `igs run ${runId}`,
          description: "Re-check (still running)",
        })
      }
      if (result.trigger?.IDs?.[0]) {
        next.push({
          command: `igs event ${result.trigger.IDs[0]}`,
          description: "View the trigger event payload",
        })
      }
      next.push(
        { command: `igs runs --count 5`, description: "See surrounding runs" },
        { command: `docker logs system-bus-inngest-1 2>&1 | grep "${runId}" | tail -5`, description: "Server-side logs for this run" },
      )

      yield* Console.log(respond("run", result, next, result.run.status !== "FAILED"))
    })
)

// ── igs functions ────────────────────────────────────────────────────

const functionsCmd = Command.make(
  "functions",
  {},
  () =>
    Effect.gen(function* () {
      const igs = yield* Inngest
      const fns = yield* igs.functions()

      const next: NextAction[] = fns.flatMap((f) =>
        f.triggers.slice(0, 1).map((t) => ({
          command: `igs send ${t.value} -d '{}'`,
          description: `Trigger ${f.name}`,
        }))
      )
      next.push({ command: `igs runs --count 5`, description: "See recent runs" })

      yield* Console.log(respond("functions", { count: fns.length, functions: fns }, next))
    })
)

// ── igs status ───────────────────────────────────────────────────────

const statusCmd = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function* () {
      const igs = yield* Inngest
      const checks = yield* igs.health()
      const allOk = Object.values(checks).every((c) => c.ok)

      const next: NextAction[] = []
      if (!checks.server?.ok) {
        next.push({ command: `cd ~/Code/system-bus && docker compose up -d`, description: "Start Inngest server" })
      }
      if (!checks.worker?.ok) {
        next.push({ command: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`, description: "Restart worker" })
      }
      next.push(
        { command: `igs functions`, description: "View registered functions" },
        { command: `igs runs --count 5`, description: "Recent runs" },
      )

      yield* Console.log(respond("status", checks, next, allOk))
    })
)

// ── igs schema ───────────────────────────────────────────────────────

const schemaCmd = Command.make(
  "schema",
  {},
  () =>
    Effect.gen(function* () {
      const events = {
        "pipeline/video.download": {
          description: "Download video + NAS transfer → chains to transcript.process",
          data: { url: "string (required)", maxQuality: "string (optional, default: 1080)" },
          example: `igs send pipeline/video.download --url "https://youtube.com/watch?v=XXXX"`,
        },
        "pipeline/transcript.process": {
          description: "Transcribe audio or accept raw text → vault note → chains to content/summarize",
          data: {
            source: "string (required: youtube|granola|fathom|podcast|manual)",
            audioPath: "string (if source needs whisper)",
            text: "string (if raw text, no whisper)",
            title: "string (required)",
            slug: "string (required)",
            channel: "string (optional)",
            publishedDate: "string (optional)",
            duration: "string (optional)",
            sourceUrl: "string (optional)",
            nasPath: "string (optional)",
            tmpDir: "string (optional)",
          },
          example: `igs send pipeline/transcript.process -d '{"source":"granola","text":"...","title":"Meeting","slug":"meeting"}'`,
        },
        "content/summarize": {
          description: "Enrich a vault note with pi + web research",
          data: { vaultPath: "string (required)", prompt: "string (optional)" },
          example: `igs send content/summarize -d '{"vaultPath":"/Users/joel/Vault/Resources/videos/some-note.md"}'`,
        },
        "system/log": {
          description: "Write a canonical system log entry",
          data: { action: "string (required)", tool: "string (required)", detail: "string (required)", reason: "string (optional)" },
          example: `igs send system/log -d '{"action":"test","tool":"debug","detail":"smoke test"}'`,
        },
        "pipeline/book.download": {
          description: "Search + download book from Anna's Archive → NAS (planned)",
          data: { query: "string (required)", format: "string (optional: pdf|epub)" },
        },
      }

      yield* Console.log(respond("schema", events, [
        { command: `igs send pipeline/video.download --url "https://youtube.com/watch?v=XXXX"`, description: "Download a video" },
        { command: `igs send system/log -d '{"action":"test","tool":"cli","detail":"igs test"}'`, description: "Send a test log event" },
        { command: `igs functions`, description: "See registered functions and their triggers" },
      ]))
    })
)

// ── igs loop ─────────────────────────────────────────────────────

const loopStartCmd = Command.make(
  "start",
  {
    project: Options.text("project").pipe(
      Options.withAlias("p"),
      Options.withDescription("Absolute path to the project directory")
    ),
    prd: Options.text("prd").pipe(
      Options.withDescription("Relative path to prd.json within the project"),
      Options.withDefault("prd.json")
    ),
    maxRetries: Options.integer("max-retries").pipe(
      Options.withDefault(2),
      Options.withDescription("Max retry attempts per story")
    ),
    maxIterations: Options.integer("max-iterations").pipe(
      Options.withDefault(100),
      Options.withDescription("Max total stories to attempt")
    ),
    push: Options.boolean("push").pipe(
      Options.withDefault(true),
      Options.withDescription("Push feature branch on completion (default: true)")
    ),
  },
  ({ project, prd, maxRetries, maxIterations, push }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      // Generate a ULID-style loop ID
      const loopId = `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      const result = yield* igs.send("agent/loop.start", {
        loopId,
        project,
        prdPath: prd,
        maxRetries,
        maxIterations,
        push,
      })

      yield* Console.log(respond("loop start", {
        loopId,
        project,
        prdPath: prd,
        maxRetries,
        maxIterations,
        push,
        event: result,
      }, [
        { command: `igs loop status ${loopId}`, description: "Check loop progress" },
        { command: `igs runs --count 10`, description: "See pipeline runs" },
        { command: `igs loop cancel ${loopId}`, description: "Stop the loop" },
      ]))
    })
)

const loopStatusCmd = Command.make(
  "status",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to check (optional — shows all recent if omitted)"),
      Args.optional
    ),
  },
  ({ loopId }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      // Get recent agent-loop runs
      const allRuns = yield* igs.runs({ count: 30, hours: 48 })
      const loopRuns = allRuns.filter((r: any) =>
        r.functionName?.startsWith("agent-loop")
      )

      // Filter by loopId if provided
      const filtered = loopId._tag === "Some"
        ? loopRuns.filter((r: any) => {
            try {
              const output = JSON.parse(r.output ?? "{}")
              return output.loopId === loopId.value
            } catch { return false }
          })
        : loopRuns

      const next: NextAction[] = [
        { command: `igs runs --count 20`, description: "See all recent runs" },
      ]
      if (loopId._tag === "Some") {
        next.push({ command: `igs loop cancel ${loopId.value}`, description: "Cancel this loop" })
      }

      yield* Console.log(respond("loop status", {
        totalLoopRuns: filtered.length,
        runs: filtered.slice(0, 20).map((r: any) => ({
          id: r.id,
          function: r.functionName,
          status: r.status,
          started: r.startedAt,
          output: (() => { try { return JSON.parse(r.output ?? "{}") } catch { return r.output } })(),
        })),
      }, next))
    })
)

const loopCancelCmd = Command.make(
  "cancel",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to cancel")
    ),
    reason: Options.text("reason").pipe(
      Options.withDefault("Cancelled via igs loop cancel")
    ),
  },
  ({ loopId, reason }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      // 1. Write cancel flag
      const cancelDir = `/tmp/agent-loop/${loopId}`
      const cancelPath = `${cancelDir}/cancelled`
      yield* Effect.tryPromise({
        try: async () => {
          Bun.spawnSync(["mkdir", "-p", cancelDir])
          await Bun.write(cancelPath, reason)
        },
        catch: () => new Error("Failed to write cancel flag"),
      })

      // 2. Kill subprocess if running
      const killedPid = yield* Effect.tryPromise({
        try: async () => {
          try {
            const pid = parseInt(await Bun.file(`${cancelDir}/pid`).text(), 10)
            if (!isNaN(pid)) {
              process.kill(pid, "SIGTERM")
              return true
            }
          } catch { /* no pid file or process already dead */ }
          return false
        },
        catch: () => new Error("Failed to kill subprocess"),
      })

      // 3. Send cancel event
      const result = yield* igs.send("agent/loop.cancel", { loopId, reason })

      yield* Console.log(respond("loop cancel", {
        loopId,
        reason,
        cancelFlagWritten: true,
        subprocessKilled: killedPid,
        cancelEvent: result,
      }, [
        { command: `igs loop status ${loopId}`, description: "Verify loop stopped" },
        { command: `igs runs --status RUNNING`, description: "Check for any still-running functions" },
      ]))
    })
)

const loopCmd = Command.make("loop", {}, () =>
  Console.log(respond("loop", {
    description: "Manage durable agent coding loops",
    subcommands: {
      start: "igs loop start --project PATH [--prd prd.json] [--max-retries 2]",
      status: "igs loop status [LOOP_ID]",
      cancel: "igs loop cancel LOOP_ID [--reason TEXT]",
    },
  }, [
    { command: `igs loop start --project /path/to/project`, description: "Start a new loop" },
    { command: `igs loop status`, description: "Check recent loop activity" },
  ]))
).pipe(
  Command.withSubcommands([loopStartCmd, loopStatusCmd, loopCancelCmd])
)

// ── Root ─────────────────────────────────────────────────────────────

const root = Command.make("igs", {}, () =>
  Effect.gen(function* () {
    const igs = yield* Inngest

    const checks = yield* igs.health()
    const fns = yield* igs.functions()
    const recent = yield* igs.runs({ count: 5 })

    yield* Console.log(respond(
      "",
      {
        description: "igs — Inngest CLI for agents (HATEOAS JSON, Effect)",
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
          send: "igs send <event> [-d JSON] [--url URL]",
          runs: "igs runs [--count N] [--status S] [--hours H]",
          run: "igs run <run-id>",
          functions: "igs functions",
          status: "igs status",
          schema: "igs schema",
        },
      },
      [
        { command: "igs status", description: "Health check all components" },
        { command: "igs runs", description: "List recent runs" },
        { command: "igs schema", description: "Event types and payloads" },
        { command: `igs send system/log -d '{"action":"test","tool":"igs","detail":"first run"}'`, description: "Send a test event" },
      ],
      Object.values(checks).every((c) => c.ok)
    ))
  })
).pipe(
  Command.withSubcommands([sendCmd, runsCmd, runCmd, functionsCmd, statusCmd, schemaCmd, loopCmd])
)

const cli = Command.run(root, {
  name: "igs",
  version: "0.1.0",
})

cli(process.argv).pipe(
  Effect.provide(Inngest.Default),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
