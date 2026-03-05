import { Command, Options } from "@effect/cli"
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
      const proc = Bun.spawnSync(["bash", script], {
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
          "Ensure k8s Restate + MinIO are running and the script path is valid.",
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
        script,
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

export const restateCmd = Command.make("restate", {}, () =>
  Console.log(respond("restate", {
    description: "Restate runtime and deployment visibility",
    subcommands: {
      status: "joelclaw restate status [--namespace joelclaw] [--admin-url http://localhost:9070]",
      deployments: "joelclaw restate deployments [--admin-url http://localhost:9070] [--cli-bin restate]",
      smoke: "joelclaw restate smoke [--script scripts/restate/test-workflow.sh]",
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
      description: "Run end-to-end Restate smoke test with MinIO artifact verification",
    },
  ]))
).pipe(Command.withSubcommands([restateStatusCmd, restateDeploymentsCmd, restateSmokeCmd]))
