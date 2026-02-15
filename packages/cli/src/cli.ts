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
      Args.withDescription("Loop ID to check (optional — auto-detects from git)"),
      Args.optional
    ),
  },
  ({ loopId }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      // 1. Detect loopId from git log if not provided
      let activeLoopId: string | undefined =
        loopId._tag === "Some" ? loopId.value : undefined

      // Find the project — check PRD in cwd or common locations
      // Check cwd first, then find project dirs that have prd.json with
      // stories that haven't all passed yet (i.e. active loops)
      const candidates = [
        process.cwd(),
        `${process.env.HOME}/Code/joelhooks/joelclaw/packages/system-bus`,
        `${process.env.HOME}/Code/joelhooks/joelclaw`,
      ]

      let projectDir: string | undefined
      let prd: any

      const prdResult = yield* Effect.tryPromise({
        try: async () => {
          // Prefer a PRD with incomplete stories (active loop)
          let fallback: { dir: string; prd: any } | null = null
          for (const dir of candidates) {
            try {
              const prdFile = Bun.file(`${dir}/prd.json`)
              if (await prdFile.exists()) {
                const p = await prdFile.json()
                const hasIncomplete = p.stories?.some((s: any) => !s.passes)
                if (hasIncomplete) return { dir, prd: p }
                if (!fallback) fallback = { dir, prd: p }
              }
            } catch { /* skip */ }
          }
          return fallback
        },
        catch: () => new Error("Failed to read PRD"),
      })
      if (prdResult) {
        projectDir = prdResult.dir
        prd = prdResult.prd
      }

      // If no loopId, find it from recent git commits
      if (!activeLoopId && projectDir) {
        try {
          const proc = Bun.spawnSync(
            ["git", "log", "--oneline", "-20"],
            { cwd: projectDir }
          )
          const lines = proc.stdout.toString().trim().split("\n")
          for (const line of lines) {
            const match = line.match(/\[(loop-[^\]]+)\]/)
            if (match) {
              activeLoopId = match[1]
              break
            }
          }
        } catch { /* no git */ }
      }

      // 2. Read story status from PRD
      const stories = (prd?.stories ?? []).map((s: any) => ({
        id: s.id,
        title: s.title,
        passes: s.passes,
      }))

      // 3. Get attempt info from git log
      const storyAttempts: Record<string, { attempt: number; tool?: string }> = {}
      if (projectDir && activeLoopId) {
        try {
          const proc = Bun.spawnSync(
            ["git", "log", "--oneline", "-50", `--grep=${activeLoopId}`],
            { cwd: projectDir }
          )
          const lines = proc.stdout.toString().trim().split("\n").filter(Boolean)
          for (const line of lines) {
            const m = line.match(
              /\[([A-Z]+-\d+)\]\s+attempt-(\d+)/
            )
            if (m) {
              const [, storyId, attempt] = m
              const current = storyAttempts[storyId]
              const attemptNum = parseInt(attempt, 10)
              if (!current || attemptNum > current.attempt) {
                storyAttempts[storyId] = { attempt: attemptNum }
              }
            }
          }
        } catch { /* no git */ }
      }

      // 4. Get currently running Inngest functions
      const allRuns = yield* igs.runs({ count: 5, status: "RUNNING", hours: 1 })
      const loopRuns = allRuns.filter((r: any) =>
        r.functionName?.startsWith("agent-loop")
      )

      const roleMap: Record<string, string> = {
        "agent-loop-plan": "PLAN",
        "agent-loop-implement": "IMPLEMENT",
        "agent-loop-review": "REVIEW",
        "agent-loop-judge": "JUDGE",
        "agent-loop-complete": "COMPLETE",
        "agent-loop-retro": "RETRO",
      }

      // Only show the most recently started run — older "RUNNING" entries are stale
      const latest = loopRuns.length > 0 ? [loopRuns[0]] : []
      const running = latest.map((r: any) => ({
        role: roleMap[r.functionName] ?? r.functionName,
        runId: r.id,
        since: r.startedAt,
        elapsed: r.startedAt
          ? `${Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000)}s`
          : undefined,
      }))

      // 5. Build story status lines
      const storyLines = stories.map((s: any) => {
        const attempt = storyAttempts[s.id]
        const isRunning = running.length > 0 && !s.passes && attempt &&
          !stories.some((other: any) =>
            !other.passes && other.id !== s.id &&
            storyAttempts[other.id]?.attempt &&
            (storyAttempts[other.id]?.attempt ?? 0) > (attempt?.attempt ?? 0)
          )

        let status: string
        if (s.passes) {
          status = "✅ PASS"
        } else if (running.length > 0 && attempt) {
          // Find which story is currently active — highest attempt without pass
          const activeStory = stories
            .filter((st: any) => !st.passes && storyAttempts[st.id])
            .sort((a: any, b: any) =>
              (storyAttempts[b.id]?.attempt ?? 0) - (storyAttempts[a.id]?.attempt ?? 0)
            )[0]
          if (activeStory?.id === s.id) {
            const role = running[0]?.role ?? "?"
            const elapsed = running[0]?.elapsed ?? ""
            status = `▶ ${role} (attempt ${attempt.attempt}, ${elapsed})`
          } else {
            status = `⏸ attempt ${attempt.attempt} failed`
          }
        } else if (attempt) {
          status = `❌ attempt ${attempt.attempt} failed`
        } else {
          status = "⏳ pending"
        }

        return { id: s.id, title: s.title, status }
      })

      // 6. Compact output
      const header = activeLoopId
        ? `${activeLoopId}${projectDir ? ` (${projectDir.split("/").pop()})` : ""}`
        : "no active loop detected"

      const output = {
        loop: header,
        prd: prd?.title ?? "unknown",
        stories: storyLines,
        running: running.length > 0 ? running : undefined,
      }

      const next: NextAction[] = []
      if (activeLoopId) {
        next.push({ command: `igs loop cancel ${activeLoopId}`, description: "Cancel this loop" })
      }
      if (running.length > 0 && running[0].runId) {
        next.push({ command: `igs run ${running[0].runId}`, description: "Inspect running function" })
      }
      next.push({ command: `igs runs --count 10`, description: "See all recent runs" })

      yield* Console.log(respond("loop status", output, next))
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
