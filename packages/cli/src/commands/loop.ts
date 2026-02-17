import { Args, Command, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Console, Context, Effect, Option } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"
import { loopDiagnoseCmd } from "./diagnose"

export class Redis extends Context.Tag("joelclaw/Redis")<
  Redis,
  {
    get: (key: string) => Effect.Effect<string | null, never>
    del: (key: string) => Effect.Effect<number, never>
  }
>() {}

const loopTmpDir = (loopId: string) => `/tmp/agent-loop/${loopId}`

type LoopRedisSnapshot = {
  project?: string
  prd?: unknown
  prdPath?: string
  maxRetries?: number
  maxIterations?: number
  push?: boolean
  goal?: string
  context?: string[]
}

export const readLoopPrdFromRedis = (
  loopId: string
): Effect.Effect<LoopRedisSnapshot, never, Redis> =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const value = yield* redis.get(`agent-loop:prd:${loopId}`)

    if (!value) return {}

    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

      const source = parsed as Record<string, unknown>
      const result: LoopRedisSnapshot = {}

      if (typeof source.project === "string") result.project = source.project
      if ("prd" in source) result.prd = source.prd
      if (typeof source.prdPath === "string") result.prdPath = source.prdPath
      if (typeof source.maxRetries === "number") result.maxRetries = source.maxRetries
      if (typeof source.maxIterations === "number") result.maxIterations = source.maxIterations
      if (typeof source.push === "boolean") result.push = source.push
      if (typeof source.goal === "string") result.goal = source.goal
      if (Array.isArray(source.context) && source.context.every((c) => typeof c === "string")) {
        result.context = source.context
      }

      return result
    } catch {
      return {}
    }
  })

export const deleteCancelFlag = (loopId: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cancelledPath = `${loopTmpDir(loopId)}/cancelled`
    return yield* fs.remove(cancelledPath).pipe(
      Effect.as("completed" as const),
      Effect.catchAll((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          "reason" in error &&
          error._tag === "SystemError" &&
          error.reason === "NotFound"
        ) {
          return Effect.succeed("skipped" as const)
        }
        return Effect.fail(error)
      })
    )
  }).pipe(Effect.provide(BunContext.layer))

export const deleteRedisPrd = (loopId: string): Effect.Effect<"completed" | "skipped", never, Redis> =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const deleted = yield* redis.del(`agent-loop:prd:${loopId}`)
    return deleted > 0 ? "completed" : "skipped"
  })

export const killStalePid = (loopId: string): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pidPath = `${loopTmpDir(loopId)}/pid`
    const pidText = yield* fs.readFileString(pidPath).pipe(
      Effect.catchAll((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          "reason" in error &&
          error._tag === "SystemError" &&
          error.reason === "NotFound"
        ) {
          return Effect.succeed("")
        }
        return Effect.fail(error)
      })
    )

    const pid = parseInt(pidText, 10)
    if (Number.isNaN(pid)) {
      return false
    }

    return yield* Effect.try({
      try: () => {
        process.kill(pid, "SIGKILL")
        return true
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          return Effect.succeed(false)
        }
        return Effect.fail(error)
      })
    )
  }).pipe(Effect.provide(BunContext.layer))

export const removeWorktree = (loopId: string): Effect.Effect<"completed" | "skipped", unknown> =>
  Effect.try({
    try: () => {
      const proc = Bun.spawnSync(
        ["git", "worktree", "remove", "--force", loopTmpDir(loopId)],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
      )

      if (proc.exitCode === 0) return "completed" as const
      if (proc.exitCode === 128) return "skipped" as const

      throw new Error(`git worktree remove failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`)
    },
    catch: (error) => error,
  })

export const deleteLoopBranch = (loopId: string): Effect.Effect<"completed" | "skipped", unknown> =>
  Effect.try({
    try: () => {
      const proc = Bun.spawnSync(
        ["git", "branch", "-D", `agent-loop/${loopId}`],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
      )

      if (proc.exitCode === 0) return "completed" as const
      if (proc.exitCode === 1) return "skipped" as const

      throw new Error(`git branch -D failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`)
    },
    catch: (error) => error,
  })

export const restartLoop = (
  loopId: string,
  opts: { project?: string; prd?: string }
): Effect.Effect<unknown, unknown, Redis | Inngest> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "start",
      loopId,
      message: `Starting restart for ${loopId}`,
    }, [])))

    const recovered = yield* readLoopPrdFromRedis(loopId)

    const project = opts.project ?? recovered.project
    if (!project) {
      return yield* Effect.fail(new Error(`Missing project for loop restart: ${loopId}`))
    }

    const prdPath =
      opts.prd ??
      recovered.prdPath ??
      (typeof recovered.prd === "string" ? recovered.prd : undefined)

    const pidKilled = yield* killStalePid(loopId)
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "step",
      loopId,
      step: "killed pid",
      status: pidKilled ? "completed" : "skipped",
    }, [])))

    const worktreeStatus = yield* removeWorktree(loopId)
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "step",
      loopId,
      step: "removed worktree",
      status: worktreeStatus,
    }, [])))

    const branchStatus = yield* deleteLoopBranch(loopId)
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "step",
      loopId,
      step: "deleted branch",
      status: branchStatus,
    }, [])))

    const cancelFlagStatus = yield* deleteCancelFlag(loopId)
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "step",
      loopId,
      step: "cleared flags",
      status: cancelFlagStatus,
    }, [])))

    const redisStatus = yield* deleteRedisPrd(loopId)
    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "step",
      loopId,
      step: "cleared redis",
      status: redisStatus,
    }, [])))

    const inngestClient = yield* Inngest

    // ADR-0035: capture originating session ID for gateway routing
    const originSession = process.env.GATEWAY_ROLE === "central"
      ? "gateway"
      : `pid-${process.ppid}`;

    const result = yield* inngestClient.send("agent/loop.started", {
      loopId,
      project,
      prdPath,
      maxRetries: recovered.maxRetries,
      maxIterations: recovered.maxIterations,
      push: recovered.push,
      goal: recovered.goal,
      context: recovered.context,
      originSession,
    })

    const eventId =
      typeof result === "object" &&
      result !== null &&
      "id" in result &&
      typeof result.id === "string"
        ? result.id
        : "unknown"

    yield* Effect.sync(() => console.log(respond("loop restart", {
      type: "success",
      loopId,
      message: "Restart success",
      eventId,
    }, [
      { command: `joelclaw loop status ${loopId}`, description: "Check loop progress" },
      { command: `joelclaw runs --count 10`, description: "See pipeline runs" },
    ])))
  })

// ── joelclaw loop start ───────────────────────────────────────────────────

export const loopStartCmd = Command.make(
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
    goal: Options.text("goal").pipe(
      Options.withDescription("Goal description — planner generates PRD from this + context files"),
      Options.optional
    ),
    context: Options.text("context").pipe(
      Options.withDescription("Comma-separated paths to context files (ADRs, docs) for PRD generation"),
      Options.optional
    ),
  },
  ({ project, prd, maxRetries, maxIterations, push, goal, context }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      const loopId = `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const goalStr = Option.getOrUndefined(goal)
      const contextStr = Option.getOrUndefined(context)
      const contextFiles = contextStr ? contextStr.split(",").map(s => s.trim()) : undefined

      // ADR-0035: capture originating session ID so loop completion notifies this session
      const originSession = process.env.GATEWAY_ROLE === "central"
        ? "gateway"
        : `pid-${process.ppid}`; // ppid = pi process (CLI is a child)

      const result = yield* inngestClient.send("agent/loop.started", {
        loopId,
        project,
        prdPath: goalStr ? undefined : prd,
        goal: goalStr,
        context: contextFiles,
        maxRetries,
        maxIterations,
        push,
        originSession,
      })

      yield* Console.log(respond("loop start", {
        loopId, project, prdPath: prd, maxRetries, maxIterations, push, event: result,
      }, [
        { command: `joelclaw loop status ${loopId}`, description: "Check loop progress" },
        { command: `joelclaw runs --count 10`, description: "See pipeline runs" },
        { command: `joelclaw loop cancel ${loopId}`, description: "Stop the loop" },
      ]))
    })
)

// ── joelclaw loop status ──────────────────────────────────────────────────

export const loopStatusCmd = Command.make(
  "status",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to check (optional — auto-detects active loop from Redis)"),
      Args.optional
    ),
    verbose: Options.boolean("verbose").pipe(
      Options.withAlias("v"),
      Options.withDefault(false),
      Options.withDescription("Show story descriptions and acceptance criteria")
    ),
    compact: Options.boolean("compact").pipe(
      Options.withAlias("c"),
      Options.withDefault(false),
      Options.withDescription("Terse plain-text output for monitoring")
    ),
  },
  ({ loopId, verbose, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      // Read all loop PRDs from Redis — the source of truth (ADR-0011)
      const loopData = yield* Effect.tryPromise({
        try: async () => {
          const Redis = (await import("ioredis")).default
          const redis = new Redis({
            host: process.env.REDIS_HOST ?? "localhost",
            port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
            lazyConnect: true,
            connectTimeout: 3000,
            commandTimeout: 5000,
          })
          await redis.connect()
          const keys = await redis.keys("agent-loop:prd:*")
          const loops: Array<{ loopId: string; prd: any }> = []
          for (const key of keys) {
            const data = await redis.get(key)
            if (data) {
              loops.push({ loopId: key.replace("agent-loop:prd:", ""), prd: JSON.parse(data) })
            }
          }
          await redis.quit()
          return loops
        },
        catch: (e) => new Error(`Redis: ${e}`),
      })

      // Pick target loop
      let targetId = loopId._tag === "Some" ? loopId.value : undefined
      let prd: any = null

      if (targetId) {
        prd = loopData.find((l) => l.loopId === targetId)?.prd
      } else {
        // Auto: find loops with pending stories, prefer most recent
        // loopIds are loop-{timestamp}-{rand} — extract timestamp for sorting
        const extractTs = (id: string) => {
          const parts = id.replace("loop-", "").split("-")
          const ts = parts[0]
          // Could be base36 or decimal — try both
          const n = parseInt(ts, 36)
          return isNaN(n) ? parseInt(ts, 10) || 0 : n
        }
        const active = loopData
          .filter((l) => l.prd?.stories?.some((s: any) => !s.passes && !s.skipped))
          .sort((a, b) => extractTs(b.loopId) - extractTs(a.loopId))
        if (active.length > 0) {
          targetId = active[0].loopId
          prd = active[0].prd
        } else if (loopData.length > 0) {
          const sorted = loopData.sort((a, b) => b.loopId.localeCompare(a.loopId))
          targetId = sorted[0].loopId
          prd = sorted[0].prd
        }
      }

      if (!targetId || !prd) {
        yield* Console.log(respond("loop status", { loop: "no loops in Redis" }, [
          { command: `joelclaw loop start --project PATH`, description: "Start a new loop" },
        ]))
        return
      }

      // Get loop events from Inngest — the event stream IS the log
      const loopEvents = yield* inngestClient.events({ prefix: "agent/loop", hours: 4, count: 100 })
      const myEvents = loopEvents.filter((e: any) => e.data?.loopId === targetId)

      // Derive current state from most recent event
      const latest = myEvents[0]
      const running = latest ? (() => {
        const role = latest.name.replace("agent/loop.", "").toUpperCase()
        const elapsed = latest.occurredAt
          ? `${Math.round((Date.now() - new Date(latest.occurredAt).getTime()) / 1000)}s`
          : undefined
        return [{
          role,
          storyId: latest.data?.storyId,
          attempt: latest.data?.attempt,
          maxRetries: latest.data?.maxRetries,
          tool: latest.data?.tool,
          elapsed,
        }]
      })() : undefined

      // Build story lines from Redis PRD
      const stories = (prd.stories ?? []).map((s: any) => {
        let status: string
        if (s.passes) status = "✅ PASS"
        else if (s.skipped) status = "⏭ SKIP"
        else status = "⏳ pending"
        const entry: any = { id: s.id, title: s.title, status }
        if (verbose) {
          if (s.description) entry.description = s.description
          if (s.acceptance_criteria?.length) entry.acceptance_criteria = s.acceptance_criteria
          // Show attempt output paths for completed/skipped stories
          if (s.passes || s.skipped) {
            const outDir = `/tmp/agent-loop/${targetId}`
            entry.outputs = [`${outDir}/${s.id}-1.out`, `${outDir}/${s.id}-2.out`]
              .filter((p) => { try { return Bun.file(p).size > 0 } catch { return false } })
          }
        }
        return entry
      })

      // Mark active story with attempt info from event stream
      if (running && running[0]?.storyId) {
        const active = stories.find((s: any) => s.id === running[0].storyId)
        if (active) {
          const r = running[0]
          const attemptStr = r.attempt && r.maxRetries ? ` a${r.attempt}/${r.maxRetries}` : ""
          const toolStr = r.tool ? ` ${r.tool}` : ""
          active.status = `▶ ${r.role}${attemptStr}${toolStr} (${r.elapsed})`
        }
      } else if (running) {
        const pending = stories.find((s: any) => s.status === "⏳ pending")
        if (pending) pending.status = `▶ ${running[0].role} (${running[0].elapsed})`
      }

      const passed = prd.stories?.filter((s: any) => s.passes).length ?? 0
      const total = prd.stories?.length ?? 0

      if (compact) {
        const lines: string[] = []
        lines.push(`${targetId} | ${prd.title ?? "?"} | ${passed}/${total}`)
        for (const s of stories) {
          lines.push(`  ${s.status}  ${s.id}: ${s.title}`)
        }
        yield* Console.log(lines.join("\n"))
        return
      }

      const output = {
        loop: targetId,
        prd: prd.title ?? "unknown",
        progress: `${passed}/${total} passed`,
        stories: stories.map((s: any) => ({ id: s.id, title: s.title, status: s.status })),
        running,
        all_loops: loopData.length > 1 ? loopData.map((l) => ({
          id: l.loopId,
          title: l.prd?.title,
          progress: `${l.prd?.stories?.filter((s: any) => s.passes).length ?? 0}/${l.prd?.stories?.length ?? 0}`,
        })) : undefined,
      }

      const next = []
      next.push({ command: `joelclaw loop cancel ${targetId}`, description: "Cancel this loop" })
      if (running) next.push({ command: `joelclaw run ${(running[0] as any).runId ?? targetId}`, description: "Inspect running function" })
      const others = loopData.filter(
        (l) => l.loopId !== targetId && l.prd?.stories?.some((s: any) => !s.passes && !s.skipped)
      )
      for (const o of others.slice(0, 2)) {
        next.push({ command: `joelclaw loop status ${o.loopId}`, description: o.prd?.title })
      }

      yield* Console.log(respond("loop status", output, next))
    })
)

// ── joelclaw loop cancel ──────────────────────────────────────────────────

export const loopCancelCmd = Command.make(
  "cancel",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to cancel")
    ),
    reason: Options.text("reason").pipe(
      Options.withDefault("Cancelled via joelclaw loop cancel")
    ),
  },
  ({ loopId, reason }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      const cancelDir = `/tmp/agent-loop/${loopId}`
      const cancelPath = `${cancelDir}/cancelled`
      yield* Effect.tryPromise({
        try: async () => {
          Bun.spawnSync(["mkdir", "-p", cancelDir])
          await Bun.write(cancelPath, reason)
        },
        catch: () => new Error("Failed to write cancel flag"),
      })

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

      const result = yield* inngestClient.send("agent/loop.cancelled", { loopId, reason })

      // Clean up Redis key — cancelled loop is dead
      const redisClean = yield* Effect.tryPromise({
        try: async () => {
          const Redis = (await import("ioredis")).default
          const redis = new Redis({
            host: process.env.REDIS_HOST ?? "localhost",
            port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
            lazyConnect: true,
            connectTimeout: 3000,
            commandTimeout: 5000,
          })
          await redis.connect()
          const deleted = await redis.del(`agent-loop:prd:${loopId}`)
          await redis.quit()
          return deleted > 0
        },
        catch: () => new Error("Redis cleanup failed"),
      })

      yield* Console.log(respond("loop cancel", {
        loopId, reason, cancelFlagWritten: true, subprocessKilled: killedPid,
        redisKeyRemoved: redisClean, cancelEvent: result,
      }, [
        { command: `joelclaw loop list`, description: "Check remaining loops" },
        { command: `joelclaw runs --status RUNNING`, description: "Check for any still-running functions" },
      ]))
    })
)

// ── joelclaw loop restart ─────────────────────────────────────────────────

const restartHandler = ({
  loopId,
  project,
  prd,
}: {
  loopId: string
  project: Option.Option<string>
  prd: Option.Option<string>
}) =>
  Effect.gen(function* () {
    yield* restartLoop(loopId, {
      project: Option.getOrUndefined(project),
      prd: Option.getOrUndefined(prd),
    })
  })

const _restartCommandImpl = Command.make(
  "restart",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to restart")
    ),
    project: Options.text("project").pipe(
      Options.withDescription("Absolute path to the project directory"),
      Options.optional
    ),
    prd: Options.text("prd").pipe(
      Options.withDescription("Relative path to prd.json within the project"),
      Options.optional
    ),
  },
  restartHandler
).pipe(
  Command.withDescription("Restart a loop: run cleanup then re-send agent/loop.started. Usage: joelclaw loop restart <loop-id>")
)

export const restartCommand = new Proxy(_restartCommandImpl, {
  set(target, prop, value) {
    if (prop === "descriptor" || prop === "handler") return true // silently reject
    return Reflect.set(target, prop, value)
  },
  get(target, prop, receiver) {
    if (prop === "handler") return restartHandler
    return Reflect.get(target, prop, receiver)
  },
})

// ── joelclaw loop nuke ────────────────────────────────────────────────────

export const loopNukeCmd = Command.make(
  "nuke",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to nuke from Redis (or 'dead' to remove all non-active loops)"),
    ),
  },
  ({ loopId }) =>
    Effect.gen(function* () {
      const nuked = yield* Effect.tryPromise({
        try: async () => {
          const Redis = (await import("ioredis")).default
          const redis = new Redis({
            host: process.env.REDIS_HOST ?? "localhost",
            port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
            lazyConnect: true,
            connectTimeout: 3000,
            commandTimeout: 5000,
          })
          await redis.connect()

          if (loopId === "dead") {
            // Nuke loops that are done, cancelled, or stuck
            const keys = await redis.keys("agent-loop:prd:*")
            const removed: string[] = []
            for (const key of keys) {
              const id = key.replace("agent-loop:prd:", "")
              const data = await redis.get(key)
              if (!data) continue
              const prd = JSON.parse(data)
              const allDone = prd.stories?.every((s: any) => s.passes || s.skipped)
              // Check if cancelled
              const cancelFile = `/tmp/agent-loop/${id}/cancelled`
              let cancelled = false
              try { cancelled = !!(await Bun.file(cancelFile).text()) } catch {}
              if (allDone || cancelled) {
                await redis.del(key)
                try { Bun.spawnSync(["rm", "-rf", `/tmp/agent-loop/${id}`]) } catch {}
                removed.push(id)
              }
            }
            await redis.quit()
            return { removed, count: removed.length }
          } else {
            // Nuke specific loop
            const key = `agent-loop:prd:${loopId}`
            const existed = await redis.del(key)
            // Also clean up tmp dir
            try { Bun.spawnSync(["rm", "-rf", `/tmp/agent-loop/${loopId}`]) } catch {}
            await redis.quit()
            return { removed: existed ? [loopId] : [], count: existed ? 1 : 0 }
          }
        },
        catch: (e) => new Error(`Redis: ${e}`),
      })

      yield* Console.log(respond("loop nuke", nuked, [
        { command: `joelclaw loop status`, description: "Check remaining loops" },
      ]))
    })
)

// ── joelclaw loop list ────────────────────────────────────────────────────

export const loopListCmd = Command.make(
  "list",
  {},
  () =>
    Effect.gen(function* () {
      const loops = yield* Effect.tryPromise({
        try: async () => {
          const Redis = (await import("ioredis")).default
          const redis = new Redis({
            host: process.env.REDIS_HOST ?? "localhost",
            port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
            lazyConnect: true,
            connectTimeout: 3000,
            commandTimeout: 5000,
          })
          await redis.connect()
          const keys = await redis.keys("agent-loop:prd:*")
          const result: any[] = []
          for (const key of keys) {
            const data = await redis.get(key)
            if (data) {
              const prd = JSON.parse(data)
              const id = key.replace("agent-loop:prd:", "")
              const passed = prd.stories?.filter((s: any) => s.passes).length ?? 0
              const skipped = prd.stories?.filter((s: any) => s.skipped).length ?? 0
              const total = prd.stories?.length ?? 0
              const allDone = prd.stories?.every((s: any) => s.passes || s.skipped)
              result.push({
                id, title: prd.title,
                progress: `${passed}/${total}${skipped ? ` (${skipped} skipped)` : ""}`,
                status: allDone ? "done" : "active",
              })
            }
          }
          await redis.quit()
          return result
        },
        catch: (e) => new Error(`Redis: ${e}`),
      })

      yield* Console.log(respond("loop list", { count: loops.length, loops }, [
        { command: `joelclaw loop nuke dead`, description: "Remove completed loops from Redis" },
        { command: `joelclaw loop status`, description: "Check active loop" },
      ]))
    })
)

// ── joelclaw loop (parent) ────────────────────────────────────────────────

export const loopCmd = Command.make("loop", {}, () =>
  Console.log(respond("loop", {
    description: "Manage durable agent coding loops",
    subcommands: {
      start: "joelclaw loop start --project PATH [--prd prd.json] [--max-retries 2]",
      status: "joelclaw loop status [LOOP_ID]",
      list: "joelclaw loop list",
      cancel: "joelclaw loop cancel LOOP_ID [--reason TEXT]",
      restart: "joelclaw loop restart LOOP_ID [--project PATH] [--prd prd.json]",
      diagnose: "joelclaw loop diagnose LOOP_ID|all [--fix] [--compact]",
      nuke: "joelclaw loop nuke LOOP_ID | dead",
    },
  }, [
    { command: `joelclaw loop status`, description: "Check active loop" },
    { command: `joelclaw loop diagnose all -c`, description: "Diagnose all stalled loops" },
    { command: `joelclaw loop list`, description: "All loops in Redis" },
    { command: `joelclaw loop nuke dead`, description: "Clean up completed loops" },
  ]))
).pipe(
  Command.withSubcommands([loopStartCmd, loopStatusCmd, loopListCmd, loopCancelCmd, restartCommand, loopNukeCmd, loopDiagnoseCmd])
)
