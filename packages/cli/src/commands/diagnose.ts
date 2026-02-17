import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"

/**
 * Loop diagnostic engine — codifies the manual debugging session.
 * Checks Redis state, worktree, Inngest runs, agents, and worker health.
 * Identifies root cause of stalls and optionally auto-fixes.
 */

interface DiagnosisResult {
  loopId: string
  prd: { title: string; passed: number; skipped: number; pending: number; total: number } | null
  stuckStory: { id: string; title: string } | null
  claims: string[]
  worktree: {
    exists: boolean
    commits?: string[]
    outFiles?: string[]
    uncommitted?: number
  }
  runs: {
    running: Array<{ id: string; function: string; elapsed: string }>
    failed: Array<{ id: string; function: string; error?: string }>
    recentPlan: boolean
  }
  agents: { running: string[] }
  worker: { registered: number; healthy: boolean }
  diagnosis: string
  fixAction: string | null
}

async function collectDiagnosis(loopId: string): Promise<DiagnosisResult> {
  const Redis = (await import("ioredis")).default
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 5000,
  })
  await redis.connect()

  // ── 1. Redis state ──────────────────────────────────────────────
  const prdRaw = await redis.get(`agent-loop:prd:${loopId}`)
  let prd: DiagnosisResult["prd"] = null
  let stories: any[] = []
  let stuckStory: DiagnosisResult["stuckStory"] = null

  if (prdRaw) {
    const parsed = JSON.parse(prdRaw)
    stories = parsed.stories ?? []
    const passed = stories.filter((s: any) => s.passes).length
    const skipped = stories.filter((s: any) => s.skipped).length
    const pending = stories.filter((s: any) => !s.passes && !s.skipped).length
    prd = { title: parsed.title ?? "?", passed, skipped, pending, total: stories.length }

    const firstPending = stories.find((s: any) => !s.passes && !s.skipped)
    if (firstPending) {
      stuckStory = { id: firstPending.id, title: firstPending.title }
    }
  }

  // Claims
  const claimKeys = await redis.keys(`agent-loop:claim:${loopId}:*`)
  const claims: string[] = []
  for (const k of claimKeys) {
    const val = await redis.get(k)
    const storyId = k.split(":").pop() ?? "?"
    claims.push(`${storyId} → ${val}`)
  }

  await redis.quit()

  // ── 2. Worktree ─────────────────────────────────────────────────
  const worktreePath = `/tmp/agent-loop/${loopId}`
  const worktree: DiagnosisResult["worktree"] = { exists: false }

  try {
    const stat = Bun.spawnSync(["test", "-d", worktreePath])
    worktree.exists = stat.exitCode === 0
  } catch {}

  if (worktree.exists) {
    try {
      const log = Bun.spawnSync(["git", "log", "--oneline", "-5"], {
        cwd: worktreePath, stdout: "pipe", stderr: "pipe",
      })
      worktree.commits = log.stdout.toString().trim().split("\n").filter(Boolean)
    } catch {}

    try {
      const diff = Bun.spawnSync(["git", "diff", "--stat", "HEAD"], {
        cwd: worktreePath, stdout: "pipe", stderr: "pipe",
      })
      const lines = diff.stdout.toString().trim().split("\n").filter(Boolean)
      worktree.uncommitted = lines.length > 0 ? lines.length - 1 : 0
    } catch {}

    try {
      const { readdirSync } = await import("node:fs")
      const files = readdirSync(worktreePath)
      worktree.outFiles = files.filter((f: string) => f.endsWith(".out"))
    } catch {}
  }

  // ── 3. Inngest runs ─────────────────────────────────────────────
  const runs: DiagnosisResult["runs"] = { running: [], failed: [], recentPlan: false }

  // Helper: fetch with 5s timeout to prevent CLI hangs
  async function gqlFetch(query: string): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const resp = await fetch("http://localhost:8288/v0/gql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      })
      return await resp.json()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const data = await gqlFetch(`{
      runs(first: 50, filter: { status: [RUNNING] }) {
        edges { node { id functionID status startedAt } }
      }
    }`)
    const edges = data?.data?.runs?.edges ?? []
    const now = Date.now()
    for (const e of edges) {
      const n = e.node
      if (!n.functionID?.includes("agent-loop")) continue
      const started = n.startedAt ? new Date(n.startedAt).getTime() : now
      const elapsedMs = now - started
      const elapsed = elapsedMs > 60000
        ? `${Math.round(elapsedMs / 60000)}m`
        : `${Math.round(elapsedMs / 1000)}s`
      runs.running.push({ id: n.id, function: n.functionID, elapsed })
    }
  } catch {}

  try {
    const data = await gqlFetch(`{
      runs(first: 20, filter: { status: [FAILED] }) {
        edges { node { id functionID status startedAt } }
      }
    }`)
    const edges = data?.data?.runs?.edges ?? []
    for (const e of edges) {
      const n = e.node
      if (!n.functionID?.includes("agent-loop")) continue
      runs.failed.push({ id: n.id, function: n.functionID })
    }
  } catch {}

  // Check if there's a recent plan run (last 30 min)
  try {
    const data = await gqlFetch(`{
      runs(first: 5, filter: { status: [COMPLETED], functionIDs: ["system-bus-agent-loop-plan"] }) {
        edges { node { id startedAt } }
      }
    }`)
    const edges = data?.data?.runs?.edges ?? []
    if (edges.length > 0 && edges[0].node.startedAt) {
      const age = Date.now() - new Date(edges[0].node.startedAt).getTime()
      runs.recentPlan = age < 30 * 60 * 1000
    }
  } catch {}

  // ── 4. Agent processes ──────────────────────────────────────────
  const agents: DiagnosisResult["agents"] = { running: [] }
  try {
    const ps = Bun.spawnSync(["bash", "-c", "ps aux | grep -E 'claude -p|codex exec' | grep -v grep"], {
      stdout: "pipe", stderr: "pipe",
    })
    const lines = ps.stdout.toString().trim().split("\n").filter(Boolean)
    agents.running = lines.map((l: string) => {
      const parts = l.split(/\s+/)
      const pid = parts[1]
      const cmd = parts.slice(10).join(" ").slice(0, 80)
      return `pid:${pid} ${cmd}`
    })
  } catch {}

  // ── 5. Worker health ────────────────────────────────────────────
  const worker: DiagnosisResult["worker"] = { registered: 0, healthy: false }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch("http://localhost:3111/api/inngest", { signal: controller.signal })
    clearTimeout(timer)
    const data = await resp.json() as any
    worker.registered = data?.function_count ?? 0
    worker.healthy = worker.registered >= 19
  } catch {}

  // ── 6. Diagnosis ────────────────────────────────────────────────
  let diagnosis = "unknown"
  let fixAction: string | null = null

  if (!prd) {
    diagnosis = "NO_PRD: Loop has no PRD in Redis — it was nuked or never created"
    fixAction = null
  } else if (prd.pending === 0) {
    diagnosis = "COMPLETE: All stories passed or skipped"
    fixAction = null
  } else if (!worker.healthy) {
    diagnosis = `WORKER_UNHEALTHY: Only ${worker.registered} functions registered (expected 19+). Worker may need restart.`
    fixAction = "restart-worker"
  } else if (runs.running.length > 0) {
    const stuckRuns = runs.running.filter((r) => {
      const mins = parseInt(r.elapsed) || 0
      return r.elapsed.endsWith("m") && mins > 10
    })
    if (stuckRuns.length > 0) {
      diagnosis = `STUCK_RUN: ${stuckRuns.map((r) => `${r.function} running for ${r.elapsed}`).join(", ")}. Agent process likely died but Inngest run is stuck.`
      fixAction = "cancel-stuck-runs"
    } else {
      diagnosis = `RUNNING: ${runs.running.map((r) => `${r.function} (${r.elapsed})`).join(", ")}. Still active — be patient.`
      fixAction = null
    }
  } else if (claims.length > 0 && agents.running.length === 0) {
    diagnosis = `ORPHANED_CLAIM: Story ${claims[0]} is claimed but no agent is running and no Inngest run is active. The event chain broke.`
    fixAction = "refire-story"
  } else if (stuckStory && claims.length === 0 && !runs.recentPlan) {
    diagnosis = `CHAIN_BROKEN: Next story is ${stuckStory.id} (${stuckStory.title}) but no plan ran recently and no claims exist. The judge→plan event was lost.`
    fixAction = "refire-plan"
  } else if (stuckStory && claims.length === 0 && runs.recentPlan) {
    diagnosis = `PLAN_RAN_NO_DISPATCH: Plan ran recently but no claim for ${stuckStory.id}. Plan may have picked a different loop or errored silently.`
    fixAction = "refire-plan"
  } else {
    diagnosis = `UNCLEAR: ${prd.pending} stories pending, ${claims.length} claims, ${runs.running.length} running, ${agents.running.length} agents. Manual investigation needed.`
    fixAction = null
  }

  return { loopId, prd, stuckStory, claims, worktree, runs, agents, worker, diagnosis, fixAction }
}

async function applyFix(result: DiagnosisResult, eventKey: string): Promise<string> {
  switch (result.fixAction) {
    case "restart-worker": {
      const uid = Bun.spawnSync(["id", "-u"], { stdout: "pipe" }).stdout.toString().trim()
      Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${uid}/com.joel.system-bus-worker`])
      return "Worker restarted via launchctl"
    }

    case "cancel-stuck-runs": {
      // We can't easily cancel individual runs via API, but we can clear claims
      // and re-fire the plan event
      const Redis = (await import("ioredis")).default
      const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true, connectTimeout: 3000, commandTimeout: 5000 })
      await redis.connect()
      const claimKeys = await redis.keys(`agent-loop:claim:${result.loopId}:*`)
      for (const k of claimKeys) await redis.del(k)
      await redis.quit()
      // Fall through to refire
    }

    case "refire-story":
    case "refire-plan": {
      // Clear any stale claims
      const Redis = (await import("ioredis")).default
      const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true, connectTimeout: 3000, commandTimeout: 5000 })
      await redis.connect()

      // Get project from PRD, worktree gitdir, or event data
      const prdRaw = await redis.get(`agent-loop:prd:${result.loopId}`)
      const prd = prdRaw ? JSON.parse(prdRaw) : null
      let project = prd?.project

      // Fallback: extract project from worktree's .git file
      if (!project) {
        try {
          const { readFileSync } = await import("node:fs")
          const gitFile = readFileSync(`/tmp/agent-loop/${result.loopId}/.git`, "utf-8")
          // gitdir: /path/to/project/.git/worktrees/loop-id
          const match = gitFile.match(/gitdir:\s+(.+)\/\.git\/worktrees\//)
          if (match?.[1]) project = match[1]
        } catch {}
      }

      // Clear claims
      const claimKeys = await redis.keys(`agent-loop:claim:${result.loopId}:*`)
      for (const k of claimKeys) await redis.del(k)
      await redis.quit()

      if (!project) return "Cannot re-fire: no project in PRD"

      // Send agent/loop.story.passed to trigger plan to pick next story
      const resp = await fetch(`http://localhost:8288/e/${eventKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "agent/loop.story.passed",
          data: {
            loopId: result.loopId,
            project,
            workDir: prd?.workDir ?? project,
            prdPath: "prd.json",
            storyId: "_diagnose-refire",
            commitSha: "HEAD",
            attempt: 1,
            duration: 0,
            maxIterations: prd?.maxIterations ?? 100,
            maxRetries: prd?.maxRetries ?? 2,
          },
        }),
      })
      const status = resp.status
      return `Cleared ${claimKeys.length} claims, re-fired plan event (HTTP ${status})`
    }

    default:
      return "No automatic fix available"
  }
}

export const loopDiagnoseCmd = Command.make(
  "diagnose",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to diagnose (or 'all' for all active loops)")
    ),
    fix: Options.boolean("fix").pipe(
      Options.withDefault(false),
      Options.withDescription("Automatically apply the recommended fix")
    ),
    compact: Options.boolean("compact").pipe(
      Options.withAlias("c"),
      Options.withDefault(false),
      Options.withDescription("Terse plain-text output")
    ),
  },
  ({ loopId, fix, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      // Handle 'all' — diagnose every loop with pending stories
      const loopIds = yield* Effect.tryPromise({
        try: async () => {
          if (loopId !== "all") return [loopId]
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
          const ids: string[] = []
          for (const key of keys) {
            const data = await redis.get(key)
            if (data) {
              const prd = JSON.parse(data)
              const hasPending = prd.stories?.some((s: any) => !s.passes && !s.skipped)
              if (hasPending) ids.push(key.replace("agent-loop:prd:", ""))
            }
          }
          await redis.quit()
          return ids
        },
        catch: (e) => new Error(`Redis: ${e}`),
      })

      if (loopIds.length === 0) {
        yield* Console.log(respond("loop diagnose", { message: "No active loops to diagnose" }, []))
        return
      }

      const eventKey = process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15"

      for (const id of loopIds) {
        const result = yield* Effect.tryPromise({
          try: () => collectDiagnosis(id),
          catch: (e) => new Error(`Diagnosis failed: ${e}`),
        })

        if (compact) {
          const emoji = result.fixAction ? "🔴" : result.diagnosis.startsWith("RUNNING") ? "🟡" : result.diagnosis.startsWith("COMPLETE") ? "🟢" : "⚪"
          const lines: string[] = []
          lines.push(`${emoji} ${id} | ${result.prd?.title ?? "?"} | ${result.prd?.passed ?? 0}/${result.prd?.total ?? 0}`)
          lines.push(`  diagnosis: ${result.diagnosis}`)
          if (result.stuckStory) lines.push(`  stuck on: ${result.stuckStory.id} (${result.stuckStory.title})`)
          if (result.claims.length > 0) lines.push(`  claims: ${result.claims.join(", ")}`)
          if (result.runs.running.length > 0) lines.push(`  running: ${result.runs.running.map(r => `${r.function} ${r.elapsed}`).join(", ")}`)
          if (result.runs.failed.length > 0) lines.push(`  failed: ${result.runs.failed.map(r => r.function).join(", ")}`)
          if (!result.worker.healthy) lines.push(`  ⚠️ worker: ${result.worker.registered} functions (unhealthy)`)
          if (result.fixAction) lines.push(`  fix: ${result.fixAction}${fix ? " (applying...)" : " (use --fix)"}`)

          if (fix && result.fixAction) {
            const fixResult = yield* Effect.tryPromise({
              try: () => applyFix(result, eventKey),
              catch: (e) => new Error(`Fix failed: ${e}`),
            })
            lines.push(`  ✅ ${fixResult}`)
          }

          yield* Console.log(lines.join("\n"))
          if (loopIds.length > 1) yield* Console.log("")
        } else {
          let fixResult: string | undefined
          if (fix && result.fixAction) {
            fixResult = yield* Effect.tryPromise({
              try: () => applyFix(result, eventKey),
              catch: (e) => new Error(`Fix failed: ${e}`),
            })
          }

          yield* Console.log(respond("loop diagnose", {
            ...result,
            fixApplied: fixResult,
          }, [
            result.fixAction && !fix
              ? { command: `joelclaw loop diagnose ${id} --fix`, description: `Apply fix: ${result.fixAction}` }
              : null,
            { command: `joelclaw loop status ${id} -c`, description: "Check loop status" },
            { command: `joelclaw loop cancel ${id}`, description: "Cancel this loop" },
            { command: `joelclaw loop restart ${id}`, description: "Full restart" },
          ].filter(Boolean)))
        }
      }
    })
)
