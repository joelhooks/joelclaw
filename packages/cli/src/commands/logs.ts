import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"
import type { NextAction } from "../response"
import { existsSync } from "node:fs"

const WORKER_LOG = `${process.env.HOME}/.local/log/system-bus-worker.log`
const WORKER_ERR = `${process.env.HOME}/.local/log/system-bus-worker.err`

export const logsCmd = Command.make(
  "logs",
  {
    source: Args.text({ name: "source" }).pipe(
      Args.withDefault("worker"),
      Args.withDescription("worker | errors | server")
    ),
    lines: Options.integer("lines").pipe(
      Options.withAlias("n"),
      Options.withDefault(30),
      Options.withDescription("Lines to show (default: 30)")
    ),
    grep: Options.text("grep").pipe(
      Options.withAlias("g"),
      Options.optional,
      Options.withDescription("Filter lines containing this string")
    ),
  },
  ({ source, lines, grep }) =>
    Effect.gen(function* () {
      const grepVal = grep._tag === "Some" ? grep.value : undefined

      let label: string
      let output: string

      switch (source) {
        case "server": {
          label = "inngest server (k8s)"
          const proc = Bun.spawnSync(
            ["kubectl", "logs", "-n", "joelclaw", "statefulset/inngest", `--tail=${lines * 2}`],
            { stdout: "pipe", stderr: "pipe" }
          )
          if (proc.exitCode !== 0) {
            const next: NextAction[] = [
              { command: `kubectl get pods -n joelclaw`, description: "Check pod status" },
              { command: `joelclaw logs worker`, description: "Try worker logs instead" },
            ]
            yield* Console.log(respondError("logs server", "kubectl failed — k8s not reachable", "K8S_UNREACHABLE",
              "Check k3d cluster: k3d cluster list && kubectl get pods -n joelclaw", next))
            return
          }
          output = proc.stdout.toString().trim()
          break
        }
        case "errors":
        case "err": {
          label = "worker stderr"
          if (!existsSync(WORKER_ERR)) {
            yield* Console.log(respond("logs errors", { source: label, lineCount: 0, output: "(no error log file)" }, [
              { command: `joelclaw logs worker`, description: "Check worker stdout instead" },
            ]))
            return
          }
          const proc = Bun.spawnSync(["tail", `-${lines * 2}`, WORKER_ERR], { stdout: "pipe" })
          output = proc.stdout.toString().trim()
          break
        }
        case "worker":
        default: {
          label = "worker stdout"
          if (!existsSync(WORKER_LOG)) {
            yield* Console.log(respondError("logs worker", "Worker log not found", "LOG_MISSING",
              "Check launchd: launchctl print gui/$(id -u)/com.joel.system-bus-worker", [
                { command: `joelclaw status`, description: "Check overall health" },
              ]))
            return
          }
          const proc = Bun.spawnSync(["tail", `-${lines * 2}`, WORKER_LOG], { stdout: "pipe" })
          output = proc.stdout.toString().trim()
          break
        }
      }

      // Apply grep filter
      let filteredLines = output.split("\n")
      if (grepVal) {
        filteredLines = filteredLines.filter(l => l.toLowerCase().includes(grepVal.toLowerCase()))
      }

      // Truncate to requested line count
      const total = filteredLines.length
      const truncated = total > lines
      const shown = filteredLines.slice(-lines)

      const next: NextAction[] = []
      if (source !== "errors") next.push({ command: `joelclaw logs errors`, description: "Worker stderr (stack traces)" })
      if (source !== "server") next.push({ command: `joelclaw logs server`, description: "Inngest server logs (k8s)" })
      if (source !== "worker") next.push({ command: `joelclaw logs worker`, description: "Worker stdout" })
      if (!grepVal) next.push({ command: `joelclaw logs ${source} --grep error`, description: "Filter for errors" })
      next.push({ command: `joelclaw runs --status FAILED`, description: "Failed runs" })

      yield* Console.log(respond(`logs ${source}`, {
        source: label,
        showing: shown.length,
        total,
        truncated,
        ...(grepVal ? { grep: grepVal } : {}),
        lines: shown,
      }, next))
    })
)
