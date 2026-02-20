/**
 * ADR-0058: Log viewing with optional --follow for NDJSON streaming.
 *
 * Without --follow: returns last N lines as JSON envelope.
 * With --follow: tails the log file, emitting each new line as
 * {"type":"log",...} NDJSON. Ctrl-c to stop.
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"
import type { NextAction } from "../response"
import { existsSync } from "node:fs"
import {
  emitStart,
  emitLog,
  emitResult,
  emitError,
} from "../stream"

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
    follow: Options.boolean("follow").pipe(
      Options.withAlias("f"),
      Options.withDefault(false),
      Options.withDescription("Stream new lines as NDJSON (ADR-0058)")
    ),
    timeout: Options.integer("timeout").pipe(
      Options.withDefault(0),
      Options.withDescription("Follow timeout in seconds (0 = indefinite)")
    ),
  },
  ({ source, lines, grep, follow, timeout }) =>
    Effect.gen(function* () {
      const grepVal = grep._tag === "Some" ? grep.value : undefined

      // ── Follow mode: tail -f as NDJSON ─────────────────────────
      if (follow) {
        let logFile: string
        let label: string
        switch (source) {
          case "errors":
          case "err":
            logFile = WORKER_ERR; label = "worker stderr"; break
          case "server":
            emitError("logs --follow", "Cannot follow k8s logs via NDJSON yet — use kubectl logs -f",
              "NOT_SUPPORTED",
              "kubectl logs -n joelclaw -f statefulset/inngest", [
                { command: "joelclaw logs server", description: "Snapshot of server logs" },
              ])
            return
          default:
            logFile = WORKER_LOG; label = "worker stdout"
        }

        if (!existsSync(logFile)) {
          emitError(`logs --follow`, `Log file not found: ${logFile}`, "LOG_MISSING",
            "Check worker: launchctl print gui/$(id -u)/com.joel.system-bus-worker", [])
          return
        }

        const cmd = `joelclaw logs ${source} --follow`
        emitStart(cmd)
        emitLog("info", `Tailing ${label} (${logFile})`)

        let ended = false
        let lineCount = 0
        const startTime = Date.now()

        const onSignal = () => {
          ended = true
          emitResult(cmd, { lines_emitted: lineCount, duration_ms: Date.now() - startTime }, [])
          process.exit(0)
        }
        process.on("SIGINT", onSignal)
        process.on("SIGTERM", onSignal)

        // Use tail -f subprocess
        const proc = Bun.spawn(["tail", "-f", "-n", String(lines), logFile], {
          stdout: "pipe",
          stderr: "pipe",
        })

        // Timeout handler
        let timer: ReturnType<typeof setTimeout> | null = null
        if (timeout > 0) {
          timer = setTimeout(() => {
            ended = true
            proc.kill()
          }, timeout * 1000)
        }

        yield* Effect.tryPromise({
          try: async () => {
            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            try {
              while (!ended) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const splitLines = buffer.split("\n")
                buffer = splitLines.pop() ?? ""
                for (const line of splitLines) {
                  if (!line.trim()) continue
                  if (grepVal && !line.toLowerCase().includes(grepVal.toLowerCase())) continue
                  lineCount++
                  const level = line.includes("ERROR") || line.includes("error")
                    ? "error" as const
                    : line.includes("WARN") || line.includes("warn")
                      ? "warn" as const
                      : "info" as const
                  emitLog(level, line)
                }
              }
            } catch {
              // Reader closed
            }
          },
          catch: () => new Error("tail failed"),
        })

        if (timer) clearTimeout(timer)
        proc.kill()
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)

        emitResult(cmd, { lines_emitted: lineCount, duration_ms: Date.now() - startTime }, [
          {
            command: "joelclaw logs <source>",
            description: "Snapshot mode",
            params: {
              source: {
                description: "Log source",
                value: source,
                enum: ["worker", "errors", "server"],
                required: true,
              },
            },
          },
        ])
        return
      }

      // ── Snapshot mode (original behavior) ──────────────────────

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
              {
                command: "joelclaw logs <source>",
                description: "Try worker logs instead",
                params: {
                  source: {
                    description: "Log source",
                    value: "worker",
                    enum: ["worker", "errors", "server"],
                    required: true,
                  },
                },
              },
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
              {
                command: "joelclaw logs <source>",
                description: "Check worker stdout instead",
                params: {
                  source: {
                    description: "Log source",
                    value: "worker",
                    enum: ["worker", "errors", "server"],
                    required: true,
                  },
                },
              },
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
      if (source !== "errors") {
        next.push({
          command: "joelclaw logs <source>",
          description: "Worker stderr (stack traces)",
          params: {
            source: {
              description: "Log source",
              value: "errors",
              enum: ["worker", "errors", "server"],
              required: true,
            },
          },
        })
      }
      if (source !== "server") {
        next.push({
          command: "joelclaw logs <source>",
          description: "Inngest server logs (k8s)",
          params: {
            source: {
              description: "Log source",
              value: "server",
              enum: ["worker", "errors", "server"],
              required: true,
            },
          },
        })
      }
      if (source !== "worker") {
        next.push({
          command: "joelclaw logs <source>",
          description: "Worker stdout",
          params: {
            source: {
              description: "Log source",
              value: "worker",
              enum: ["worker", "errors", "server"],
              required: true,
            },
          },
        })
      }
      if (!grepVal) {
        next.push({
          command: "joelclaw logs <source> [--grep <grep>]",
          description: "Filter for errors",
          params: {
            source: {
              description: "Log source",
              value: source,
              enum: ["worker", "errors", "server"],
              required: true,
            },
            grep: { description: "Filter string", value: "error" },
          },
        })
      }
      next.push({
        command: "joelclaw runs [--status <status>]",
        description: "Failed runs",
        params: {
          status: {
            description: "Run status filter",
            value: "FAILED",
            enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
          },
        },
      })

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
