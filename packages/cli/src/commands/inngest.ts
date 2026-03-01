import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { loadConfig } from "../config"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const cfg = loadConfig()
const HOME_DIR = process.env.HOME ?? "/Users/joel"
const WORKER_URL = cfg.workerUrl
const WORKER_REGISTER_URL = `${WORKER_URL}/api/inngest`
const WORKER_LABEL = "com.joel.system-bus-worker"
const WORKER_LAUNCHD_PLIST_SOURCE = `${HOME_DIR}/Code/joelhooks/joelclaw/infra/launchd/${WORKER_LABEL}.plist`
const WORKER_LAUNCHD_PLIST_TARGET = `${HOME_DIR}/Library/LaunchAgents/${WORKER_LABEL}.plist`
const WORKER_EXPECTED_START_FALLBACK = `${HOME_DIR}/Code/joelhooks/joelclaw/packages/system-bus/start.sh`
const WORKER_EXPECTED_CWD_FALLBACK = `${HOME_DIR}/Code/joelhooks/joelclaw/packages/system-bus`
const LEGACY_WORKER_PATH_FRAGMENT = "/Code/system-bus-worker/"
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

type WorkerExpectedBinding = {
  program: string
  workingDirectory: string
  plistSource: string
  plistTarget: string
}

function readLaunchdPlistValue(plistPath: string, keyPath: string): string | null {
  const proc = Bun.spawnSync([
    "plutil",
    "-extract",
    keyPath,
    "raw",
    "-o",
    "-",
    plistPath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.exitCode !== 0) return null
  const value = decodeText(proc.stdout).trim()
  return value.length > 0 ? value : null
}

function resolveExpectedWorkerBinding(): WorkerExpectedBinding {
  const program =
    readLaunchdPlistValue(WORKER_LAUNCHD_PLIST_SOURCE, "ProgramArguments.0")
    ?? WORKER_EXPECTED_START_FALLBACK
  const workingDirectory =
    readLaunchdPlistValue(WORKER_LAUNCHD_PLIST_SOURCE, "WorkingDirectory")
    ?? WORKER_EXPECTED_CWD_FALLBACK

  return {
    program,
    workingDirectory,
    plistSource: WORKER_LAUNCHD_PLIST_SOURCE,
    plistTarget: WORKER_LAUNCHD_PLIST_TARGET,
  }
}

const WORKER_EXPECTED_BINDING = resolveExpectedWorkerBinding()

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
  runtime?: {
    cwd?: string
    deploymentModel?: string
    legacyCloneDetected?: boolean
  }
}

type TypesenseSearchResponse = {
  found?: number
  hits?: Array<{ document?: Record<string, unknown> }>
  facet_counts?: Array<{
    field_name?: string
    counts?: Array<{ value?: string | number; count?: number }>
  }>
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

async function typesenseFacetCounts(
  apiKey: string,
  collection: "memory_observations" | "otel_events",
  queryBy: string,
  facetBy: string,
  filterBy?: string,
): Promise<Array<{ value: string; count: number }>> {
  const params = new URLSearchParams({
    q: "*",
    query_by: queryBy,
    per_page: "1",
    facet_by: facetBy,
    max_facet_values: "100",
    exclude_fields: "embedding",
  })
  if (filterBy) params.set("filter_by", filterBy)

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Typesense facet query failed (${resp.status}): ${body}`)
  }

  const data = await resp.json() as TypesenseSearchResponse
  const facet = (data.facet_counts ?? []).find((entry) => entry.field_name === facetBy)
  const counts = facet?.counts ?? []
  return counts
    .map((entry) => ({
      value: String(entry.value ?? "").trim(),
      count: typeof entry.count === "number" ? entry.count : 0,
    }))
    .filter((entry) => entry.value.length > 0 && entry.count > 0)
    .sort((a, b) => b.count - a.count)
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

type WorkerLaunchdBinding = {
  uid: number
  service: string
  plistPath: string | null
  program: string | null
  workingDirectory: string | null
  state: string | null
}

type WorkerSourceEvaluation = {
  compliant: boolean
  programMatches: boolean
  workingDirectoryMatches: boolean
  legacyPathDetected: boolean
}

function parseLaunchctlField(raw: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = raw.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, "mi"))
  return match?.[1]?.trim() ?? null
}

const inspectWorkerLaunchdBinding = () =>
  Effect.try({
    try: () => {
      const uid = process.getuid?.() ?? 0
      const service = `gui/${uid}/${WORKER_LABEL}`
      const proc = Bun.spawnSync(["launchctl", "print", service], {
        stdout: "pipe",
        stderr: "pipe",
      })

      if (proc.exitCode !== 0) {
        const stderr = decodeText(proc.stderr).trim()
        throw new Error(stderr || `launchctl print exited with ${proc.exitCode}`)
      }

      const output = decodeText(proc.stdout)
      return {
        uid,
        service,
        plistPath: parseLaunchctlField(output, "path"),
        program: parseLaunchctlField(output, "program"),
        workingDirectory: parseLaunchctlField(output, "working directory"),
        state: parseLaunchctlField(output, "state"),
      } as WorkerLaunchdBinding
    },
    catch: (e) => new Error(`Failed to inspect worker launchd binding: ${e}`),
  })

function evaluateWorkerSource(binding: WorkerLaunchdBinding): WorkerSourceEvaluation {
  const program = binding.program ?? ""
  const workingDirectory = binding.workingDirectory ?? ""
  const programMatches = program === WORKER_EXPECTED_BINDING.program
  const workingDirectoryMatches = workingDirectory === WORKER_EXPECTED_BINDING.workingDirectory
  const legacyPathDetected =
    program.includes(LEGACY_WORKER_PATH_FRAGMENT)
    || workingDirectory.includes(LEGACY_WORKER_PATH_FRAGMENT)

  return {
    compliant: programMatches && workingDirectoryMatches && !legacyPathDetected,
    programMatches,
    workingDirectoryMatches,
    legacyPathDetected,
  }
}

const repairWorkerLaunchdBinding = () =>
  Effect.try({
    try: () => {
      const uid = process.getuid?.() ?? 0
      const copyProc = Bun.spawnSync([
        "cp",
        WORKER_LAUNCHD_PLIST_SOURCE,
        WORKER_LAUNCHD_PLIST_TARGET,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      })

      if (copyProc.exitCode !== 0) {
        const stderr = decodeText(copyProc.stderr).trim()
        throw new Error(stderr || `cp exited with ${copyProc.exitCode}`)
      }

      const bootoutProc = Bun.spawnSync([
        "launchctl",
        "bootout",
        `gui/${uid}/${WORKER_LABEL}`,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      })

      if (bootoutProc.exitCode !== 0) {
        const stderr = decodeText(bootoutProc.stderr).trim()
        const expectedBootoutMiss = /could not find service|no such process|not loaded/iu.test(stderr)
        if (!expectedBootoutMiss) {
          throw new Error(stderr || `launchctl bootout exited with ${bootoutProc.exitCode}`)
        }
      }

      // launchd can briefly race after bootout; retry bootstrap on transient I/O failure.
      const bootstrapAttempts = 4
      let bootstrapSuccessAttempt = 0
      let bootstrapLastError = ""

      for (let attempt = 1; attempt <= bootstrapAttempts; attempt++) {
        if (attempt > 1) {
          Bun.spawnSync(["sleep", "0.5"], { stdout: "pipe", stderr: "pipe" })
        }

        const bootstrapProc = Bun.spawnSync([
          "launchctl",
          "bootstrap",
          `gui/${uid}`,
          WORKER_LAUNCHD_PLIST_TARGET,
        ], {
          stdout: "pipe",
          stderr: "pipe",
        })

        if (bootstrapProc.exitCode === 0) {
          bootstrapSuccessAttempt = attempt
          break
        }

        const stderr = decodeText(bootstrapProc.stderr).trim()
        const alreadyLoaded = /already loaded|in progress|service is disabled/iu.test(stderr)
        if (alreadyLoaded) {
          bootstrapSuccessAttempt = attempt
          break
        }

        bootstrapLastError = stderr || `launchctl bootstrap exited with ${bootstrapProc.exitCode}`

        const transientIo = /bootstrap failed:\s*5|input\/output error/iu.test(bootstrapLastError)
        if (!transientIo || attempt === bootstrapAttempts) {
          throw new Error(bootstrapLastError)
        }
      }

      if (bootstrapSuccessAttempt === 0) {
        throw new Error(bootstrapLastError || "launchctl bootstrap did not succeed")
      }

      return {
        repaired: true,
        sourcePlist: WORKER_LAUNCHD_PLIST_SOURCE,
        targetPlist: WORKER_LAUNCHD_PLIST_TARGET,
        bootstrapAttempts: bootstrapSuccessAttempt,
      }
    },
    catch: (e) => new Error(`Failed to repair worker launchd binding: ${e}`),
  })

const ensureSingleSourceWorkerBinding = (repair: boolean) =>
  Effect.gen(function* () {
    const before = yield* inspectWorkerLaunchdBinding()
    const beforeEvaluation = evaluateWorkerSource(before)

    if (beforeEvaluation.compliant) {
      return {
        compliant: true,
        repaired: false,
        before,
        after: before,
        evaluation: beforeEvaluation,
      }
    }

    if (!repair) {
      throw new Error(
        `Worker launchd drift detected: program=${before.program ?? "unknown"}, cwd=${before.workingDirectory ?? "unknown"}`
      )
    }

    const repairResult = yield* repairWorkerLaunchdBinding()
    const after = yield* inspectWorkerLaunchdBinding()
    const afterEvaluation = evaluateWorkerSource(after)

    if (!afterEvaluation.compliant) {
      throw new Error(
        `Worker launchd drift persisted after repair: program=${after.program ?? "unknown"}, cwd=${after.workingDirectory ?? "unknown"}`
      )
    }

    return {
      compliant: true,
      repaired: true,
      before,
      after,
      evaluation: afterEvaluation,
      repairResult,
    }
  })

const restartWorker = (options: { enforceSingleSource?: boolean } = {}) =>
  Effect.gen(function* () {
    const enforceSingleSource = options.enforceSingleSource ?? true
    const sourceCheck = enforceSingleSource
      ? (yield* ensureSingleSourceWorkerBinding(true))
      : null

    const uid = process.getuid?.() ?? 0
    const proc = Bun.spawnSync([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${uid}/${WORKER_LABEL}`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    })

    if (proc.exitCode !== 0) {
      const stderr = decodeText(proc.stderr).trim()
      throw new Error(stderr || `launchctl exited with ${proc.exitCode}`)
    }

    return {
      ok: true,
      sourceCheck,
    }
  }).pipe(
    Effect.mapError((e) => new Error(`Failed to restart worker: ${e}`))
  )

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

const UUID_LIKE_FUNCTION_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const activeRunsSnapshot = (inngestClient: any) =>
  Effect.gen(function* () {
    const [running, queued] = yield* Effect.all([
      inngestClient.runs({ count: 25, status: "RUNNING", hours: 2 }),
      inngestClient.runs({ count: 25, status: "QUEUED", hours: 2 }),
    ])

    return [...running, ...queued]
      .filter((run: any) => run.status === "RUNNING" || run.status === "QUEUED")
      .map((run: any) => ({
        id: String(run.id ?? ""),
        status: String(run.status ?? "UNKNOWN"),
        functionName: String(run.functionName ?? run.functionID ?? "unknown"),
      }))
      .filter((run) => !UUID_LIKE_FUNCTION_NAME.test(run.functionName))
  })

const workerDiagnostics = (body: unknown) => {
  const data = (body ?? {}) as WorkerApiBody
  const worker = data.worker ?? {}
  const runtime = data.runtime ?? {}
  const runtimeCwd = typeof runtime.cwd === "string" ? runtime.cwd : null
  const runtimeLegacyCloneDetected = runtime.legacyCloneDetected === true
    || (runtimeCwd?.includes(LEGACY_WORKER_PATH_FRAGMENT) ?? false)

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
    runtime: {
      cwd: runtimeCwd,
      deploymentModel: typeof runtime.deploymentModel === "string" ? runtime.deploymentModel : null,
      legacyCloneDetected: runtimeLegacyCloneDetected,
    },
  }
}

function isMemoryFunctionName(value: unknown): boolean {
  if (typeof value !== "string") return false
  return /(memory|observe|reflect|proposal|batch|promote|echo|nightly)/iu.test(value)
}

function isTypesenseUnreachableMessage(message: string): boolean {
  return /ECONNREFUSED|Connection refused|TYPESENSE_UNREACHABLE|fetch failed/iu.test(message)
}

function toMapPayload(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "--data must decode to a JSON object" }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: `Invalid JSON in --data: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function invokeFunctionBySlug(functionSlug: string, data: Record<string, unknown>): Promise<{ accepted: boolean; raw: unknown }> {
  const query = `mutation InvokeFunction($slug: String!, $data: Map) { invokeFunction(functionSlug: $slug, data: $data) }`
  const resp = await fetch(`${cfg.inngestUrl}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: {
        slug: functionSlug,
        data,
      },
    }),
  })

  if (!resp.ok) {
    throw new Error(`Inngest GQL invoke failed (${resp.status})`)
  }

  const body = await resp.json() as {
    data?: { invokeFunction?: boolean }
    errors?: Array<{ message?: string }>
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(body.errors[0]?.message ?? "Inngest GQL invoke returned errors")
  }

  return {
    accepted: body.data?.invokeFunction === true,
    raw: body,
  }
}

async function appUrlForFunctionSlug(functionSlug: string): Promise<string | null> {
  const query = `{
    apps {
      name
      url
      functions { slug }
    }
  }`

  const resp = await fetch(`${cfg.inngestUrl}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })

  if (!resp.ok) return null

  const body = await resp.json() as {
    data?: {
      apps?: Array<{
        name?: string
        url?: string
        functions?: Array<{ slug?: string }>
      }>
    }
  }

  for (const app of body.data?.apps ?? []) {
    const hasFunction = (app.functions ?? []).some((fn) => fn.slug === functionSlug)
    if (hasFunction && typeof app.url === "string" && app.url.trim().length > 0) {
      return app.url
    }
  }

  return null
}

function hasSdkUrlError(runDetail: unknown): boolean {
  return /Unable to reach SDK URL/iu.test(JSON.stringify(runDetail ?? {}))
}

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"])

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
          runtime: {
            cwd: null,
            deploymentModel: null,
            legacyCloneDetected: false,
          },
          error: worker.left.message,
        }

    const ok = Object.values(checks).every((c) => c.ok)

    yield* Console.log(respond("inngest status", {
      checks,
      registeredFunctionCount: functions.length,
      worker: workerInfo,
    }, [
      { command: "joelclaw inngest source", description: "Verify single-source worker binding" },
      { command: "joelclaw inngest register", description: "Register functions from worker" },
      { command: "joelclaw inngest restart-worker", description: "Restart system-bus worker" },
      { command: "joelclaw refresh", description: "Full delete + re-register reconciliation" },
    ], ok))
  })
)

const inngestSourceCmd = Command.make(
  "source",
  {
    repair: Options.boolean("repair").pipe(
      Options.withDefault(false),
      Options.withDescription("Repair launchd binding to monorepo single-source path when drift is detected")
    ),
  },
  ({ repair }) =>
    Effect.gen(function* () {
      const beforeResult = yield* inspectWorkerLaunchdBinding().pipe(Effect.either)

      if (beforeResult._tag === "Left" && !repair) {
        yield* Console.log(respondError(
          "inngest source",
          beforeResult.left.message,
          "WORKER_SOURCE_UNKNOWN",
          "Run `joelclaw inngest source --repair` to re-install launchd worker binding",
          [
            { command: "joelclaw inngest source --repair", description: "Repair launchd binding to monorepo source" },
            { command: "joelclaw inngest workers", description: "Inspect runtime worker diagnostics" },
          ],
        ))
        return
      }

      const before = beforeResult._tag === "Right" ? beforeResult.right : null
      const beforeEvaluation = before ? evaluateWorkerSource(before) : null

      let repaired = false
      let repairResult: unknown = null
      let after = before

      if ((!beforeEvaluation || !beforeEvaluation.compliant) && repair) {
        repairResult = yield* repairWorkerLaunchdBinding().pipe(Effect.either)
        if ((repairResult as any)?._tag === "Left") {
          yield* Console.log(respondError(
            "inngest source",
            (repairResult as any).left?.message ?? "Failed to repair worker launchd binding",
            "WORKER_SOURCE_REPAIR_FAILED",
            "Check launchctl permissions and retry",
            [
              { command: "joelclaw inngest source --repair", description: "Retry launchd binding repair" },
              { command: `launchctl print gui/$(id -u)/${WORKER_LABEL}`, description: "Inspect current worker launchd binding" },
            ],
          ))
          return
        }

        repaired = true
        const afterResult = yield* inspectWorkerLaunchdBinding().pipe(Effect.either)
        if (afterResult._tag === "Left") {
          yield* Console.log(respondError(
            "inngest source",
            afterResult.left.message,
            "WORKER_SOURCE_UNKNOWN",
            "Launchd repair completed but binding is still unreadable; inspect launchctl state",
            [
              { command: `launchctl print gui/$(id -u)/${WORKER_LABEL}`, description: "Inspect launchd state" },
            ],
          ))
          return
        }
        after = afterResult.right
      }

      if (!after) {
        yield* Console.log(respondError(
          "inngest source",
          "Worker launchd binding unavailable",
          "WORKER_SOURCE_UNKNOWN",
          "Repair launchd binding to the monorepo source",
          [
            { command: "joelclaw inngest source --repair", description: "Repair launchd binding" },
          ],
        ))
        return
      }

      const evaluation = evaluateWorkerSource(after)
      const ok = evaluation.compliant

      if (!ok) {
        yield* Console.log(respondError(
          "inngest source",
          "Worker launchd binding is not ADR-0089 compliant",
          "WORKER_SOURCE_DRIFT",
          "Run `joelclaw inngest source --repair` to force monorepo single-source binding",
          [
            { command: "joelclaw inngest source --repair", description: "Repair launchd binding" },
            { command: "joelclaw inngest restart-worker --register", description: "Restart worker after repair" },
          ],
        ))
        return
      }

      yield* Console.log(respond("inngest source", {
        adr: "0089-single-source-inngest-worker-deployment",
        compliant: true,
        repaired,
        expected: {
          program: WORKER_EXPECTED_BINDING.program,
          workingDirectory: WORKER_EXPECTED_BINDING.workingDirectory,
          plistSource: WORKER_EXPECTED_BINDING.plistSource,
          plistTarget: WORKER_EXPECTED_BINDING.plistTarget,
        },
        launchd: {
          before,
          after,
          evaluation,
        },
        repairResult,
      }, [
        { command: "joelclaw inngest workers", description: "Verify runtime worker diagnostics" },
        { command: "joelclaw inngest restart-worker --register", description: "Restart + register worker after source verification" },
      ], true))
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
    force: Options.boolean("force").pipe(
      Options.withDefault(false),
      Options.withDescription("Restart even when RUNNING/QUEUED runs exist")
    ),
  },
  ({ register, waitMs, force }) =>
    Effect.gen(function* () {
      const sourceCheck = yield* ensureSingleSourceWorkerBinding(true)
      const inngestClient = yield* Inngest
      const activeRuns = yield* activeRunsSnapshot(inngestClient)
      const hasActiveRuns = activeRuns.length > 0

      if (!force && hasActiveRuns) {
        let reg: unknown = null
        if (register) {
          reg = yield* registerWorkerFunctions().pipe(Effect.either)
        }

        const probe = yield* workerProbe().pipe(Effect.either)
        const probeOk = probe._tag === "Right" ? probe.right.ok : false
        const regOk = !register || (reg as any)?._tag === "Right"

        yield* Console.log(respond("inngest restart-worker", {
          restarted: false,
          skippedDueToActiveRuns: true,
          activeRunCount: activeRuns.length,
          activeRuns: activeRuns.slice(0, 5),
          autoRegister: register,
          registerResult: reg,
          workerProbe: probe,
          sourceCheck,
        }, [
          { command: "joelclaw runs --status RUNNING --count 10", description: "Inspect active runs before forcing restart" },
          { command: "joelclaw inngest restart-worker --force", description: "Force restart anyway (disruptive)" },
        ], probeOk && regOk))
        return
      }

      const restartResult = yield* restartWorker({ enforceSingleSource: false })

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
        forced: force,
        autoRegister: register,
        registerResult: reg,
        workerProbe: probe,
        sourceCheck: restartResult.sourceCheck ?? sourceCheck,
      }, [
        { command: "joelclaw inngest status", description: "Confirm steady state" },
        { command: "joelclaw logs errors -n 80", description: "Inspect worker stderr if needed" },
      ], probeOk && regOk))
    })
)

const inngestSyncWorkerCmd = Command.make(
  "sync-worker",
  {
    restart: Options.boolean("restart").pipe(
      Options.withDefault(false),
      Options.withDescription("Restart worker before registration (default: false)")
    ),
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(1500),
      Options.withDescription("Wait between restart/register/probe checks (default: 1500ms)")
    ),
    force: Options.boolean("force").pipe(
      Options.withDefault(false),
      Options.withDescription("Allow restart even when RUNNING/QUEUED runs exist")
    ),
  },
  ({ restart, waitMs, force }) =>
    Effect.gen(function* () {
      const sourceCheck = yield* ensureSingleSourceWorkerBinding(true)
      let restarted = false
      let restartSkippedDueToActiveRuns = false
      let activeRuns: Array<{ id: string; status: string; functionName: string }> = []

      if (restart) {
        const inngestClient = yield* Inngest
        activeRuns = yield* activeRunsSnapshot(inngestClient)

        if (!force && activeRuns.length > 0) {
          restartSkippedDueToActiveRuns = true
        } else {
          yield* restartWorker({ enforceSingleSource: false })
          restarted = true
          if (waitMs > 0) {
            yield* sleepMs(waitMs)
          }
        }
      }

      const registerResult = yield* registerWorkerFunctions().pipe(Effect.either)
      if (waitMs > 0) {
        yield* sleepMs(Math.max(500, Math.floor(waitMs / 2)))
      }

      const probe = yield* workerProbe().pipe(Effect.either)
      const regOk = registerResult._tag === "Right" && registerResult.right.ok
      const probeOk = probe._tag === "Right" ? probe.right.ok : false

      yield* Console.log(respond("inngest sync-worker", {
        mode: "single-source",
        note: "No file copy occurs; this command only enforces launchd source + register/probe",
        restarted,
        restartSkippedDueToActiveRuns,
        forced: force,
        activeRunCount: activeRuns.length,
        activeRuns: restartSkippedDueToActiveRuns ? activeRuns.slice(0, 5) : [],
        registerResult,
        workerProbe: probe,
        sourceCheck,
      }, [
        { command: "joelclaw inngest status", description: "Confirm worker + registration health" },
        { command: "joelclaw functions", description: "List currently registered functions" },
        { command: "joelclaw inngest sync-worker --restart --force", description: "Force restart despite active runs (disruptive)" },
      ], regOk && probeOk))
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

const invokeFunctionSlugArg = Args.text({ name: "function-slug" }).pipe(
  Args.withDescription("Function slug, id, or name")
)

const inngestInvokeCmd = Command.make(
  "invoke",
  {
    functionSlug: invokeFunctionSlugArg,
    data: Options.text("data").pipe(
      Options.withDefault("{}"),
      Options.withDescription("JSON object payload for invokeFunction data (default: {})")
    ),
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(30_000),
      Options.withDescription("Max wait for terminal run status (default: 30000)")
    ),
    pollMs: Options.integer("poll-ms").pipe(
      Options.withDefault(1000),
      Options.withDescription("Polling interval while waiting for run completion (default: 1000)")
    ),
    mode: Options.text("mode").pipe(
      Options.withDefault("auto"),
      Options.withDescription("Dispatch mode: auto|event|invoke (default: auto)")
    ),
    healSdk: Options.boolean("heal-sdk").pipe(
      Options.withDefault(true),
      Options.withDescription("Retry once after SDK reachability healing when run shows 'Unable to reach SDK URL' (default: true)")
    ),
    restartOnHeal: Options.boolean("restart-on-heal").pipe(
      Options.withDefault(true),
      Options.withDescription("Restart + register worker before retry when heal-sdk is enabled (default: true)")
    ),
  },
  ({ functionSlug, data, waitMs, pollMs, mode, healSdk, restartOnHeal }) =>
    Effect.gen(function* () {
      const parsedData = toMapPayload(data)
      if (!parsedData.ok) {
        yield* Console.log(respondError(
          "inngest invoke",
          parsedData.error,
          "INVALID_JSON",
          "Pass --data as a valid JSON object",
          [
            {
              command: "joelclaw inngest invoke <function-slug> [--data <data>]",
              description: "Retry with valid JSON payload",
              params: {
                "function-slug": { description: "Function slug/id/name", value: functionSlug, required: true },
                data: { description: "JSON object", value: "{}", default: "{}" },
              },
            },
          ],
        ))
        return
      }

      const safeWaitMs = Math.max(2_000, waitMs)
      const safePollMs = Math.max(250, pollMs)
      const maxAttempts = healSdk ? 2 : 1

      const inngestClient = yield* Inngest
      const functions = yield* inngestClient.functions()
      const target = functions.find((fn) =>
        fn.slug === functionSlug
        || fn.id === functionSlug
        || fn.name.toLowerCase() === functionSlug.toLowerCase()
      )

      if (!target) {
        yield* Console.log(respondError(
          "inngest invoke",
          `Function not found: ${functionSlug}`,
          "FUNCTION_NOT_FOUND",
          "Use `joelclaw functions` and pass a valid function slug/id/name",
          [
            { command: "joelclaw functions", description: "List available function slugs" },
            {
              command: "joelclaw inngest invoke <function-slug> [--data <data>]",
              description: "Retry with valid function slug",
              params: {
                "function-slug": { description: "Function slug/id/name", required: true },
                data: { description: "JSON object", value: data, default: "{}" },
              },
            },
          ],
        ))
        return
      }

      const normalizedMode = mode.trim().toLowerCase()
      if (normalizedMode !== "auto" && normalizedMode !== "event" && normalizedMode !== "invoke") {
        yield* Console.log(respondError(
          "inngest invoke",
          `Invalid mode: ${mode}`,
          "INVALID_MODE",
          "Use --mode auto|event|invoke",
          [
            {
              command: "joelclaw inngest invoke <function-slug> [--mode <mode>]",
              description: "Retry with supported mode",
              params: {
                "function-slug": { description: "Function slug/id/name", value: functionSlug, required: true },
                mode: { description: "Dispatch mode", value: "auto", enum: ["auto", "event", "invoke"] },
              },
            },
          ],
        ))
        return
      }

      const eventTrigger = target.triggers.find((trigger) =>
        trigger.type === "EVENT" && typeof trigger.value === "string"
      )

      const dispatchMode = normalizedMode === "auto"
        ? (eventTrigger ? "event" : "invoke")
        : normalizedMode

      if (dispatchMode === "event" && !eventTrigger) {
        yield* Console.log(respondError(
          "inngest invoke",
          `Function ${target.slug} has no EVENT trigger`,
          "EVENT_TRIGGER_MISSING",
          "Use --mode invoke for cron-only functions",
          [
            {
              command: "joelclaw inngest invoke <function-slug> [--mode <mode>]",
              description: "Retry with invoke mode",
              params: {
                "function-slug": { description: "Function slug/id/name", value: target.slug, required: true },
                mode: { description: "Dispatch mode", value: "invoke", enum: ["auto", "event", "invoke"] },
              },
            },
            { command: "joelclaw functions", description: "Inspect function triggers" },
          ],
        ))
        return
      }

      const appUrl = yield* Effect.tryPromise({
        try: () => appUrlForFunctionSlug(target.slug),
        catch: () => null,
      })

      const attempts: Array<Record<string, unknown>> = []
      let finalRunId: string | null = null
      let finalStatus: string | null = null
      let finalRunDetail: Record<string, unknown> | null = null
      let sdkUrlError = false

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = Date.now()

        const dispatch = dispatchMode === "event"
          ? yield* Effect.gen(function* () {
              const triggerEvent = eventTrigger!.value
              const sendResult = yield* inngestClient.send(triggerEvent, parsedData.value)
              const eventIds = Array.isArray((sendResult as any)?.ids)
                ? (sendResult as any).ids.filter((value: unknown) => typeof value === "string")
                : []

              return {
                mode: "event",
                accepted: eventIds.length > 0,
                triggerEvent,
                raw: sendResult,
                eventIds,
              }
            })
          : yield* Effect.tryPromise({
              try: () => invokeFunctionBySlug(target.slug, parsedData.value),
              catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
            }).pipe(
              Effect.map((invoke) => ({
                mode: "invoke",
                accepted: invoke.accepted,
                triggerEvent: null,
                raw: invoke.raw,
                eventIds: [],
              }))
            )

        if (!dispatch.accepted) {
          throw new Error(`Dispatch not accepted in ${dispatch.mode} mode`)
        }

        let matchedRun: { id: string; status: string; startedAt: string; functionID: string } | null = null
        const deadline = Date.now() + safeWaitMs

        while (Date.now() <= deadline) {
          const recentRuns = yield* inngestClient.runs({ count: 120, hours: 2 })
          matchedRun = recentRuns
            .filter((run) =>
              String(run.functionID) === target.id
              && Date.parse(String(run.startedAt ?? "")) >= startedAt
            )
            .sort((a, b) => Date.parse(String(b.startedAt ?? "")) - Date.parse(String(a.startedAt ?? "")))[0] as any ?? null

          if (matchedRun && TERMINAL_RUN_STATUSES.has(String(matchedRun.status))) {
            break
          }

          yield* sleepMs(safePollMs)
        }

        if (!matchedRun) {
          throw new Error(`No run observed for ${target.slug} within ${safeWaitMs}ms`)
        }

        const runDetail = (yield* inngestClient.run(matchedRun.id)) as Record<string, unknown>

        const run = (runDetail.run ?? {}) as Record<string, unknown>
        const status = typeof run.status === "string" ? run.status : String(matchedRun.status)
        const runErrors = runDetail.errors
        const hasSdkError = hasSdkUrlError(runErrors)

        const summary: Record<string, unknown> = {
          attempt,
          dispatchMode: dispatch.mode,
          triggerEvent: dispatch.triggerEvent,
          eventIds: dispatch.eventIds,
          accepted: dispatch.accepted,
          runId: matchedRun.id,
          status,
          sdkUrlError: hasSdkError,
        }

        if (hasSdkError && attempt < maxAttempts) {
          const heal: Record<string, unknown> = {
            restartOnHeal,
            restarted: false,
            registerResult: null,
          }

          if (restartOnHeal) {
            yield* restartWorker()
            heal.restarted = true
            yield* sleepMs(1500)
          }

          heal.registerResult = yield* registerWorkerFunctions().pipe(Effect.either)
          attempts.push({
            ...summary,
            healed: true,
            heal,
          })
          continue
        }

        attempts.push(summary)
        finalRunId = matchedRun.id
        finalStatus = status
        finalRunDetail = runDetail
        sdkUrlError = hasSdkError
        break
      }

      const ok = finalStatus === "COMPLETED" && !sdkUrlError

      if (!ok) {
        const reason = sdkUrlError
          ? "Invocation reached SDK URL error after retry"
          : `Invocation finished with status ${finalStatus ?? "unknown"}`

        yield* Console.log(respondError(
          "inngest invoke",
          reason,
          sdkUrlError ? "SDK_URL_UNREACHABLE" : "INVOKE_FAILED",
          sdkUrlError
            ? "Run `joelclaw inngest sync-worker --restart` and retry invoke"
            : "Inspect run trace + server logs and retry",
          [
            finalRunId
              ? {
                  command: "joelclaw run <run-id>",
                  description: "Inspect run trace and failed spans",
                  params: { "run-id": { description: "Run ID", value: finalRunId, required: true } },
                }
              : {
                  command: "joelclaw runs --count 10 --hours 1",
                  description: "Find invoke run ID",
                },
            { command: "joelclaw inngest sync-worker --restart", description: "Restart + re-register worker" },
            { command: "joelclaw logs server --lines 120 --grep 'Unable to reach SDK URL'", description: "Check Inngest server SDK reachability errors" },
          ],
        ))
        return
      }

      yield* Console.log(respond("inngest invoke", {
        target: {
          id: target.id,
          slug: target.slug,
          name: target.name,
          appUrl,
        },
        payload: parsedData.value,
        wait: {
          waitMs: safeWaitMs,
          pollMs: safePollMs,
        },
        run: finalRunDetail,
        attempts,
      }, [
        {
          command: "joelclaw run <run-id>",
          description: "Inspect invoked run details",
          params: {
            "run-id": { description: "Run ID", value: finalRunId ?? "", required: true },
          },
        },
        { command: "joelclaw logs server --lines 120 --grep 'Unable to reach SDK URL'", description: "Check SDK reachability noise" },
        { command: "joelclaw inngest status", description: "Verify worker + server health" },
      ], true))
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
    const runtimeSourceCompliant = !diag.runtime.legacyCloneDetected
    const ok = probe.right.ok && !diag.hasDuplicateFunctionIds && runtimeSourceCompliant

    yield* Console.log(respond("inngest workers", {
      reachable: probe.right.ok,
      status: probe.right.status,
      diagnostics: diag,
      checks: {
        duplicateIdsBlocked: diag.duplicateFunctionIds.length === 0,
        runtimeSourceCompliant,
      },
    }, [
      { command: "joelclaw inngest status", description: "Service + registration snapshot" },
      { command: "joelclaw inngest source", description: "Verify/repair ADR-0089 single-source binding" },
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
      let observeStore: {
        stored: boolean
        count: number
        mergedCount: number
        errors: number
        allowCount: number
        holdCount: number
        discardCount: number
        fallbackCount: number
        categorizedCount: number
        uncategorizedCount: number
        categoryBuckets: Array<{ id: string; count: number }>
        categorySourceBuckets: Array<{ source: string; count: number }>
        taxonomyVersions: string[]
        error?: string
      } | null = null
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
                  allowCount: Number(typesense.allowCount ?? 0) || 0,
                  holdCount: Number(typesense.holdCount ?? 0) || 0,
                  discardCount: Number(typesense.discardCount ?? 0) || 0,
                  fallbackCount: Number(typesense.fallbackCount ?? 0) || 0,
                  categorizedCount: Number(typesense.categorizedCount ?? 0) || 0,
                  uncategorizedCount: Number(typesense.uncategorizedCount ?? 0) || 0,
                  categoryBuckets: Array.isArray(typesense.categoryBuckets)
                    ? typesense.categoryBuckets
                      .map((value: unknown) => {
                        if (!value || typeof value !== "object") return null
                        const id = typeof (value as Record<string, unknown>).id === "string"
                          ? (value as Record<string, unknown>).id
                          : ""
                        const count = Number((value as Record<string, unknown>).count ?? 0) || 0
                        return id.length > 0 ? { id, count } : null
                      })
                      .filter((value): value is { id: string; count: number } => value != null)
                    : [],
                  categorySourceBuckets: Array.isArray(typesense.categorySourceBuckets)
                    ? typesense.categorySourceBuckets
                      .map((value: unknown) => {
                        if (!value || typeof value !== "object") return null
                        const source = typeof (value as Record<string, unknown>).source === "string"
                          ? (value as Record<string, unknown>).source
                          : ""
                        const count = Number((value as Record<string, unknown>).count ?? 0) || 0
                        return source.length > 0 ? { source, count } : null
                      })
                      .filter((value): value is { source: string; count: number } => value != null)
                    : [],
                  taxonomyVersions: Array.isArray(typesense.taxonomyVersions)
                    ? typesense.taxonomyVersions.filter((value: unknown): value is string => typeof value === "string")
                    : [],
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

        const invoke = yield* Effect.tryPromise({
          try: () => invokeFunctionBySlug(weeklyFunction.slug, {
            reason: "manual weekly memory governance check",
            requestedBy: "joelclaw inngest memory-weekly",
          }),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        })
        const invoked = invoke.accepted
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
    minCategoryCoverage: Options.float("min-category-coverage").pipe(
      Options.withDefault(0.95),
      Options.withDescription("Pass threshold for category_id coverage ratio (default: 0.95)")
    ),
    minCategoryHighConfidence: Options.float("min-category-high-confidence").pipe(
      Options.withDefault(0.6),
      Options.withDescription("Pass threshold for high-confidence category ratio (default: 0.6)")
    ),
    maxWriteGateFallbackRate: Options.float("max-write-gate-fallback-rate").pipe(
      Options.withDefault(0.2),
      Options.withDescription("Fail threshold for write gate fallback rate (default: 0.2)")
    ),
    maxWriteGateDiscardRatio: Options.float("max-write-gate-discard-ratio").pipe(
      Options.withDefault(0.6),
      Options.withDescription("Fail threshold for discard ratio among verdicted observations (default: 0.6)")
    ),
  },
  ({
    hours,
    stallMinutes,
    maxErrorRate,
    maxFailedRuns,
    maxBacklog,
    maxStaleRatio,
    minCategoryCoverage,
    minCategoryHighConfidence,
    maxWriteGateFallbackRate,
    maxWriteGateDiscardRatio,
  }) =>
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

      const categoryCoverageState = yield* Effect.tryPromise(() =>
        typesenseFacetCounts(apiKey, "memory_observations", "observation", "category_id")
          .then((buckets) => {
            const categorizedCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
            const uncategorizedCount = Math.max(0, memoryCount - categorizedCount)
            const coverageRatio = memoryCount > 0 ? categorizedCount / memoryCount : 0
            return {
              supported: true,
              reason: null as string | null,
              buckets,
              categorizedCount,
              uncategorizedCount,
              coverageRatio,
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            if (/facet|category_id/iu.test(message)) {
              return {
                supported: false,
                reason: "category_id facet missing in Typesense schema",
                buckets: [] as Array<{ value: string; count: number }>,
                categorizedCount: 0,
                uncategorizedCount: memoryCount,
                coverageRatio: 0,
              }
            }
            throw error
          })
      )

      const categoryConfidenceState = yield* Effect.tryPromise(() =>
        Promise.all([
          typesenseCount(apiKey, "memory_observations", "observation", "category_confidence:>=0.8"),
          typesenseCount(apiKey, "memory_observations", "observation", "category_confidence:>=0.6 && category_confidence:<0.8"),
          typesenseCount(apiKey, "memory_observations", "observation", "category_confidence:<0.6"),
        ])
          .then(([high, medium, low]) => {
            const knownCount = high + medium + low
            return {
              supported: true,
              reason: null as string | null,
              knownCount,
              high,
              medium,
              low,
              highRatio: knownCount > 0 ? high / knownCount : 0,
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            if (/filter field named `category_confidence`/iu.test(message)) {
              return {
                supported: false,
                reason: "category_confidence field missing in Typesense schema",
                knownCount: 0,
                high: 0,
                medium: 0,
                low: 0,
                highRatio: 0,
              }
            }
            throw error
          })
      )

      const writeGateState = yield* Effect.tryPromise(() =>
        Promise.all([
          typesenseCount(apiKey, "memory_observations", "observation", "write_verdict:=allow"),
          typesenseCount(apiKey, "memory_observations", "observation", "write_verdict:=hold"),
          typesenseCount(apiKey, "memory_observations", "observation", "write_verdict:=discard"),
          typesenseCount(apiKey, "memory_observations", "observation", "write_gate_fallback:=true"),
        ])
          .then(([allow, hold, discard, fallback]) => {
            const totalWithVerdict = allow + hold + discard
            return {
              supported: true,
              reason: null as string | null,
              allow,
              hold,
              discard,
              fallback,
              totalWithVerdict,
              holdRatio: totalWithVerdict > 0 ? hold / totalWithVerdict : 0,
              discardRatio: totalWithVerdict > 0 ? discard / totalWithVerdict : 0,
              fallbackRate: totalWithVerdict > 0 ? fallback / totalWithVerdict : 0,
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            if (/filter field named `write_verdict`|filter field named `write_gate_fallback`/iu.test(message)) {
              return {
                supported: false,
                reason: "write gate fields missing in Typesense schema",
                allow: 0,
                hold: 0,
                discard: 0,
                fallback: 0,
                totalWithVerdict: 0,
                holdRatio: 0,
                discardRatio: 0,
                fallbackRate: 0,
              }
            }
            throw error
          })
      )

      const checks = {
        memoryStageStall: minutesSinceSuccess <= safeStallMinutes,
        otelErrorRate: otelTotal >= 20 ? errorRate <= maxErrorRate : true,
        staleRatio: staleState.supported ? (memoryCount >= 25 ? staleRatio <= maxStaleRatio : true) : true,
        categoryCoverage:
          categoryCoverageState.supported
            ? (categoryCoverageState.categorizedCount >= 25
              ? categoryCoverageState.coverageRatio >= minCategoryCoverage
              : true)
            : true,
        categoryConfidence:
          categoryConfidenceState.supported
            ? (categoryConfidenceState.knownCount >= 25
              ? categoryConfidenceState.highRatio >= minCategoryHighConfidence
              : true)
            : true,
        writeGateFallbackRate:
          writeGateState.supported
            ? (writeGateState.totalWithVerdict >= 25
              ? writeGateState.fallbackRate <= maxWriteGateFallbackRate
              : true)
            : true,
        writeGateDiscardRatio:
          writeGateState.supported
            ? (writeGateState.totalWithVerdict >= 25
              ? writeGateState.discardRatio <= maxWriteGateDiscardRatio
              : true)
            : true,
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
            minCategoryCoverage,
            minCategoryHighConfidence,
            maxWriteGateFallbackRate,
            maxWriteGateDiscardRatio,
          },
          memory: {
            count: memoryCount,
            staleCount,
            staleRatio,
            staleMetricSupported: staleState.supported,
            staleMetricReason: staleState.reason,
            categories: {
              supported: categoryCoverageState.supported,
              reason: categoryCoverageState.reason,
              categorizedCount: categoryCoverageState.categorizedCount,
              uncategorizedCount: categoryCoverageState.uncategorizedCount,
              coverageRatio: categoryCoverageState.coverageRatio,
              topCategories: categoryCoverageState.buckets.slice(0, 10),
              confidence: {
                supported: categoryConfidenceState.supported,
                reason: categoryConfidenceState.reason,
                knownCount: categoryConfidenceState.knownCount,
                highCount: categoryConfidenceState.high,
                mediumCount: categoryConfidenceState.medium,
                lowCount: categoryConfidenceState.low,
                highRatio: categoryConfidenceState.highRatio,
              },
            },
            writeGate: {
              supported: writeGateState.supported,
              reason: writeGateState.reason,
              allowCount: writeGateState.allow,
              holdCount: writeGateState.hold,
              discardCount: writeGateState.discard,
              fallbackCount: writeGateState.fallback,
              totalWithVerdict: writeGateState.totalWithVerdict,
              holdRatio: writeGateState.holdRatio,
              discardRatio: writeGateState.discardRatio,
              fallbackRate: writeGateState.fallbackRate,
            },
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
      source: "joelclaw inngest source [--repair]",
      invoke: "joelclaw inngest invoke <function-slug> [--mode auto|event|invoke] [--data '{}'] [--wait-ms 30000]",
      register: "joelclaw inngest register [--wait-ms 1200]", 
      "restart-worker": "joelclaw inngest restart-worker [--register] [--wait-ms 1500] [--force]",
      "sync-worker": "joelclaw inngest sync-worker [--restart] [--wait-ms 1500] [--force] (single-source; no file copy)",
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
    { command: "joelclaw inngest source", description: "Verify ADR-0089 single-source launchd binding" },
    { command: "joelclaw inngest invoke <function-slug> --data '{}'", description: "Invoke one function and wait for terminal status" },
    { command: "joelclaw inngest register", description: "Register functions from worker" },
    { command: "joelclaw inngest restart-worker --register", description: "Restart worker and register functions" },
    { command: "joelclaw inngest sync-worker --restart", description: "Compatibility alias: restart then register worker (no file sync)" },
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
    inngestSourceCmd,
    inngestInvokeCmd,
    inngestRegisterCmd,
    inngestRestartWorkerCmd,
    inngestSyncWorkerCmd,
    inngestReconcileCmd,
    inngestMemoryE2ECmd,
    inngestMemoryWeeklyCmd,
    inngestMemoryGateCmd,
    inngestMemorySchemaReconcileCmd,
    inngestMemoryHealthCmd,
  ])
)
