import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { loadConfig } from "../config"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const cfg = loadConfig()
const WORKER_URL = cfg.workerUrl
const WORKER_REGISTER_URL = `${WORKER_URL}/api/inngest`
const WORKER_LABEL = "com.joel.system-bus-worker"
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text"
const MEMORY_COMPONENTS = [
  "observe",
  "reflect",
  "proposal-triage",
  "batch-review",
  "promote",
  "echo-fizzle",
  "nightly-maintenance",
  "weekly-maintenance",
]

const sleepMs = (ms: number) =>
  Effect.tryPromise({
    try: () => new Promise((resolve) => setTimeout(resolve, ms)),
    catch: () => new Error("sleep interrupted"),
  })

const decodeText = (value: string | Uint8Array | null | undefined): string => {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

type MemorySnapshot = {
  count: number
  latestTimestamp: number | null
  latestUpdatedAt: string | null
}

type WorkerApiBody = {
  count?: number
  worker?: {
    role?: string
    startedAt?: string
    lastRegistrationAt?: string
    roleCounts?: {
      host?: number
      cluster?: number
      active?: number
    }
    duplicateFunctionIds?: string[]
    hasDuplicateFunctionIds?: boolean
  }
}

type TypesenseSearchResponse = {
  found?: number
  hits?: Array<{ document?: Record<string, unknown> }>
}

type TypesenseCollectionField = {
  name: string
  type: string
  optional?: boolean
  facet?: boolean
  sort?: boolean
  index?: boolean
  store?: boolean
}

type TypesenseCollectionSchema = {
  name: string
  fields?: TypesenseCollectionField[]
}

const MEMORY_OBSERVATIONS_REQUIRED_FIELDS: TypesenseCollectionField[] = [
  { name: "observation_type", type: "string", optional: true },
  { name: "merged_count", type: "int64", optional: true, sort: true },
  { name: "updated_at", type: "string", optional: true },
  { name: "stale", type: "bool", optional: true, sort: true },
  { name: "stale_tagged_at", type: "string", optional: true },
  { name: "recall_count", type: "int64", optional: true, sort: true },
  { name: "retrieval_priority", type: "float", optional: true, sort: true },
  { name: "last_used_at", type: "string", optional: true },
  { name: "superseded_by", type: "string", optional: true },
  { name: "supersedes", type: "string", optional: true },
  { name: "write_verdict", type: "string", optional: true, facet: true },
  { name: "write_confidence", type: "float", optional: true, sort: true },
  { name: "write_reason", type: "string", optional: true },
  { name: "write_gate_version", type: "string", optional: true, facet: true },
  { name: "write_gate_fallback", type: "bool", optional: true, sort: true },
  { name: "category_id", type: "string", optional: true, facet: true },
  { name: "category_confidence", type: "float", optional: true, sort: true },
  { name: "category_source", type: "string", optional: true, facet: true },
  { name: "taxonomy_version", type: "string", optional: true, facet: true },
]

async function typesenseCount(
  apiKey: string,
  collection: "memory_observations" | "otel_events",
  queryBy: string,
  filterBy?: string,
): Promise<number> {
  const params = new URLSearchParams({
    q: "*",
    query_by: queryBy,
    per_page: "1",
    exclude_fields: "embedding",
  })
  if (filterBy) params.set("filter_by", filterBy)

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense count query failed (${resp.status}): ${body}`)
  }
  const data = await resp.json() as TypesenseSearchResponse
  return typeof data.found === "number" ? data.found : 0
}

async function typesenseCollectionSchema(
  apiKey: string,
  collection: string,
): Promise<TypesenseCollectionSchema> {
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense schema query failed (${resp.status}): ${body}`)
  }
  return await resp.json() as TypesenseCollectionSchema
}

async function typesensePatchCollectionFields(
  apiKey: string,
  collection: string,
  fields: TypesenseCollectionField[],
): Promise<void> {
  if (fields.length === 0) return
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-TYPESENSE-API-KEY": apiKey,
      },
      body: JSON.stringify({ fields }),
    }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense schema patch failed (${resp.status}): ${body}`)
  }
}

async function latestOtelEvent(
  apiKey: string,
  filterBy: string,
): Promise<{ timestamp: number | null; component: string | null; action: string | null; id: string | null }> {
  const params = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    per_page: "1",
    sort_by: "timestamp:desc",
    include_fields: "id,timestamp,component,action",
  })
  if (filterBy) params.set("filter_by", filterBy)

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/otel_events/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense latest otel query failed (${resp.status}): ${body}`)
  }
  const data = await resp.json() as TypesenseSearchResponse
  const doc = data.hits?.[0]?.document ?? {}
  return {
    timestamp: typeof doc.timestamp === "number" ? doc.timestamp : null,
    component: typeof doc.component === "string" ? doc.component : null,
    action: typeof doc.action === "string" ? doc.action : null,
    id: typeof doc.id === "string" ? doc.id : null,
  }
}

async function memorySnapshot(apiKey: string): Promise<MemorySnapshot> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "observation",
    per_page: "1",
    include_fields: "id,timestamp,updated_at,session_id,observation",
    exclude_fields: "embedding",
    sort_by: "timestamp:desc",
  })

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/memory_observations/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense snapshot query failed (${resp.status}): ${body}`)
  }

  const data = await resp.json() as { found?: number; hits?: Array<{ document?: Record<string, unknown> }> }
  const top = data.hits?.[0]?.document ?? {}
  return {
    count: typeof data.found === "number" ? data.found : 0,
    latestTimestamp: typeof top.timestamp === "number" ? top.timestamp : null,
    latestUpdatedAt: typeof top.updated_at === "string" ? top.updated_at : null,
  }
}

async function memorySessionCount(apiKey: string, sessionId: string): Promise<number> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "observation",
    per_page: "1",
    filter_by: `session_id:=${sessionId}`,
    exclude_fields: "embedding",
  })
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/memory_observations/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense session query failed (${resp.status}): ${body}`)
  }
  const data = await resp.json() as { found?: number }
  return typeof data.found === "number" ? data.found : 0
}

async function memoryMarkerCount(apiKey: string, marker: string): Promise<number> {
  const params = new URLSearchParams({
    q: marker,
    query_by: "observation",
    per_page: "1",
    exclude_fields: "embedding",
  })
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/memory_observations/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense marker query failed (${resp.status}): ${body}`)
  }
  const data = await resp.json() as { found?: number }
  return typeof data.found === "number" ? data.found : 0
}

async function vectorProbe(apiKey: string, query: string): Promise<{ found: number; hitCount: number }> {
  const params = new URLSearchParams({
    q: query,
    query_by: "embedding",
    vector_query: "embedding:([], k:3)",
    per_page: "3",
    exclude_fields: "embedding",
  })

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/memory_observations/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense vector query failed (${resp.status}): ${body}`)
  }
  const data = await resp.json() as { found?: number; hits?: unknown[] }
  return {
    found: typeof data.found === "number" ? data.found : 0,
    hitCount: Array.isArray(data.hits) ? data.hits.length : 0,
  }
}

function runRecallProbe(query: string): {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  ok: boolean
  parsed?: Record<string, unknown>
} {
  return runJoelclawJsonCommand(["recall", query, "--limit", "3", "--json"])
}

function executeJsonCommand(
  cmd: string[],
  env: Record<string, string | undefined>,
): {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  ok: boolean
  parsed?: Record<string, unknown>
} {
  const proc = Bun.spawnSync(cmd, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const stdout = decodeText(proc.stdout).trim()
  const stderr = decodeText(proc.stderr).trim()
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>
  } catch {}
  return {
    command: cmd,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    ok: proc.exitCode === 0 && parsed?.ok === true,
    parsed,
  }
}

function runJoelclawJsonCommand(
  args: string[],
): {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  ok: boolean
  parsed?: Record<string, unknown>
} {
  const env = { ...process.env }
  delete env.TYPESENSE_API_KEY

  const direct = executeJsonCommand(["joelclaw", ...args], env)
  const binaryMissing =
    direct.exitCode !== 0 &&
    /command not found|no such file|not found/iu.test(direct.stderr)
  if (!binaryMissing) return direct
  return executeJsonCommand(
    ["bun", "run", "/Users/joel/Code/joelhooks/joelclaw/packages/cli/src/cli.ts", ...args],
    env,
  )
}

const restartWorker = () =>
  Effect.try({
    try: () => {
      const uid = process.getuid?.() ?? 0
      const proc = Bun.spawnSync([
        "launchctl",
        "kickstart",
        "-k",
        `gui/${uid}/${WORKER_LABEL}`,
      ])

      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().trim()
        throw new Error(stderr || `launchctl exited with ${proc.exitCode}`)
      }

      return { ok: true }
    },
    catch: (e) => new Error(`Failed to restart worker: ${e}`),
  })

const registerWorkerFunctions = () =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(WORKER_REGISTER_URL, { method: "PUT" })
      const body = await res.json().catch(() => ({}))
      return {
        ok: res.ok,
        status: res.status,
        body,
      }
    },
    catch: (e) => new Error(`Failed to register worker functions: ${e}`),
  })

const workerProbe = () =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(WORKER_URL)
      const body = await res.json().catch(() => ({}))
      return {
        ok: res.ok,
        status: res.status,
        body,
      }
    },
    catch: (e) => new Error(`Failed to reach worker: ${e}`),
  })

const workerDiagnostics = (body: unknown) => {
  const data = (body ?? {}) as WorkerApiBody
  const worker = data.worker ?? {}
  return {
    functionCount: typeof data.count === "number" ? data.count : null,
    role: typeof worker.role === "string" ? worker.role : "unknown",
    startedAt: typeof worker.startedAt === "string" ? worker.startedAt : null,
    lastRegistrationAt:
      typeof worker.lastRegistrationAt === "string" ? worker.lastRegistrationAt : null,
    roleCounts: {
      host: typeof worker.roleCounts?.host === "number" ? worker.roleCounts.host : null,
      cluster:
        typeof worker.roleCounts?.cluster === "number" ? worker.roleCounts.cluster : null,
      active: typeof worker.roleCounts?.active === "number" ? worker.roleCounts.active : null,
    },
    duplicateFunctionIds: Array.isArray(worker.duplicateFunctionIds)
      ? worker.duplicateFunctionIds
      : [],
    hasDuplicateFunctionIds: worker.hasDuplicateFunctionIds === true,
  }
}

function isMemoryFunctionName(value: unknown): boolean {
  if (typeof value !== "string") return false
  return /(memory|observe|reflect|proposal|batch|promote|echo|nightly)/iu.test(value)
}

function isTypesenseUnreachableMessage(message: string): boolean {
  return /ECONNREFUSED|Connection refused|TYPESENSE_UNREACHABLE|fetch failed/iu.test(message)
}

const inngestStatusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest
    const checks = yield* inngestClient.health()
    const functions = yield* inngestClient.functions()
    const worker = yield* workerProbe().pipe(Effect.either)

    const workerInfo = worker._tag === "Right"
      ? {
          reachable: worker.right.ok,
          status: worker.right.status,
          ...workerDiagnostics(worker.right.body),
        }
      : {
          reachable: false,
          status: null,
          functionCount: null,
          role: null,
          startedAt: null,
          lastRegistrationAt: null,
          roleCounts: { host: null, cluster: null, active: null },
          duplicateFunctionIds: [],
          hasDuplicateFunctionIds: false,
          error: worker.left.message,
        }

    const ok = Object.values(checks).every((c) => c.ok)

    yield* Console.log(respond("inngest status", {
      checks,
      registeredFunctionCount: functions.length,
      worker: workerInfo,
    }, [
      { command: "joelclaw inngest register", description: "Register functions from worker" },
      { command: "joelclaw inngest restart-worker", description: "Restart system-bus worker" },
      { command: "joelclaw refresh", description: "Full delete + re-register reconciliation" },
    ], ok))
  })
)

const inngestRegisterCmd = Command.make(
  "register",
  {
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(1200),
      Options.withDescription("Wait before verification (default: 1200ms)")
    ),
  },
  ({ waitMs }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const before = yield* inngestClient.functions()
      const reg = yield* registerWorkerFunctions()

      if (waitMs > 0) {
        yield* sleepMs(waitMs)
      }

      const after = yield* inngestClient.functions()
      const beforeNames = new Set(before.map((f) => f.name))
      const afterNames = new Set(after.map((f) => f.name))
      const added = [...afterNames].filter((n) => !beforeNames.has(n))

      const ok = reg.ok

      yield* Console.log(respond("inngest register", {
        request: { url: WORKER_REGISTER_URL, method: "PUT" },
        response: reg,
        beforeCount: before.length,
        afterCount: after.length,
        added,
      }, [
        { command: "joelclaw functions", description: "List all registered functions" },
        { command: "joelclaw inngest status", description: "Verify worker + server health" },
      ], ok))
    })
)

const inngestRestartWorkerCmd = Command.make(
  "restart-worker",
  {
    register: Options.boolean("register").pipe(
      Options.withDefault(true),
      Options.withDescription("Run function registration after restart (default: true)")
    ),
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(1500),
      Options.withDescription("Wait after restart before next step (default: 1500ms)")
    ),
  },
  ({ register, waitMs }) =>
    Effect.gen(function* () {
      yield* restartWorker()

      if (waitMs > 0) {
        yield* sleepMs(waitMs)
      }

      let reg: unknown = null
      if (register) {
        reg = yield* registerWorkerFunctions().pipe(Effect.either)
      }

      const probe = yield* workerProbe().pipe(Effect.either)
      const probeOk = probe._tag === "Right" ? probe.right.ok : false
      const regOk = !register || (reg as any)?._tag === "Right"

      yield* Console.log(respond("inngest restart-worker", {
        restarted: true,
        autoRegister: register,
        registerResult: reg,
        workerProbe: probe,
      }, [
        { command: "joelclaw inngest status", description: "Confirm steady state" },
        { command: "joelclaw logs errors -n 80", description: "Inspect worker stderr if needed" },
      ], probeOk && regOk))
    })
)

const inngestReconcileCmd = Command.make(
  "reconcile",
  {
    deep: Options.boolean("deep").pipe(
      Options.withDefault(false),
      Options.withDescription("Use full refresh (delete app + re-register)")
    ),
  },
  ({ deep }) =>
    Effect.gen(function* () {
      if (deep) {
        yield* Console.log(respond("inngest reconcile", {
          mode: "deep",
          note: "Use joelclaw refresh for delete+re-register reconciliation",
        }, [
          { command: "joelclaw refresh", description: "Run deep reconciliation" },
        ]))
        return
      }

      yield* restartWorker()
      yield* sleepMs(1500)
      const reg = yield* registerWorkerFunctions()
      yield* sleepMs(800)

      const inngestClient = yield* Inngest
      const fns = yield* inngestClient.functions()

      yield* Console.log(respond("inngest reconcile", {
        mode: "fast",
        restartedWorker: true,
        registered: reg,
        functionCount: fns.length,
      }, [
        { command: "joelclaw inngest status", description: "Verify final health" },
        { command: "joelclaw runs --count 5", description: "Check recent run activity" },
      ], reg.ok))
    })
)

const inngestWorkersCmd = Command.make("workers", {}, () =>
  Effect.gen(function* () {
    const probe = yield* workerProbe().pipe(Effect.either)

    if (probe._tag === "Left") {
      yield* Console.log(respond("inngest workers", {
        reachable: false,
        error: probe.left.message,
      }, [
        { command: "joelclaw inngest restart-worker", description: "Restart worker service" },
        { command: "joelclaw logs errors -n 120", description: "Inspect worker stderr" },
      ], false))
      return
    }

    const diag = workerDiagnostics(probe.right.body)
    const ok = probe.right.ok && !diag.hasDuplicateFunctionIds

    yield* Console.log(respond("inngest workers", {
      reachable: probe.right.ok,
      status: probe.right.status,
      diagnostics: diag,
      checks: {
        duplicateIdsBlocked: diag.duplicateFunctionIds.length === 0,
      },
    }, [
      { command: "joelclaw inngest status", description: "Service + registration snapshot" },
      { command: "joelclaw inngest register", description: "Force registration refresh" },
      { command: "joelclaw functions", description: "List Inngest registered functions" },
    ], ok))
  })
)

const inngestMemoryE2ECmd = Command.make(
  "memory-e2e",
  {
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(90_000),
      Options.withDescription("Max wait for observe->Typesense propagation (default: 90000)")
    ),
    pollMs: Options.integer("poll-ms").pipe(
      Options.withDefault(1500),
      Options.withDescription("Polling interval while waiting for Typesense update")
    ),
  },
  ({ waitMs, pollMs }) =>
    Effect.gen(function* () {
      try {
        const inngestClient = yield* Inngest
        const apiKey = resolveTypesenseApiKey()
        const safeWaitMs = Math.max(3000, waitMs)
        const safePollMs = Math.max(500, pollMs)

        const probeId = `memory-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const sessionId = `session-${probeId}`
        const dedupeKey = `dedupe-${probeId}`
        const before = yield* Effect.tryPromise(() => memorySnapshot(apiKey))

        const eventPayload = {
          sessionId,
          dedupeKey,
          trigger: "shutdown",
          messages: [
            `Typesense E2E memory probe marker: ${probeId}.`,
            "This is an automated health check event for memory/session.ended.",
          ].join("\n"),
          messageCount: 2,
          userMessageCount: 1,
          duration: 1,
          filesRead: [],
          filesModified: [],
          capturedAt: new Date().toISOString(),
          schemaVersion: 1,
        }

        const sendResult = yield* inngestClient.send("memory/session.ended", eventPayload)

      const eventIds = Array.isArray((sendResult as any)?.ids)
        ? (sendResult as any).ids.filter((value: unknown) => typeof value === "string")
        : []
      const eventAccepted = eventIds.length > 0

      let after = before
      let sessionMatches = 0
      let markerMatches = 0
      let observeRunStatus: string | null = null
      let pendingRuns: number | null = null
      let totalRuns: number | null = null
      let observeStore: { stored: boolean; count: number; mergedCount: number; errors: number; error?: string } | null = null
      const startedAt = Date.now()

      while (Date.now() - startedAt <= safeWaitMs) {
        yield* sleepMs(safePollMs)
        after = yield* Effect.tryPromise(() => memorySnapshot(apiKey))
        sessionMatches = yield* Effect.tryPromise(() => memorySessionCount(apiKey, sessionId))
        markerMatches = yield* Effect.tryPromise(() => memoryMarkerCount(apiKey, probeId))

        if (eventIds[0]) {
          const eventState = yield* inngestClient.event(eventIds[0])
          pendingRuns = eventState.event?.pendingRuns ?? null
          totalRuns = eventState.event?.totalRuns ?? null
          const observeRun = (eventState.runs ?? []).find((run: any) =>
            typeof run?.functionName === "string" && /observe/iu.test(run.functionName)
          )
          if (typeof observeRun?.status === "string") {
            observeRunStatus = observeRun.status
          }
          if (typeof observeRun?.output === "string" && observeRun.output.trim().length > 0) {
            try {
              const parsed = JSON.parse(observeRun.output) as Record<string, any>
              const typesense = parsed?.typesense
              if (typesense && typeof typesense === "object") {
                observeStore = {
                  stored: Boolean(typesense.stored),
                  count: Number(typesense.count ?? 0) || 0,
                  mergedCount: Number(typesense.mergedCount ?? 0) || 0,
                  errors: Number(typesense.errors ?? 0) || 0,
                  error: typeof typesense.error === "string" ? typesense.error : undefined,
                }
              }
            } catch {
              // keep polling; output may not be JSON yet
            }
          }
        }

        const countChanged = after.count !== before.count
        const updatedChanged = after.latestUpdatedAt !== before.latestUpdatedAt
          || after.latestTimestamp !== before.latestTimestamp
        const observeStoreChanged = !!observeStore?.stored && (observeStore.count > 0 || observeStore.mergedCount > 0)
        const typesenseChanged = markerMatches > 0 || sessionMatches > 0 || countChanged || updatedChanged || observeStoreChanged
        const runFinished = observeRunStatus === "COMPLETED" || observeRunStatus === "FAILED" || observeRunStatus === "CANCELLED"

        if (typesenseChanged && (runFinished || !eventIds[0])) break
      }

      const countChanged = after.count !== before.count
      const updatedChanged = after.latestUpdatedAt !== before.latestUpdatedAt
        || after.latestTimestamp !== before.latestTimestamp
      const observeStoreChanged = !!observeStore?.stored && (observeStore.count > 0 || observeStore.mergedCount > 0)
      const typesenseChanged = markerMatches > 0 || sessionMatches > 0 || countChanged || updatedChanged || observeStoreChanged
      const observeRunCompleted = observeRunStatus === "COMPLETED"

      const vector = yield* Effect.tryPromise(() => vectorProbe(apiKey, probeId))
      const vectorOk = vector.hitCount > 0

      const recall = runRecallProbe(probeId)
      const recallOk = recall.ok

      const ok = eventAccepted && observeRunCompleted && typesenseChanged && vectorOk && recallOk

        yield* Console.log(respond("inngest memory-e2e", {
          ok,
          probe: {
            id: probeId,
            sessionId,
            dedupeKey,
          },
          observeEvent: {
            accepted: eventAccepted,
            ids: eventIds,
            observeRunStatus,
            pendingRuns,
            totalRuns,
            payload: eventPayload,
          },
          typesense: {
            changed: typesenseChanged,
            sessionMatches,
            markerMatches,
            observeStore,
            before,
            after,
            checks: {
              countChanged,
              updatedChanged,
              observeStoreChanged,
            },
          },
          vectorQuery: {
            ok: vectorOk,
            found: vector.found,
            hitCount: vector.hitCount,
          },
          recallProbe: {
            ok: recallOk,
            command: recall.command.join(" "),
            exitCode: recall.exitCode,
            error: recall.stderr || undefined,
            outputOk: recall.parsed?.ok ?? false,
          },
        }, [
          { command: "joelclaw inngest memory-e2e", description: "Re-run memory Typesense E2E probe" },
          { command: "joelclaw recall <query> --json", description: "Run recall directly with JSON output" },
          { command: "joelclaw status", description: "Check worker and service health" },
        ], ok))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "inngest memory-e2e",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const unreachable = isTypesenseUnreachableMessage(message)
        yield* Console.log(respondError(
          "inngest memory-e2e",
          message,
          unreachable ? "TYPESENSE_UNREACHABLE" : "MEMORY_E2E_FAILED",
          unreachable
            ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
            : "Inspect worker logs and otel events for memory pipeline failures",
          [
            { command: "joelclaw status", description: "Check service health" },
            { command: "joelclaw otel stats --hours 1", description: "Check recent error-rate signal" },
          ]
        ))
      }
    })
)

const inngestMemoryWeeklyCmd = Command.make(
  "memory-weekly",
  {
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(30_000),
      Options.withDescription("Max wait for weekly maintenance run completion (default: 30000)")
    ),
    pollMs: Options.integer("poll-ms").pipe(
      Options.withDefault(1000),
      Options.withDescription("Polling interval while waiting for run completion (default: 1000)")
    ),
  },
  ({ waitMs, pollMs }) =>
    Effect.gen(function* () {
      try {
        const inngestClient = yield* Inngest
        const apiKey = resolveTypesenseApiKey()
        const safeWaitMs = Math.max(2000, waitMs)
        const safePollMs = Math.max(250, pollMs)
        const startedAt = Date.now()
        const startedIso = new Date(startedAt).toISOString()
        const functions = yield* inngestClient.functions()
        const weeklyFunction = functions.find((fn) =>
          /memory-weekly-maintenance-summary/iu.test(fn.slug) || /weekly maintenance/iu.test(fn.name)
        )
        if (!weeklyFunction) {
          throw new Error("Weekly maintenance function is not registered")
        }

        const invokeMutation = `mutation { invokeFunction(functionSlug: "${weeklyFunction.slug}", data: { reason: "manual weekly memory governance check", requestedBy: "joelclaw inngest memory-weekly" }) }`
        const invoked = yield* Effect.tryPromise({
          try: async () => {
            const resp = await fetch(`${cfg.inngestUrl}/v0/gql`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: invokeMutation }),
            })
            if (!resp.ok) {
              throw new Error(`Inngest GQL invoke failed (${resp.status})`)
            }
            const body = await resp.json() as { data?: { invokeFunction?: boolean }; errors?: Array<{ message?: string }> }
            if (Array.isArray(body.errors) && body.errors.length > 0) {
              throw new Error(body.errors[0]?.message ?? "Inngest GQL invoke returned errors")
            }
            return body.data?.invokeFunction === true
          },
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        })
        if (!invoked) {
          throw new Error("Inngest invokeFunction returned false for weekly maintenance")
        }

        let runStatus: string | null = null
        let runId: string | null = null
        let runStartedAt: string | null = null
        let runOutput: Record<string, unknown> | null = null
        const deadline = Date.now() + safeWaitMs
        while (Date.now() <= deadline) {
          const recentRuns = yield* inngestClient.runs({ count: 80, hours: 2 })
          const matching = recentRuns
            .filter((run) =>
              String(run.functionID) === weeklyFunction.id
              && Date.parse(String(run.startedAt ?? "")) >= startedAt - 2000
            )
            .sort((a, b) => Date.parse(String(b.startedAt ?? "")) - Date.parse(String(a.startedAt ?? "")))

          const weeklyRun = matching[0]
          if (weeklyRun) {
            runStatus = typeof weeklyRun.status === "string" ? weeklyRun.status : null
            runId = typeof weeklyRun.id === "string" ? weeklyRun.id : null
            runStartedAt = typeof weeklyRun.startedAt === "string" ? weeklyRun.startedAt : null
            if (typeof weeklyRun.output === "string" && weeklyRun.output.trim().length > 0) {
              try {
                runOutput = JSON.parse(weeklyRun.output) as Record<string, unknown>
              } catch {
                runOutput = { raw: weeklyRun.output.slice(0, 500) }
              }
            }
          }

          if (runStatus === "COMPLETED" || runStatus === "FAILED" || runStatus === "CANCELLED") {
            break
          }

          yield* sleepMs(safePollMs)
        }

        const otelCompletedFilter = `timestamp:>=${Math.floor(startedAt)} && component:=weekly-maintenance && action:=weekly-maintenance.completed`
        const otelFailedFilter = `timestamp:>=${Math.floor(startedAt)} && component:=weekly-maintenance && action:=weekly-maintenance.failed`

        const [otelCompleted, otelFailed] = yield* Effect.all([
          Effect.tryPromise(() => typesenseCount(apiKey, "otel_events", OTEL_QUERY_BY, otelCompletedFilter)),
          Effect.tryPromise(() => typesenseCount(apiKey, "otel_events", OTEL_QUERY_BY, otelFailedFilter)),
        ])

        const runFinished = runStatus === "COMPLETED"
          || runStatus === "FAILED"
          || runStatus === "CANCELLED"
        const runCompletedByOtel = runStatus === "RUNNING" && otelCompleted > 0
        const ok = invoked && (runFinished ? runStatus === "COMPLETED" : runCompletedByOtel) && otelCompleted > 0 && otelFailed === 0

        yield* Console.log(respond("inngest memory-weekly", {
          ok,
          trigger: {
            accepted: invoked,
            mode: "invokeFunction",
            functionId: weeklyFunction.id,
            functionSlug: weeklyFunction.slug,
            requestedAt: startedIso,
          },
          run: {
            id: runId,
            status: runStatus,
            startedAt: runStartedAt,
            output: runOutput,
          },
          otelEvidence: {
            completedCount: otelCompleted,
            failedCount: otelFailed,
            completedFilter: otelCompletedFilter,
            failedFilter: otelFailedFilter,
          },
        }, [
          { command: "joelclaw otel search \"weekly-maintenance.completed\" --hours 24", description: "Inspect weekly maintenance telemetry" },
          { command: "joelclaw inngest memory-health --hours 24", description: "Verify memory health gates remain green" },
        ], ok))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "inngest memory-weekly",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const unreachable = isTypesenseUnreachableMessage(message)
        yield* Console.log(respondError(
          "inngest memory-weekly",
          message,
          unreachable ? "TYPESENSE_UNREACHABLE" : "MEMORY_WEEKLY_FAILED",
          unreachable
            ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
            : "Inspect worker runs and OTEL events for weekly memory maintenance failures",
          [
            { command: "joelclaw otel search \"weekly-maintenance\" --hours 24", description: "Inspect weekly maintenance events" },
            { command: "joelclaw runs --count 20 --hours 24", description: "Inspect recent Inngest runs" },
          ]
        ))
      }
    })
)

const inngestMemoryGateCmd = Command.make(
  "memory-gate",
  {
    e2eWaitMs: Options.integer("e2e-wait-ms").pipe(
      Options.withDefault(120000),
      Options.withDescription("Max wait for memory-e2e observe completion (default: 120000)")
    ),
    e2ePollMs: Options.integer("e2e-poll-ms").pipe(
      Options.withDefault(1500),
      Options.withDescription("Poll interval for memory-e2e run checks (default: 1500)")
    ),
    weeklyWaitMs: Options.integer("weekly-wait-ms").pipe(
      Options.withDefault(60000),
      Options.withDescription("Max wait for memory-weekly completion (default: 60000)")
    ),
    weeklyPollMs: Options.integer("weekly-poll-ms").pipe(
      Options.withDefault(1000),
      Options.withDescription("Poll interval for memory-weekly run checks (default: 1000)")
    ),
    healthHours: Options.integer("health-hours").pipe(
      Options.withDefault(24),
      Options.withDescription("Lookback hours for memory-health check (default: 24)")
    ),
    healthStallMinutes: Options.integer("health-stall-minutes").pipe(
      Options.withDefault(30),
      Options.withDescription("Stall threshold minutes for memory-health check (default: 30)")
    ),
  },
  ({ e2eWaitMs, e2ePollMs, weeklyWaitMs, weeklyPollMs, healthHours, healthStallMinutes }) =>
    Effect.gen(function* () {
      const startedAt = new Date().toISOString()

      const e2e = runJoelclawJsonCommand([
        "inngest",
        "memory-e2e",
        "--wait-ms",
        String(Math.max(1000, Math.floor(e2eWaitMs))),
        "--poll-ms",
        String(Math.max(250, Math.floor(e2ePollMs))),
        "--json",
      ])
      const weekly = runJoelclawJsonCommand([
        "inngest",
        "memory-weekly",
        "--wait-ms",
        String(Math.max(1000, Math.floor(weeklyWaitMs))),
        "--poll-ms",
        String(Math.max(250, Math.floor(weeklyPollMs))),
        "--json",
      ])
      const health = runJoelclawJsonCommand([
        "inngest",
        "memory-health",
        "--hours",
        String(Math.max(1, Math.floor(healthHours))),
        "--stall-minutes",
        String(Math.max(1, Math.floor(healthStallMinutes))),
        "--json",
      ])

      const summarizeStage = (
        probe: {
          command: string[]
          exitCode: number
          stdout: string
          stderr: string
          ok: boolean
          parsed?: Record<string, unknown>
        }
      ) => {
        const parsed = probe.parsed
        const parsedResult = parsed && typeof parsed.result === "object"
          ? parsed.result
          : null
        const parsedError = parsed && typeof parsed.error === "object"
          ? parsed.error
          : null
        return {
          ok: probe.ok,
          exitCode: probe.exitCode,
          command: typeof parsed?.command === "string" ? parsed.command : probe.command.join(" "),
          stderr: probe.stderr || null,
          result: parsedResult,
          error: parsedError,
        }
      }

      const stages = {
        memoryE2E: summarizeStage(e2e),
        memoryWeekly: summarizeStage(weekly),
        memoryHealth: summarizeStage(health),
      }
      const ok = stages.memoryE2E.ok && stages.memoryWeekly.ok && stages.memoryHealth.ok

      yield* Console.log(respond("inngest memory-gate", {
        ok,
        startedAt,
        finishedAt: new Date().toISOString(),
        stages,
      }, [
        { command: "joelclaw inngest memory-gate --json", description: "Re-run full memory phase gate checks" },
        { command: "joelclaw otel stats --hours 24", description: "Inspect OTEL error-rate summary" },
        { command: "joelclaw otel search \"echo-fizzle\" --hours 24", description: "Inspect echo/fizzle lifecycle telemetry" },
      ], ok))
    })
)

const inngestMemorySchemaReconcileCmd = Command.make(
  "memory-schema-reconcile",
  {
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDefault(false),
      Options.withDescription("Report missing memory_observations schema fields without patching")
    ),
  },
  ({ dryRun }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const before = yield* Effect.tryPromise(() =>
          typesenseCollectionSchema(apiKey, "memory_observations")
        )
        const existing = new Set((before.fields ?? []).map((field) => field.name))
        const missing = MEMORY_OBSERVATIONS_REQUIRED_FIELDS.filter(
          (field) => !existing.has(field.name)
        )

        if (!dryRun && missing.length > 0) {
          yield* Effect.tryPromise(() =>
            typesensePatchCollectionFields(apiKey, "memory_observations", missing)
          )
        }

        const after = yield* Effect.tryPromise(() =>
          typesenseCollectionSchema(apiKey, "memory_observations")
        )

        const staleProbe = yield* Effect.tryPromise(() =>
          typesenseCount(apiKey, "memory_observations", "observation", "stale:=true")
            .then((count) => ({ ok: true, count, error: null as string | null }))
            .catch((error) => ({
              ok: false,
              count: null as number | null,
              error: error instanceof Error ? error.message : String(error),
            }))
        )

        const ok = dryRun ? true : staleProbe.ok

        yield* Console.log(respond("inngest memory-schema-reconcile", {
          ok,
          dryRun,
          collection: "memory_observations",
          requiredFieldCount: MEMORY_OBSERVATIONS_REQUIRED_FIELDS.length,
          schema: {
            beforeFieldCount: Array.isArray(before.fields) ? before.fields.length : 0,
            afterFieldCount: Array.isArray(after.fields) ? after.fields.length : 0,
          },
          missingFields: missing.map((field) => ({ name: field.name, type: field.type })),
          patchedFields: dryRun ? [] : missing.map((field) => field.name),
          staleFilterProbe: staleProbe,
        }, [
          { command: "joelclaw inngest memory-health --hours 24 --stall-minutes 30 --json", description: "Verify stale ratio and health checks" },
          { command: "joelclaw inngest memory-gate --json", description: "Run full memory phase gate checks" },
        ], ok))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "inngest memory-schema-reconcile",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const unreachable = isTypesenseUnreachableMessage(message)
        yield* Console.log(respondError(
          "inngest memory-schema-reconcile",
          message,
          unreachable ? "TYPESENSE_UNREACHABLE" : "MEMORY_SCHEMA_RECONCILE_FAILED",
          unreachable
            ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
            : "Inspect Typesense collection schema and memory field definitions",
          [
            { command: "joelclaw inngest memory-schema-reconcile --dry-run --json", description: "Inspect missing fields without patching" },
            { command: "joelclaw inngest memory-health --json", description: "Verify health after schema change" },
          ]
        ))
      }
    })
)

const inngestMemoryHealthCmd = Command.make(
  "memory-health",
  {
    hours: Options.integer("hours").pipe(
      Options.withDefault(24),
      Options.withDescription("Lookback window for OTEL/runs checks (default: 24)")
    ),
    stallMinutes: Options.integer("stall-minutes").pipe(
      Options.withDefault(30),
      Options.withDescription("Max minutes since last successful memory stage (default: 30)")
    ),
    maxErrorRate: Options.float("max-error-rate").pipe(
      Options.withDefault(0.2),
      Options.withDescription("Fail threshold for OTEL error rate (default: 0.2)")
    ),
    maxFailedRuns: Options.integer("max-failed-runs").pipe(
      Options.withDefault(3),
      Options.withDescription("Fail threshold for failed memory runs in window (default: 3)")
    ),
    maxBacklog: Options.integer("max-backlog").pipe(
      Options.withDefault(4),
      Options.withDescription("Fail threshold for queued/running memory runs (default: 4)")
    ),
    maxStaleRatio: Options.float("max-stale-ratio").pipe(
      Options.withDefault(0.5),
      Options.withDescription("Fail threshold for stale memory ratio (default: 0.5)")
    ),
  },
  ({ hours, stallMinutes, maxErrorRate, maxFailedRuns, maxBacklog, maxStaleRatio }) =>
    Effect.gen(function* () {
      try {
        const inngestClient = yield* Inngest
        const apiKey = resolveTypesenseApiKey()
        const safeHours = Math.max(1, Math.floor(hours))
        const safeStallMinutes = Math.max(1, Math.floor(stallMinutes))
        const cutoffMs = Date.now() - safeHours * 60 * 60 * 1000
        const cutoffUnix = Math.floor(cutoffMs)
        const cutoffIso = new Date(cutoffMs).toISOString()

      const componentFilter = `component:=[${MEMORY_COMPONENTS.join(",")}]`
      const otelBaseFilter = `timestamp:>=${cutoffUnix} && ${componentFilter}`
      const otelErrorFilter = `${otelBaseFilter} && level:=[error,fatal]`
      const otelSuccessFilter = `${otelBaseFilter} && success:=true`

      const [
        otelTotal,
        otelErrors,
        otelSuccess,
        latestSuccess,
        memoryTotals,
        runs,
      ] = yield* Effect.all([
        Effect.tryPromise(() => typesenseCount(apiKey, "otel_events", OTEL_QUERY_BY, otelBaseFilter)),
        Effect.tryPromise(() => typesenseCount(apiKey, "otel_events", OTEL_QUERY_BY, otelErrorFilter)),
        Effect.tryPromise(() => typesenseCount(apiKey, "otel_events", OTEL_QUERY_BY, otelSuccessFilter)),
        Effect.tryPromise(() => latestOtelEvent(apiKey, otelSuccessFilter)),
        Effect.tryPromise(() =>
          Promise.all([
            typesenseCount(apiKey, "memory_observations", "observation"),
            typesenseCount(apiKey, "memory_observations", "observation", "stale:=true")
              .then((count) => ({ count, supported: true, reason: null as string | null }))
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error)
                if (/filter field named `stale`/iu.test(message)) {
                  return { count: 0, supported: false, reason: "stale field missing in Typesense schema" }
                }
                throw error
              }),
          ])
        ),
        inngestClient.runs({ count: 300, hours: safeHours }),
      ])

      const memoryRuns = runs.filter((run) => isMemoryFunctionName(run.functionName))
      const failedRuns = memoryRuns.filter((run) => ["FAILED", "CANCELLED"].includes(String(run.status)))
      const activeRuns = memoryRuns.filter((run) => {
        const status = String(run.status)
        return status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED"
      })

      const [memoryCount, staleState] = memoryTotals
      const staleCount = staleState.count
      const staleRatio = memoryCount > 0 ? staleCount / memoryCount : 0
      const errorRate = otelTotal > 0 ? otelErrors / otelTotal : 0
      const latestSuccessIso = typeof latestSuccess.timestamp === "number"
        ? new Date(latestSuccess.timestamp).toISOString()
        : null
      const minutesSinceSuccess = typeof latestSuccess.timestamp === "number"
        ? (Date.now() - latestSuccess.timestamp) / 60000
        : Number.POSITIVE_INFINITY

      const checks = {
        memoryStageStall: minutesSinceSuccess <= safeStallMinutes,
        otelErrorRate: otelTotal >= 20 ? errorRate <= maxErrorRate : true,
        staleRatio: staleState.supported ? (memoryCount >= 25 ? staleRatio <= maxStaleRatio : true) : true,
        failedMemoryRuns: failedRuns.length <= maxFailedRuns,
        memoryBacklog: activeRuns.length <= maxBacklog,
      }

      const ok = Object.values(checks).every(Boolean)

        yield* Console.log(respond("inngest memory-health", {
          ok,
          checks,
          thresholds: {
            hours: safeHours,
            stallMinutes: safeStallMinutes,
            maxErrorRate,
            maxFailedRuns,
            maxBacklog,
            maxStaleRatio,
          },
          memory: {
            count: memoryCount,
            staleCount,
            staleRatio,
            staleMetricSupported: staleState.supported,
            staleMetricReason: staleState.reason,
          },
          runs: {
            totalWindowRuns: runs.length,
            memoryWindowRuns: memoryRuns.length,
            failedMemoryRuns: failedRuns.length,
            activeMemoryRuns: activeRuns.length,
            recentFailed: failedRuns.slice(0, 5).map((run) => ({
              id: run.id,
              status: run.status,
              function: run.functionName,
              startedAt: run.startedAt,
            })),
          },
          otelEvidence: {
            queryWindow: {
              hours: safeHours,
              cutoffIso,
              filter: otelBaseFilter,
            },
            counts: {
              total: otelTotal,
              success: otelSuccess,
              errors: otelErrors,
              errorRate,
            },
            latestSuccess: {
              id: latestSuccess.id,
              ts: latestSuccessIso,
              component: latestSuccess.component,
              action: latestSuccess.action,
              minutesSinceSuccess: Number.isFinite(minutesSinceSuccess) ? minutesSinceSuccess : null,
            },
          },
        }, [
          { command: "joelclaw otel search \"observe\" --hours 24 --component observe", description: "Inspect observe-stage telemetry" },
          { command: "joelclaw otel stats --hours 24", description: "Check OTEL error-rate snapshot" },
          { command: "joelclaw inngest memory-e2e", description: "Run full memory observe→Typesense→recall probe" },
        ], ok))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "inngest memory-health",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const unreachable = isTypesenseUnreachableMessage(message)
        yield* Console.log(respondError(
          "inngest memory-health",
          message,
          unreachable ? "TYPESENSE_UNREACHABLE" : "MEMORY_HEALTH_FAILED",
          unreachable
            ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
            : "Inspect worker runs and OTEL events for memory pipeline failures",
          [
            { command: "joelclaw status", description: "Check service health" },
            { command: "joelclaw otel list --hours 1 --level error,fatal", description: "Inspect recent high-severity events" },
          ]
        ))
      }
    })
)

export const inngestCmd = Command.make("inngest", {}, () =>
  Console.log(respond("inngest", {
    description: "Inngest operational shortcuts",
    subcommands: {
      status: "joelclaw inngest status",
      workers: "joelclaw inngest workers",
      register: "joelclaw inngest register [--wait-ms 1200]",
      "restart-worker": "joelclaw inngest restart-worker [--register] [--wait-ms 1500]",
      reconcile: "joelclaw inngest reconcile [--deep]",
      "memory-e2e": "joelclaw inngest memory-e2e [--wait-ms 90000] [--poll-ms 1500]",
      "memory-weekly": "joelclaw inngest memory-weekly [--wait-ms 30000] [--poll-ms 1000]",
      "memory-gate": "joelclaw inngest memory-gate [--e2e-wait-ms 120000] [--weekly-wait-ms 60000] [--health-hours 24]",
      "memory-schema-reconcile": "joelclaw inngest memory-schema-reconcile [--dry-run]",
      "memory-health": "joelclaw inngest memory-health [--hours 24] [--stall-minutes 30]",
      deep_reconcile_alias: "joelclaw refresh",
    },
  }, [
    { command: "joelclaw inngest status", description: "Check worker/server/function health" },
    { command: "joelclaw inngest workers", description: "Worker role + duplicate-id diagnostics" },
    { command: "joelclaw inngest register", description: "Register functions from worker" },
    { command: "joelclaw inngest restart-worker --register", description: "Restart worker and register functions" },
    { command: "joelclaw inngest reconcile", description: "Restart worker + register functions" },
    { command: "joelclaw inngest memory-e2e", description: "Run memory observe→Typesense→recall E2E check" },
    { command: "joelclaw inngest memory-weekly", description: "Manually run weekly memory maintenance summary and verify OTEL" },
    { command: "joelclaw inngest memory-gate", description: "Run memory-e2e + memory-weekly + memory-health gate checks" },
    { command: "joelclaw inngest memory-schema-reconcile", description: "Ensure memory_observations schema fields needed for health/ranking" },
    { command: "joelclaw inngest memory-health", description: "Run OTEL-backed memory health checks" },
  ]))
).pipe(
  Command.withSubcommands([
    inngestStatusCmd,
    inngestWorkersCmd,
    inngestRegisterCmd,
    inngestRestartWorkerCmd,
    inngestReconcileCmd,
    inngestMemoryE2ECmd,
    inngestMemoryWeeklyCmd,
    inngestMemoryGateCmd,
    inngestMemorySchemaReconcileCmd,
    inngestMemoryHealthCmd,
  ])
)
