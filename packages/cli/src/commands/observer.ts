import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError, type NextAction } from "../response"

const HOME = homedir()
const OBSERVER_SESSION = "observer"
const FAMILY_PATH = join(HOME, ".joelclaw/observer-family.json")
const SESSION_PATH = join(HOME, ".joelclaw/observer-session.json")
const PANE_ID_PATH = join(HOME, ".joelclaw/observer-pane-id")
const SOCKET_PATH = join(HOME, ".config/herdr/sessions/observer/herdr.sock")
const TICK_SCRIPT = join(HOME, ".joelclaw/bin/observer-tick.sh")

const OBSERVER_ALIASES: Record<string, string> = {
  observer: "orchestrator",
  orchestrator: "orchestrator",
  cannon: "orchestrator",
  canonical: "orchestrator",
  dispatcher: "dispatcher",
}

type ObserverRole = {
  readonly paneId?: string
  readonly target?: string
  readonly label?: string
  readonly agentName?: string
}

type ObserverFamily = {
  readonly schemaVersion?: number
  readonly session?: string
  readonly socketPath?: string
  readonly updatedAt?: string
  readonly cwd?: string
  readonly roles?: Record<string, ObserverRole>
}

type ObserverSession = {
  readonly startedAt?: string
  readonly sessionId?: string
  readonly sessionFile?: string
  readonly paneId?: string
  readonly cwd?: string
}

type HerdrStatus = {
  readonly client?: { readonly version?: string; readonly protocol?: number }
  readonly server?: {
    readonly status?: string
    readonly version?: string
    readonly protocol?: number
    readonly compatible?: boolean
    readonly socket?: string
  }
  readonly update?: { readonly restartNeeded?: boolean }
  readonly raw?: string
  readonly error?: string
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  const value = readFileSync(path, "utf8").trim()
  return value.length > 0 ? value : null
}

function parseHerdrStatus(raw: string): HerdrStatus {
  const status: HerdrStatus = { raw }
  const clientVersion = raw.match(/client:[\s\S]*?version:\s*([^\n]+)/)?.[1]?.trim()
  const clientProtocol = raw.match(/client:[\s\S]*?protocol:\s*(\d+)/)?.[1]
  const serverBlock = raw.match(/server:[\s\S]*?(?:\n\nupdate:|$)/)?.[0] ?? ""
  const serverStatus = serverBlock.match(/status:\s*([^\n]+)/)?.[1]?.trim()
  const serverVersion = serverBlock.match(/version:\s*([^\n]+)/)?.[1]?.trim()
  const serverProtocol = serverBlock.match(/protocol:\s*(\d+)/)?.[1]
  const compatibleRaw = serverBlock.match(/compatible:\s*(yes|no|true|false)/)?.[1]?.trim()
  const socket = serverBlock.match(/socket:\s*([^\n]+)/)?.[1]?.trim()
  const restartNeededRaw = raw.match(/restart_needed:\s*(yes|no|true|false)/)?.[1]?.trim()

  return {
    ...status,
    client: {
      ...(clientVersion ? { version: clientVersion } : {}),
      ...(clientProtocol ? { protocol: Number.parseInt(clientProtocol, 10) } : {}),
    },
    server: {
      ...(serverStatus ? { status: serverStatus } : {}),
      ...(serverVersion ? { version: serverVersion } : {}),
      ...(serverProtocol ? { protocol: Number.parseInt(serverProtocol, 10) } : {}),
      ...(compatibleRaw ? { compatible: compatibleRaw === "yes" || compatibleRaw === "true" } : {}),
      ...(socket ? { socket } : {}),
    },
    update: {
      ...(restartNeededRaw ? { restartNeeded: restartNeededRaw === "yes" || restartNeededRaw === "true" } : {}),
    },
  }
}

function herdrStatus(): HerdrStatus {
  try {
    const raw = execFileSync("herdr", ["--session", OBSERVER_SESSION, "status"], {
      encoding: "utf8",
      timeout: 5_000,
    })
    return parseHerdrStatus(raw)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function observerState() {
  const family = readJson<ObserverFamily>(FAMILY_PATH)
  const session = readJson<ObserverSession>(SESSION_PATH)
  const paneIdFallback = readText(PANE_ID_PATH)
  const herdr = herdrStatus()
  return {
    familyPath: FAMILY_PATH,
    sessionPath: SESSION_PATH,
    paneIdPath: PANE_ID_PATH,
    socketPath: SOCKET_PATH,
    tickScript: TICK_SCRIPT,
    family,
    session,
    paneIdFallback,
    herdr,
  }
}

function resolveObserverTarget(target: string) {
  const state = observerState()
  const normalized = target.trim().toLowerCase()
  const roleName = OBSERVER_ALIASES[normalized] ?? normalized
  const role = state.family?.roles?.[roleName]
  const paneId = role?.paneId ?? role?.target ?? (roleName === "orchestrator" ? state.session?.paneId ?? state.paneIdFallback ?? undefined : undefined)
  const healthy = state.herdr.server?.compatible === true && Boolean(paneId)

  return {
    target: normalized,
    resolvedRole: roleName,
    healthy,
    session: state.family?.session ?? OBSERVER_SESSION,
    paneId,
    role: role ?? null,
    observerSession: state.session,
    herdr: state.herdr,
    sources: {
      familyPath: state.familyPath,
      sessionPath: state.sessionPath,
      paneIdPath: state.paneIdPath,
      socketPath: state.socketPath,
    },
    warnings: [
      ...(state.herdr.error ? [`Herdr status failed: ${state.herdr.error}`] : []),
      ...(state.herdr.server?.compatible === false ? ["Observer Herdr server protocol is incompatible; run joelclaw observer cycle --execute"] : []),
      ...(!paneId ? [`No pane id found for observer role ${roleName}`] : []),
    ],
  }
}

const observerNextActions = (target = "observer"): readonly NextAction[] => [
  { command: "joelclaw observer resolve <target>", description: "Resolve an Observer family target", params: { target: { value: target, default: "observer" } } },
  { command: "joelclaw observer status", description: "Check Observer Herdr protocol and family state" },
  { command: "joelclaw wake in 1m --verb wake --target observer --prompt <prompt>", description: "Schedule a WAKE to the live Observer target", params: { prompt: { description: "Prompt to send at wake time", value: "ping" } } },
  { command: "joelclaw observer cycle --execute", description: "Cycle only the named Observer Herdr server if protocol drift is present" },
]

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withDefault("observer"),
  Args.withDescription("Observer target alias: observer, orchestrator, dispatcher, cannon"),
)

const executeOpt = Options.boolean("execute").pipe(
  Options.withDefault(false),
  Options.withDescription("Actually stop/start the named Observer Herdr server"),
)

const noRotateOpt = Options.boolean("no-rotate").pipe(
  Options.withDefault(false),
  Options.withDescription("Skip the OBSERVER_FORCE_ROTATE=1 supervisor tick after cycling"),
)

const observerStatusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(respond("observer status", observerState(), observerNextActions(), true))
  }),
).pipe(Command.withDescription("Show Observer Herdr protocol, registry, and session metadata"))

const observerResolveCmd = Command.make("resolve", { target: targetArg }, ({ target }) =>
  Effect.gen(function* () {
    const resolved = resolveObserverTarget(target)
    if (!resolved.healthy) {
      yield* Console.log(respondError(
        "observer resolve",
        `Observer target ${target} is not healthy`,
        "OBSERVER_TARGET_UNHEALTHY",
        "Run joelclaw observer status. If the Herdr protocol is incompatible, run joelclaw observer cycle --execute.",
        observerNextActions(target),
      ))
      return
    }
    yield* Console.log(respond("observer resolve", resolved, observerNextActions(target), true))
  }),
).pipe(Command.withDescription("Resolve observer/cannon/dispatcher to a live Observer family pane"))

const observerCycleCmd = Command.make("cycle", { execute: executeOpt, noRotate: noRotateOpt }, ({ execute, noRotate }) =>
  Effect.gen(function* () {
    const rotate = !noRotate
    const before = observerState()
    const needsCycle = before.herdr.server?.compatible === false || before.herdr.update?.restartNeeded === true || before.herdr.server?.status !== "running"

    if (!execute) {
      yield* Console.log(respond("observer cycle", {
        mode: "dry-run",
        needsCycle,
        before,
        plan: [
          "Stop only the named Observer Herdr server: herdr session stop observer",
          "If the server remains alive, kill only `herdr --session observer server` processes",
          "Start current server: herdr --session observer server",
          rotate ? "Force Observer supervisor rotation: OBSERVER_FORCE_ROTATE=1 ~/.joelclaw/bin/observer-tick.sh" : "Skip Observer tick rotation",
          "Verify: joelclaw observer status && joelclaw observer resolve observer",
        ],
      }, [
        { command: "joelclaw observer cycle --execute", description: "Run the cycle plan" },
        ...observerNextActions(),
      ], true))
      return
    }

    const stop = spawnSync("herdr", ["session", "stop", OBSERVER_SESSION], { encoding: "utf8", timeout: 15_000 })
    const ps = spawnSync("pgrep", ["-f", "herdr --session observer server"], { encoding: "utf8", timeout: 5_000 })
    const remainingPids = ps.stdout.split(/\s+/).map((pid) => pid.trim()).filter(Boolean)
    const killed: string[] = []
    for (const pid of remainingPids) {
      const kill = spawnSync("kill", ["-9", pid], { encoding: "utf8", timeout: 5_000 })
      if (kill.status === 0) killed.push(pid)
    }

    const start = spawnSync("herdr", ["--session", OBSERVER_SESSION, "server"], {
      detached: true,
      stdio: "ignore",
    })
    start.unref?.()

    if (rotate && existsSync(TICK_SCRIPT)) {
      spawnSync(TICK_SCRIPT, [], {
        env: { ...process.env, OBSERVER_FORCE_ROTATE: "1" },
        encoding: "utf8",
        timeout: 120_000,
      })
    }

    const after = observerState()
    yield* Console.log(respond("observer cycle", {
      mode: "execute",
      before,
      stop: { status: stop.status, stdout: stop.stdout, stderr: stop.stderr },
      killed,
      started: start.pid ? { pid: start.pid } : { status: start.status, error: start.error?.message },
      rotated: rotate,
      after,
    }, observerNextActions(), after.herdr.server?.compatible === true))
  }),
).pipe(Command.withDescription("Cycle the named Observer Herdr server onto the current protocol"))

export const observerCmd = Command.make("observer", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(respond("observer", {
      description: "Manage the joelclaw Observer: canonical target resolution, Herdr protocol status, and safe named-session cycling.",
      aliases: OBSERVER_ALIASES,
      commands: {
        status: "joelclaw observer status",
        resolve: "joelclaw observer resolve [target]",
        cycle: "joelclaw observer cycle [--execute] [--no-rotate]",
      },
    }, observerNextActions(), true))
  }),
).pipe(
  Command.withDescription("Manage the joelclaw Observer canonical target and Herdr session"),
  Command.withSubcommands([observerStatusCmd, observerResolveCmd, observerCycleCmd]),
)
