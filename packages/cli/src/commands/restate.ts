import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { Args, Command, Options } from "@effect/cli"
import {
  RESTATE_CRON_PIPELINES,
  RESTATE_TIER1_PIPELINE_KEYS,
  type RestateCronPipelineDefinition,
} from "@joelclaw/restate/pipelines"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

type KubectlResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

const decode = (value: string | Uint8Array | null | undefined): string => {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

const runKubectl = (args: string[]): KubectlResult => {
  const proc = Bun.spawnSync(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" })
  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout).trim(),
    stderr: decode(proc.stderr).trim(),
  }
}

const parseJson = <T = Record<string, unknown>>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const normalizeHostport = (urlOrHostport: string): string => {
  const trimmed = urlOrHostport.trim()
  return trimmed.replace(/^https?:\/\//, "")
}

const resolveSmokeScriptPath = (script: string): string => {
  if (path.isAbsolute(script)) return script

  const cwdCandidate = path.resolve(process.cwd(), script)
  if (existsSync(cwdCandidate)) return cwdCandidate

  const repoCandidates = [
    process.env.JOELCLAW_ROOT?.trim(),
    process.env.HOME ? path.join(process.env.HOME, "Code", "joelhooks", "joelclaw") : undefined,
  ].filter((value): value is string => Boolean(value))

  for (const repoRoot of repoCandidates) {
    const candidate = path.join(repoRoot, script)
    if (existsSync(candidate)) return candidate
  }

  return cwdCandidate
}

const stripTrailingSlash = (value: string): string => value.replace(/\/$/, "")

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port")))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })

type DkronAccessMode = "direct" | "tunnel"

type DkronSession = {
  baseUrl: string
  accessMode: DkronAccessMode
  localPort?: number
  logPath?: string
  dispose: () => Promise<void>
}

const startDkronTunnel = async (
  namespace: string,
  serviceName: string,
  remotePort = 8080,
): Promise<DkronSession> => {
  const localPort = await findFreePort()
  const logPath = `/tmp/joelclaw-dkron-port-forward-${Date.now()}-${localPort}.log`

  const launch = Bun.spawnSync([
    "bash",
    "-lc",
    `kubectl -n ${shellEscape(namespace)} port-forward svc/${serviceName} ${localPort}:${remotePort} > ${shellEscape(logPath)} 2>&1 & echo $!`,
  ], { stdout: "pipe", stderr: "pipe" })

  const pid = Number.parseInt(decode(launch.stdout).trim(), 10)
  if (launch.exitCode !== 0 || !Number.isFinite(pid)) {
    const detail = decode(launch.stderr).trim() || decode(launch.stdout).trim()
    throw new Error(detail || "Failed to start temporary Dkron tunnel")
  }

  const baseUrl = `http://127.0.0.1:${localPort}`

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        return {
          baseUrl,
          accessMode: "tunnel",
          localPort,
          logPath,
          dispose: async () => {
            Bun.spawnSync(["bash", "-lc", `kill ${pid} >/dev/null 2>&1 || true`], { stdout: "ignore", stderr: "ignore" })
            await sleep(50)
            Bun.spawnSync(["bash", "-lc", `rm -f ${shellEscape(logPath)}`], { stdout: "ignore", stderr: "ignore" })
          },
        }
      }
    } catch {
      // tunnel not ready yet
    }
    await sleep(250)
  }

  const logDetail = decode(Bun.spawnSync(["bash", "-lc", `cat ${shellEscape(logPath)} 2>/dev/null || true`], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout).trim()

  Bun.spawnSync(["bash", "-lc", `kill ${pid} >/dev/null 2>&1 || true`], { stdout: "ignore", stderr: "ignore" })
  Bun.spawnSync(["bash", "-lc", `rm -f ${shellEscape(logPath)}`], { stdout: "ignore", stderr: "ignore" })

  throw new Error(logDetail || "Temporary Dkron tunnel never became ready")
}

const openDkronSession = async (
  namespace: string,
  serviceName: string,
  baseUrl?: string,
): Promise<DkronSession> => {
  if (baseUrl?.trim()) {
    return {
      baseUrl: stripTrailingSlash(baseUrl.trim()),
      accessMode: "direct",
      dispose: async () => {},
    }
  }

  return startDkronTunnel(namespace, serviceName)
}

type JsonHttpResult = {
  ok: boolean
  status: number
  text: string
  json: any
}

const fetchJson = async (
  baseUrl: string,
  pathname: string,
  init?: RequestInit,
): Promise<JsonHttpResult> => {
  const response = await fetch(`${stripTrailingSlash(baseUrl)}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(5_000),
  })

  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    text,
    json: parseJson(text),
  }
}

const upsertDkronJob = async (
  session: DkronSession,
  job: DkronJobPayload,
  runNow = false,
) => {
  const upsert = await fetchJson(session.baseUrl, `/v1/jobs/${job.name}`, {
    method: "PUT",
    body: JSON.stringify(job),
  })
  if (!upsert.ok) {
    throw new Error(upsert.text || `Dkron returned ${upsert.status}`)
  }

  let runResult: JsonHttpResult | null = null
  if (runNow) {
    runResult = await fetchJson(session.baseUrl, `/v1/jobs/${job.name}/run`, { method: "POST" })
    if (!runResult.ok) {
      throw new Error(runResult.text || `Dkron returned ${runResult.status} when starting ${job.name}`)
    }
  }

  return {
    job: upsert.json ?? job,
    runTriggered: runNow,
    runResponse: runResult?.json ?? runResult?.text ?? null,
  }
}

type DkronJobPayload = {
  name: string
  displayname: string
  schedule: string
  timezone: string
  retries: number
  disabled: boolean
  concurrency: string
  executor: string
  executor_config: {
    shell: string
    command: string
    timeout: string
  }
  metadata: Record<string, string>
}

const buildDagJob = (
  definition: RestateCronPipelineDefinition,
  options: {
    schedule?: string
    timezone?: string
    restateUrl: string
    workflowIdPrefix?: string
  }
): DkronJobPayload => {
  const schedule = options.schedule ?? definition.schedule
  const timezone = options.timezone ?? definition.timezone
  const workflowIdPrefix = options.workflowIdPrefix ?? definition.workflowIdPrefix
  const normalizedRestateUrl = stripTrailingSlash(options.restateUrl)
  const payload = JSON.stringify(definition.buildRequest())
  const command = [
    `WORKFLOW_ID=\"${workflowIdPrefix}-$(date +%s)\"`,
    `wget -qO- --header='Content-Type: application/json' --post-data=${shellEscape(payload)} \"${normalizedRestateUrl}/dagOrchestrator/$WORKFLOW_ID/run/send\"`,
  ].join(" && ")

  return {
    name: definition.jobName,
    displayname: definition.displayName,
    schedule,
    timezone,
    retries: 3,
    disabled: false,
    concurrency: "forbid",
    executor: "shell",
    executor_config: {
      shell: "true",
      command,
      timeout: "120s",
    },
    metadata: {
      runtime: "restate",
      scheduler: "dkron",
      pipeline: definition.pipeline,
      adr: "0216",
      phase: "phase-1",
      migrated_from: definition.migratedFrom,
      workflow_id_prefix: workflowIdPrefix,
    },
  }
}

const buildHealthJob = (
  schedule: string,
  timezone: string,
  restateUrl: string,
  workflowIdPrefix: string,
) => buildDagJob(RESTATE_CRON_PIPELINES.health, {
  schedule,
  timezone,
  restateUrl,
  workflowIdPrefix,
})

const restateStatusCmd = Command.make(
  "status",
  {
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for Restate runtime")
    ),
    adminUrl: Options.text("admin-url").pipe(
      Options.withDefault(process.env.RESTATE_ADMIN_URL?.trim() || "http://localhost:9070"),
      Options.withDescription("Restate admin endpoint URL")
    ),
  },
  ({ namespace, adminUrl }) =>
    Effect.gen(function* () {
      const stsRes = runKubectl(["-n", namespace, "get", "statefulset", "restate", "-o", "json"])
      const svcRes = runKubectl(["-n", namespace, "get", "service", "restate", "-o", "json"])

      const sts = parseJson<Record<string, any>>(stsRes.stdout)
      const svc = parseJson<Record<string, any>>(svcRes.stdout)

      const desired = Number(sts?.spec?.replicas ?? 0)
      const ready = Number(sts?.status?.readyReplicas ?? 0)

      const adminProbe = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${adminUrl.replace(/\/$/, "")}/health`, {
            signal: AbortSignal.timeout(3000),
          })
          const body = await response.text()
          return {
            ok: response.ok,
            status: response.status,
            body: body.slice(0, 300),
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            status: 0,
            body: error.message,
          })
        )
      )

      const allOk = stsRes.ok && svcRes.ok && desired > 0 && ready >= desired

      yield* Console.log(respond("restate status", {
        namespace,
        statefulset: {
          exists: stsRes.ok,
          desiredReplicas: desired,
          readyReplicas: ready,
          phase: ready >= desired && desired > 0 ? "ready" : "degraded",
          error: stsRes.ok ? null : stsRes.stderr || stsRes.stdout,
        },
        service: {
          exists: svcRes.ok,
          type: svc?.spec?.type ?? null,
          ports: Array.isArray(svc?.spec?.ports)
            ? svc.spec.ports.map((port: any) => ({
              name: port?.name,
              port: port?.port,
              targetPort: port?.targetPort,
            }))
            : [],
          error: svcRes.ok ? null : svcRes.stderr || svcRes.stdout,
        },
        admin: {
          url: adminUrl,
          healthy: adminProbe.ok,
          status: adminProbe.status,
          response: adminProbe.body,
        },
      }, [
        {
          command: "joelclaw restate status --admin-url http://localhost:9070",
          description: "Re-check runtime and admin endpoint health",
        },
        {
          command: "joelclaw restate deployments --admin-url http://localhost:9070",
          description: "Inspect registered deployments",
        },
        {
          command: "joelclaw logs errors --lines 120",
          description: "Inspect worker/cluster-side errors if state regresses",
        },
      ], allOk))
    })
)

const restateDeploymentsCmd = Command.make(
  "deployments",
  {
    adminUrl: Options.text("admin-url").pipe(
      Options.withDefault(process.env.RESTATE_ADMIN_URL?.trim() || "http://localhost:9070"),
      Options.withDescription("Restate admin endpoint URL")
    ),
    cliBin: Options.text("cli-bin").pipe(
      Options.withDefault(process.env.RESTATE_CLI_BIN?.trim() || "restate"),
      Options.withDescription("Restate CLI binary")
    ),
  },
  ({ adminUrl, cliBin }) =>
    Effect.gen(function* () {
      const env = {
        ...process.env,
        RESTATE_HOSTPORT: normalizeHostport(adminUrl),
      }

      const proc = Bun.spawnSync([cliBin, "deployments", "list"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      })

      const stdout = decode(proc.stdout).trim()
      const stderr = decode(proc.stderr).trim()

      if (proc.exitCode !== 0) {
        yield* Console.log(respondError(
          "restate deployments",
          stderr || stdout || `restate CLI exited with ${proc.exitCode}`,
          "RESTATE_DEPLOYMENTS_LIST_FAILED",
          "Install/configure restate CLI and ensure RESTATE_HOSTPORT points to the admin endpoint.",
          [
            {
              command: "joelclaw restate status",
              description: "Check runtime/service health",
            },
            {
              command: "joelclaw restate deployments --admin-url http://localhost:9070",
              description: "Retry deployment listing after registering endpoints",
            },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate deployments", {
        adminUrl,
        cliBin,
        output: stdout,
      }, [
        {
          command: "joelclaw restate status",
          description: "Check runtime health alongside deployment output",
        },
      ]))
    })
)

const restateSmokeCmd = Command.make(
  "smoke",
  {
    script: Options.text("script").pipe(
      Options.withDefault("scripts/restate/test-workflow.sh"),
      Options.withDescription("Smoke test script path")
    ),
  },
  ({ script }) =>
    Effect.gen(function* () {
      const resolvedScript = resolveSmokeScriptPath(script)

      if (!existsSync(resolvedScript)) {
        yield* Console.log(respondError(
          "restate smoke",
          `Smoke script not found: ${resolvedScript}`,
          "RESTATE_SMOKE_SCRIPT_NOT_FOUND",
          "Run from the joelclaw repo root, pass --script with an absolute path, or set JOELCLAW_ROOT.",
          [
            {
              command: "joelclaw restate smoke --script <path>",
              description: "Retry with explicit script path",
            },
            {
              command: "joelclaw restate status",
              description: "Check Restate runtime health",
            },
          ]
        ))
        return
      }

      const proc = Bun.spawnSync(["bash", resolvedScript], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      })

      const stdout = decode(proc.stdout).trim()
      const stderr = decode(proc.stderr).trim()

      if (proc.exitCode !== 0) {
        yield* Console.log(respondError(
          "restate smoke",
          stderr || stdout || `smoke script exited with ${proc.exitCode}`,
          "RESTATE_SMOKE_FAILED",
          "Ensure Restate runtime/deployment endpoint are reachable and deployGate smoke prerequisites are available.",
          [
            {
              command: "joelclaw restate status",
              description: "Check Restate runtime health",
            },
            {
              command: "joelclaw restate deployments",
              description: "Inspect deployment registration",
            },
            {
              command: "joelclaw logs errors --lines 120",
              description: "Check worker/cluster errors",
            },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate smoke", {
        script: resolvedScript,
        passed: true,
        output: stdout,
      }, [
        {
          command: "joelclaw restate deployments",
          description: "Inspect deployment list after smoke run",
        },
      ]))
    })
)

const resolveRepoFile = (relPath: string): string | null => {
  const candidates = [
    process.env.JOELCLAW_ROOT?.trim(),
    process.env.HOME ? path.join(process.env.HOME, "Code", "joelhooks", "joelclaw") : undefined,
  ].filter((value): value is string => Boolean(value))

  for (const root of candidates) {
    const candidate = path.join(root, relPath)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const restateEnrichCmd = Command.make(
  "enrich",
  {
    name: Args.text({ name: "name" }).pipe(
      Args.withDescription("Contact name to enrich (e.g. \"Kent C. Dodds\")")
    ),
    github: Options.text("github").pipe(
      Options.withDescription("GitHub username hint"),
      Options.optional,
    ),
    twitter: Options.text("twitter").pipe(
      Options.withDescription("Twitter/X username hint"),
      Options.optional,
    ),
    email: Options.text("email").pipe(
      Options.withDescription("Email address hint"),
      Options.optional,
    ),
    website: Options.text("website").pipe(
      Options.withDescription("Website URL hint"),
      Options.optional,
    ),
    depth: Options.choice("depth", ["quick", "full"]).pipe(
      Options.withDefault("full"),
      Options.withDescription("Enrichment depth: quick (3 sources) or full (7+ sources)"),
    ),
    sync: Options.boolean("sync").pipe(
      Options.withDefault(false),
      Options.withDescription("Wait for result instead of async fire-and-forget"),
    ),
    ingressUrl: Options.text("ingress-url").pipe(
      Options.withDefault(process.env.RESTATE_INGRESS_URL?.trim() || "http://localhost:8080"),
      Options.withDescription("Restate ingress URL"),
    ),
  },
  ({ name, github, twitter, email, website, depth, sync, ingressUrl }) =>
    Effect.gen(function* () {
      const triggerScript = resolveRepoFile("packages/restate/src/trigger-dag.ts")
      if (!triggerScript) {
        yield* Console.log(respondError(
          "restate enrich",
          "Cannot find packages/restate/src/trigger-dag.ts — set JOELCLAW_ROOT or run from repo.",
          "RESTATE_TRIGGER_NOT_FOUND",
          "Set JOELCLAW_ROOT to the joelclaw repo root, or run from within the repo.",
          [{
            command: "joelclaw restate enrich \"Name\" --help",
            description: "Show enrich usage",
          }]
        ))
        return
      }

      const workflowId = `enrich-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`

      const args: string[] = [
        "bun", "run", triggerScript, "--",
        "--pipeline", "enrich-contact",
        "--name", name,
        "--depth", depth,
        "--id", workflowId,
      ]

      if (!sync) args.push("--async")

      const optVal = (opt: { _tag: string; value?: string }): string | undefined =>
        opt._tag === "Some" ? (opt as { value: string }).value : undefined

      const gh = optVal(github as any)
      const tw = optVal(twitter as any)
      const em = optVal(email as any)
      const ws = optVal(website as any)

      if (gh) args.push("--github", gh)
      if (tw) args.push("--twitter", tw)
      if (em) args.push("--email", em)
      if (ws) args.push("--website", ws)

      const proc = Bun.spawnSync(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          RESTATE_INGRESS_URL: ingressUrl,
        },
      })

      const stdout = decode(proc.stdout).trim()
      const stderr = decode(proc.stderr).trim()

      if (proc.exitCode !== 0) {
        yield* Console.log(respondError(
          "restate enrich",
          stderr || stdout || `trigger exited with ${proc.exitCode}`,
          "RESTATE_ENRICH_FAILED",
          "Check Restate runtime health: joelclaw restate status",
          [
            { command: "joelclaw restate status", description: "Check Restate runtime health" },
            { command: "joelclaw restate deployments", description: "Verify DAG services registered" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate enrich", {
        name,
        depth,
        workflowId,
        mode: sync ? "sync" : "async",
        output: stdout,
        hints: { github: gh, twitter: tw, email: em, website: ws },
      }, sync ? [
        { command: `cat ~/Vault/Contacts/${name}.md`, description: "Read generated dossier" },
        { command: "joelclaw otel search \"dag.workflow\" --hours 1", description: "Check OTEL events" },
      ] : [
        { command: `curl ${ingressUrl}/dagOrchestrator/${workflowId}/output`, description: "Poll for result" },
        { command: "joelclaw otel search \"dag.workflow\" --hours 1", description: "Check OTEL events" },
        { command: `cat ~/Vault/Contacts/${name}.md`, description: "Read dossier once complete" },
      ]))
    })
).pipe(Command.withDescription("Enrich a contact via Restate DAG — 7+ parallel source probes → LLM synthesis → Vault dossier"))

const restatePiMonoSyncCmd = Command.make(
  "pi-mono-sync",
  {
    repo: Options.text("repo").pipe(
      Options.withDefault("badlogic/pi-mono"),
      Options.withDescription("GitHub repo to sync (default: badlogic/pi-mono)")
    ),
    localClone: Options.text("local-clone").pipe(
      Options.withDescription("Optional local clone path for repo docs (defaults to ~/Code/<owner>/<repo>)"),
      Options.optional,
    ),
    fullBackfill: Options.boolean("full-backfill").pipe(
      Options.withDefault(false),
      Options.withDescription("Ignore the last sync checkpoint and re-import the full corpus")
    ),
    maxPages: Options.integer("max-pages").pipe(
      Options.withDefault(100),
      Options.withDescription("Maximum GitHub pages to fetch per artifact kind")
    ),
    perPage: Options.integer("per-page").pipe(
      Options.withDefault(100),
      Options.withDescription("GitHub page size per request (max 100)")
    ),
    sync: Options.boolean("sync").pipe(
      Options.withDefault(false),
      Options.withDescription("Wait for the DAG result instead of async fire-and-forget")
    ),
    ingressUrl: Options.text("ingress-url").pipe(
      Options.withDefault(process.env.RESTATE_INGRESS_URL?.trim() || "http://localhost:8080"),
      Options.withDescription("Restate ingress URL")
    ),
  },
  ({ repo, localClone, fullBackfill, maxPages, perPage, sync, ingressUrl }) =>
    Effect.gen(function* () {
      const triggerScript = resolveRepoFile("packages/restate/src/trigger-dag.ts")
      if (!triggerScript) {
        yield* Console.log(respondError(
          "restate pi-mono-sync",
          "Cannot find packages/restate/src/trigger-dag.ts — set JOELCLAW_ROOT or run from repo.",
          "RESTATE_TRIGGER_NOT_FOUND",
          "Set JOELCLAW_ROOT to the joelclaw repo root, or run from within the repo.",
          [{
            command: "joelclaw restate pi-mono-sync --help",
            description: "Show pi-mono sync usage",
          }]
        ))
        return
      }

      const workflowId = `pi-mono-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`
      const args: string[] = [
        "bun", "run", triggerScript, "--",
        "--pipeline", "pi-mono-sync",
        "--repo", repo,
        "--id", workflowId,
        "--max-pages", String(maxPages),
        "--per-page", String(perPage),
      ]

      if (!sync) args.push("--async")
      if (fullBackfill) args.push("--full-backfill")

      const clonePath = (localClone as { _tag: string; value?: string })._tag === "Some"
        ? (localClone as { value: string }).value
        : undefined
      if (clonePath) args.push("--local-clone", clonePath)

      const proc = Bun.spawnSync(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          RESTATE_INGRESS_URL: ingressUrl,
        },
      })

      const stdout = decode(proc.stdout).trim()
      const stderr = decode(proc.stderr).trim()

      if (proc.exitCode !== 0) {
        yield* Console.log(respondError(
          "restate pi-mono-sync",
          stderr || stdout || `trigger exited with ${proc.exitCode}`,
          "RESTATE_PI_MONO_SYNC_FAILED",
          "Check Restate runtime health, GitHub auth, Typesense reachability, and the local clone path before retrying.",
          [
            { command: "joelclaw restate status", description: "Check Restate runtime health" },
            { command: "joelclaw restate deployments", description: "Verify DAG services registered" },
            { command: "joelclaw status", description: "Check Typesense and worker health" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate pi-mono-sync", {
        repo,
        workflowId,
        mode: sync ? "sync" : "async",
        fullBackfill,
        maxPages,
        perPage,
        output: stdout,
      }, sync ? [
        { command: `joelclaw search "Mario" --collection pi_mono_artifacts`, description: "Search the synced pi-mono corpus" },
        { command: "joelclaw otel search \"dag.workflow\" --hours 1", description: "Check OTEL events" },
      ] : [
        { command: `RESTATE_HOSTPORT=localhost:9070 restate invocations list | rg "${workflowId}|dagOrchestrator/${workflowId}/run" -n -C 2`, description: "Inspect the live Restate workflow/invocation state" },
        { command: `joelclaw search "badlogic" --collection pi_mono_artifacts`, description: "Search the pi-mono corpus once sync completes" },
        { command: "joelclaw otel search \"dag.workflow\" --hours 1", description: "Check OTEL events" },
      ]))
    })
).pipe(Command.withDescription("Sync pi-mono docs/issues/PRs/comments/commits/releases into the pi_mono_artifacts Typesense collection via a Restate DAG"))

const restateCronStatusCmd = Command.make(
  "status",
  {
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for the Dkron scheduler")
    ),
    serviceName: Options.text("service-name").pipe(
      Options.withDefault("dkron-svc"),
      Options.withDescription("Kubernetes service name for the Dkron HTTP API")
    ),
    baseUrl: Options.text("base-url").pipe(
      Options.withDefault(process.env.DKRON_URL?.trim() || ""),
      Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)")
    ),
  },
  ({ namespace, serviceName, baseUrl }) =>
    Effect.gen(function* () {
      const stsRes = runKubectl(["-n", namespace, "get", "statefulset", "dkron", "-o", "json"])
      const svcRes = runKubectl(["-n", namespace, "get", "service", serviceName, "-o", "json"])

      const sts = parseJson<Record<string, any>>(stsRes.stdout)
      const svc = parseJson<Record<string, any>>(svcRes.stdout)
      const desired = Number(sts?.spec?.replicas ?? 0)
      const ready = Number(sts?.status?.readyReplicas ?? 0)

      const api = yield* Effect.tryPromise({
        try: async () => {
          const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
          try {
            const health = await fetchJson(session.baseUrl, "/health", { method: "GET" })
            return {
              accessible: health.ok,
              status: health.status,
              response: health.json ?? health.text,
              accessMode: session.accessMode,
              baseUrl: session.baseUrl,
              localPort: session.localPort ?? null,
              error: health.ok ? null : health.text,
            }
          } finally {
            await session.dispose()
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            accessible: false,
            status: 0,
            response: null,
            accessMode: baseUrl ? "direct" : "tunnel",
            baseUrl: baseUrl || null,
            localPort: null,
            error: error.message,
          })
        )
      )

      const allOk = stsRes.ok && svcRes.ok && desired > 0 && ready >= desired && api.accessible

      yield* Console.log(respond("restate cron status", {
        namespace,
        statefulset: {
          exists: stsRes.ok,
          desiredReplicas: desired,
          readyReplicas: ready,
          phase: ready >= desired && desired > 0 ? "ready" : "degraded",
          error: stsRes.ok ? null : stsRes.stderr || stsRes.stdout,
        },
        service: {
          exists: svcRes.ok,
          type: svc?.spec?.type ?? null,
          ports: Array.isArray(svc?.spec?.ports)
            ? svc.spec.ports.map((port: any) => ({ name: port?.name, port: port?.port, targetPort: port?.targetPort }))
            : [],
          error: svcRes.ok ? null : svcRes.stderr || svcRes.stdout,
        },
        api,
      }, [
        { command: "joelclaw restate cron list", description: "List scheduler jobs" },
        { command: "joelclaw restate cron sync-tier1", description: "Create or update all ADR-0216 tier-1 jobs" },
      ], allOk))
    })
).pipe(Command.withDescription("Check Dkron scheduler health for Restate cron jobs"))

const restateCronListCmd = Command.make(
  "list",
  {
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for the Dkron scheduler")
    ),
    serviceName: Options.text("service-name").pipe(
      Options.withDefault("dkron-svc"),
      Options.withDescription("Kubernetes service name for the Dkron HTTP API")
    ),
    baseUrl: Options.text("base-url").pipe(
      Options.withDefault(process.env.DKRON_URL?.trim() || ""),
      Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)")
    ),
  },
  ({ namespace, serviceName, baseUrl }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
          try {
            const jobsRes = await fetchJson(session.baseUrl, "/v1/jobs", { method: "GET" })
            if (!jobsRes.ok) {
              throw new Error(jobsRes.text || `Dkron returned ${jobsRes.status}`)
            }
            const jobs = Array.isArray(jobsRes.json) ? jobsRes.json : []
            const restateJobs = jobs.filter((job: any) => job?.metadata?.runtime === "restate")
            return {
              accessMode: session.accessMode,
              baseUrl: session.baseUrl,
              jobs: restateJobs.map((job: any) => ({
                name: job.name,
                schedule: job.schedule,
                timezone: job.timezone,
                disabled: job.disabled,
                executor: job.executor,
                pipeline: job.metadata?.pipeline ?? null,
                migratedFrom: job.metadata?.migrated_from ?? null,
                next: job.next ?? null,
                retries: job.retries ?? null,
                successCount: job.success_count ?? null,
                errorCount: job.error_count ?? null,
                lastSuccess: job.last_success ?? null,
                lastError: job.last_error ?? null,
              })),
              counts: {
                restate: restateJobs.length,
                total: jobs.length,
              },
            }
          } finally {
            await session.dispose()
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({ error: error.message })
        )
      )

      if ("error" in result) {
        yield* Console.log(respondError(
          "restate cron list",
          result.error,
          "RESTATE_CRON_LIST_FAILED",
          "Ensure Dkron is deployed and healthy: joelclaw restate cron status",
          [
            { command: "joelclaw restate cron status", description: "Check Dkron scheduler health" },
            { command: "kubectl get pods -n joelclaw -l app=dkron", description: "Inspect Dkron pod state" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate cron list", result, [
        { command: "joelclaw restate cron sync-tier1", description: "Ensure all tier-1 jobs exist" },
        { command: "joelclaw restate cron status", description: "Check scheduler health" },
      ]))
    })
).pipe(Command.withDescription("List Restate-related Dkron scheduler jobs"))

const restateCronEnableHealthCmd = Command.make(
  "enable-health",
  {
    schedule: Options.text("schedule").pipe(
      Options.withDefault("0 7 * * * *"),
      Options.withDescription("Dkron cron expression for the Restate health job (six fields: sec min hour dom month dow)")
    ),
    timezone: Options.text("timezone").pipe(
      Options.withDefault("America/Los_Angeles"),
      Options.withDescription("Timezone used to evaluate the cron expression")
    ),
    workflowId: Options.text("workflow-id").pipe(
      Options.withDefault("restate-health-scheduled"),
      Options.withDescription("Workflow ID prefix; Dkron appends epoch seconds so each scheduled run gets a unique Restate workflow ID")
    ),
    restateUrl: Options.text("restate-url").pipe(
      Options.withDefault("http://restate:8080"),
      Options.withDescription("In-cluster Restate ingress URL Dkron should call")
    ),
    runNow: Options.boolean("run-now").pipe(
      Options.withDefault(false),
      Options.withDescription("Trigger the job immediately after upsert")
    ),
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for the Dkron scheduler")
    ),
    serviceName: Options.text("service-name").pipe(
      Options.withDefault("dkron-svc"),
      Options.withDescription("Kubernetes service name for the Dkron HTTP API")
    ),
    baseUrl: Options.text("base-url").pipe(
      Options.withDefault(process.env.DKRON_URL?.trim() || ""),
      Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)")
    ),
  },
  ({ schedule, timezone, workflowId, restateUrl, runNow, namespace, serviceName, baseUrl }) =>
    Effect.gen(function* () {
      const job = buildHealthJob(schedule, timezone, restateUrl, workflowId)

      const result = yield* Effect.tryPromise({
        try: async () => {
          const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
          try {
            const upsert = await fetchJson(session.baseUrl, "/v1/jobs/restate-health-check", {
              method: "PUT",
              body: JSON.stringify(job),
            })
            if (!upsert.ok) {
              throw new Error(upsert.text || `Dkron returned ${upsert.status}`)
            }

            let runResult: JsonHttpResult | null = null
            if (runNow) {
              runResult = await fetchJson(session.baseUrl, "/v1/jobs/restate-health-check/run", { method: "POST" })
              if (!runResult.ok) {
                throw new Error(runResult.text || `Dkron returned ${runResult.status} when starting the job`)
              }
            }

            return {
              accessMode: session.accessMode,
              baseUrl: session.baseUrl,
              job: upsert.json ?? job,
              runTriggered: runNow,
              runResponse: runResult?.json ?? runResult?.text ?? null,
              operatorVerification: {
                otelQuery: 'joelclaw otel search "dag.workflow" --hours 1',
                workflowIdPrefix: workflowId,
              },
            }
          } finally {
            await session.dispose()
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({ error: error.message })
        )
      )

      if ("error" in result) {
        yield* Console.log(respondError(
          "restate cron enable-health",
          result.error,
          "RESTATE_CRON_ENABLE_HEALTH_FAILED",
          "Ensure Dkron is reachable and Restate is healthy before retrying.",
          [
            { command: "joelclaw restate cron status", description: "Check scheduler health" },
            { command: "joelclaw restate status", description: "Check Restate runtime health" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate cron enable-health", result, [
        { command: "joelclaw restate cron list", description: "Confirm the scheduler job is registered" },
        { command: "joelclaw restate cron status", description: "Check scheduler health after seeding the job" },
        { command: "joelclaw otel search \"dag.workflow\" --hours 1", description: "Correlate OTEL events for the scheduled run" },
      ]))
    })
).pipe(Command.withDescription("Create or update the Dkron proof job that schedules the existing Restate health pipeline"))

const restateCronSyncTier1Cmd = Command.make(
  "sync-tier1",
  {
    runNow: Options.boolean("run-now").pipe(
      Options.withDefault(false),
      Options.withDescription("Trigger each tier-1 job immediately after upsert")
    ),
    restateUrl: Options.text("restate-url").pipe(
      Options.withDefault("http://restate:8080"),
      Options.withDescription("In-cluster Restate ingress URL Dkron should call")
    ),
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for the Dkron scheduler")
    ),
    serviceName: Options.text("service-name").pipe(
      Options.withDefault("dkron-svc"),
      Options.withDescription("Kubernetes service name for the Dkron HTTP API")
    ),
    baseUrl: Options.text("base-url").pipe(
      Options.withDefault(process.env.DKRON_URL?.trim() || ""),
      Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)")
    ),
  },
  ({ runNow, restateUrl, namespace, serviceName, baseUrl }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
          try {
            const jobs = [] as Array<Record<string, unknown>>

            for (const key of RESTATE_TIER1_PIPELINE_KEYS) {
              const definition = RESTATE_CRON_PIPELINES[key]
              const job = buildDagJob(definition, { restateUrl })
              const upserted = await upsertDkronJob(session, job, runNow)
              jobs.push({
                key,
                jobName: definition.jobName,
                pipeline: definition.pipeline,
                schedule: job.schedule,
                timezone: job.timezone,
                migratedFrom: definition.migratedFrom,
                runTriggered: upserted.runTriggered,
                runResponse: upserted.runResponse,
              })
            }

            return {
              accessMode: session.accessMode,
              baseUrl: session.baseUrl,
              runTriggered: runNow,
              jobs,
              operatorVerification: {
                dkron: "joelclaw restate cron list",
                otel: "joelclaw otel search \"dag.workflow.completed OR skill-garden.findings OR subscription.check_feeds.completed OR memory.digest.generate\" --hours 24",
              },
            }
          } finally {
            await session.dispose()
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.catchAll((error) => Effect.succeed({ error: error.message })))

      if ("error" in result) {
        yield* Console.log(respondError(
          "restate cron sync-tier1",
          result.error,
          "RESTATE_CRON_SYNC_TIER1_FAILED",
          "Ensure Dkron is reachable, Restate is healthy, and the tier-1 runners compile before retrying.",
          [
            { command: "joelclaw restate cron status", description: "Check scheduler health" },
            { command: "joelclaw restate status", description: "Check Restate runtime health" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate cron sync-tier1", result, [
        { command: "joelclaw restate cron list", description: "Confirm the tier-1 scheduler jobs are registered" },
        { command: "joelclaw restate cron status", description: "Check scheduler health after seeding tier-1" },
        { command: "joelclaw otel search \"dag.workflow.completed OR skill-garden.findings OR subscription.check_feeds.completed OR memory.digest.generate\" --hours 24", description: "Monitor tier-1 execution evidence" },
      ]))
    })
).pipe(Command.withDescription("Create or update all ADR-0216 tier-1 Dkron jobs for Restate pipelines"))

const restateCronDeleteCmd = Command.make(
  "delete",
  {
    job: Args.text({ name: "job" }).pipe(Args.withDescription("Dkron job name to delete")),
    namespace: Options.text("namespace").pipe(
      Options.withDefault("joelclaw"),
      Options.withDescription("Kubernetes namespace for the Dkron scheduler")
    ),
    serviceName: Options.text("service-name").pipe(
      Options.withDefault("dkron-svc"),
      Options.withDescription("Kubernetes service name for the Dkron HTTP API")
    ),
    baseUrl: Options.text("base-url").pipe(
      Options.withDefault(process.env.DKRON_URL?.trim() || ""),
      Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)")
    ),
  },
  ({ job, namespace, serviceName, baseUrl }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
          try {
            const deleted = await fetchJson(session.baseUrl, `/v1/jobs/${job}`, { method: "DELETE" })
            if (!deleted.ok) {
              throw new Error(deleted.text || `Dkron returned ${deleted.status}`)
            }
            return {
              accessMode: session.accessMode,
              baseUrl: session.baseUrl,
              deleted: deleted.json ?? deleted.text,
            }
          } finally {
            await session.dispose()
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.catchAll((error) => Effect.succeed({ error: error.message }))
      )

      if ("error" in result) {
        yield* Console.log(respondError(
          "restate cron delete",
          result.error,
          "RESTATE_CRON_DELETE_FAILED",
          "Check the job name and Dkron connectivity, then retry.",
          [
            { command: "joelclaw restate cron list", description: "List scheduler jobs" },
            { command: "joelclaw restate cron status", description: "Check scheduler health" },
          ]
        ))
        return
      }

      yield* Console.log(respond("restate cron delete", result, [
        { command: "joelclaw restate cron list", description: "Confirm remaining scheduler jobs" },
      ]))
    })
).pipe(Command.withDescription("Delete a Restate-related Dkron scheduler job"))

const restateCronCmd = Command.make("cron", {}, () =>
  Console.log(respond("restate cron", {
    description: "Dkron scheduler controls for Restate pipelines",
    subcommands: {
      status: "joelclaw restate cron status [--namespace joelclaw] [--service-name dkron-svc] [--base-url http://127.0.0.1:8080]",
      list: "joelclaw restate cron list [--namespace joelclaw] [--service-name dkron-svc]",
      enableHealth: "joelclaw restate cron enable-health [--schedule '0 7 * * * *'] [--run-now] [--restate-url http://restate:8080]",
      syncTier1: "joelclaw restate cron sync-tier1 [--run-now] [--restate-url http://restate:8080]",
      delete: "joelclaw restate cron delete <job>",
    },
  }, [
    { command: "joelclaw restate cron status", description: "Check Dkron scheduler health" },
    { command: "joelclaw restate cron list", description: "List current scheduler jobs" },
    { command: "joelclaw restate cron sync-tier1 --run-now", description: "Seed and immediately trigger the ADR-0216 tier-1 jobs" },
  ]))
).pipe(Command.withSubcommands([restateCronStatusCmd, restateCronListCmd, restateCronEnableHealthCmd, restateCronSyncTier1Cmd, restateCronDeleteCmd]))

export const restateCmd = Command.make("restate", {}, () =>
  Console.log(respond("restate", {
    description: "Restate runtime, deployments, and DAG pipelines",
    subcommands: {
      status: "joelclaw restate status [--namespace joelclaw] [--admin-url http://localhost:9070]",
      deployments: "joelclaw restate deployments [--admin-url http://localhost:9070] [--cli-bin restate]",
      smoke: "joelclaw restate smoke [--script scripts/restate/test-workflow.sh]",
      enrich: "joelclaw restate enrich \"Name\" [--github user] [--twitter user] [--depth full|quick] [--sync]",
      piMonoSync: "joelclaw restate pi-mono-sync [--repo badlogic/pi-mono] [--full-backfill] [--sync]",
      cron: "joelclaw restate cron <status|list|enable-health|sync-tier1|delete>",
    },
  }, [
    {
      command: "joelclaw restate status",
      description: "Check Restate runtime health and k8s resources",
    },
    {
      command: "joelclaw restate deployments",
      description: "List Restate deployments via CLI",
    },
    {
      command: "joelclaw restate smoke",
      description: "Run end-to-end Restate deployGate smoke test",
    },
    {
      command: "joelclaw restate enrich \"Kent C. Dodds\" --github kentcdodds --depth full",
      description: "Enrich a contact through the Restate DAG pipeline",
    },
    {
      command: "joelclaw restate pi-mono-sync --repo badlogic/pi-mono --sync",
      description: "Sync pi-mono docs, issues, PRs, comments, commits, and releases into Typesense",
    },
    {
      command: "joelclaw restate cron sync-tier1 --run-now",
      description: "Seed Dkron with the ADR-0216 tier-1 Restate jobs and trigger them now",
    },
  ]))
).pipe(Command.withSubcommands([restateStatusCmd, restateDeploymentsCmd, restateSmokeCmd, restateEnrichCmd, restatePiMonoSyncCmd, restateCronCmd]))
