import { existsSync } from "node:fs"
import path from "node:path"
import { Args, Command, Options } from "@effect/cli"
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

export const restateCmd = Command.make("restate", {}, () =>
  Console.log(respond("restate", {
    description: "Restate runtime, deployments, and DAG pipelines",
    subcommands: {
      status: "joelclaw restate status [--namespace joelclaw] [--admin-url http://localhost:9070]",
      deployments: "joelclaw restate deployments [--admin-url http://localhost:9070] [--cli-bin restate]",
      smoke: "joelclaw restate smoke [--script scripts/restate/test-workflow.sh]",
      enrich: "joelclaw restate enrich \"Name\" [--github user] [--twitter user] [--depth full|quick] [--sync]",
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
  ]))
).pipe(Command.withSubcommands([restateStatusCmd, restateDeploymentsCmd, restateSmokeCmd, restateEnrichCmd]))
