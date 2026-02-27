/**
 * ADR-0058: Log viewing with optional --follow for NDJSON streaming.
 *
 * Without --follow: returns last N lines as JSON envelope.
 * With --follow: tails the log file, emitting each new line as
 * {"type":"log",...} NDJSON. Ctrl-c to stop.
 */

import { existsSync } from "node:fs"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { NextAction } from "../response"
import { respond, respondError } from "../response"
import {
  emitError,
  emitLog,
  emitResult,
  emitStart,
} from "../stream"

const WORKER_LOG = `${process.env.HOME}/.local/log/system-bus-worker.log`
const WORKER_ERR = `${process.env.HOME}/.local/log/system-bus-worker.err`

type LogSourceKind = "worker" | "errors" | "server"
type LogSeverity = "debug" | "info" | "warn" | "error"

type SourceSnapshot = {
  source: LogSourceKind
  label: string
  available: boolean
  lines: string[]
  error?: string
}

type AggregateOptions = {
  grep?: string
}

export function normalizeSourceArg(value: string): LogSourceKind | "analyze" | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "worker") return "worker"
  if (normalized === "errors" || normalized === "err") return "errors"
  if (normalized === "server") return "server"
  if (normalized === "analyze" || normalized === "analysis" || normalized === "aggregate") return "analyze"
  return null
}

export function classifyLogSeverity(line: string): LogSeverity {
  const lower = line.toLowerCase()

  if (lower.includes("fatal") || lower.includes("exception") || lower.includes("failed")) {
    return "error"
  }

  if (/\b[1-9]\d*\s+errors?\b/u.test(lower)) {
    return "error"
  }

  if (/\berror\b/u.test(lower)) {
    return "error"
  }

  if (lower.includes("warn")) return "warn"
  if (lower.includes("debug") || lower.includes("trace")) return "debug"
  return "info"
}

function compactLine(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/gu, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(max - 3, 1))}...`
}

export function normalizeSignature(line: string): string {
  return compactLine(
    line
      .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/giu, "<ts>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "<uuid>")
      .replace(/\b01[0-9A-HJKMNP-TV-Z]{24,}\b/gu, "<ulid>")
      .replace(/\b\d{6,}\b/gu, "<num>")
      .replace(/\s+/gu, " "),
    160
  )
}

function parseJsonLine(line: string): { level?: string; component?: string; action?: string; error?: string; message?: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const message = typeof parsed.message === "string"
      ? parsed.message
      : typeof parsed.detail === "string"
        ? parsed.detail
        : undefined

    return {
      level: typeof parsed.level === "string" ? parsed.level : undefined,
      component: typeof parsed.component === "string" ? parsed.component : undefined,
      action: typeof parsed.action === "string" ? parsed.action : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      message,
    }
  } catch {
    return null
  }
}

function extractComponent(line: string, parsed?: { component?: string }): string | undefined {
  if (parsed?.component && parsed.component.trim().length > 0) return parsed.component.trim()

  const regexes = [
    /\bcomponent\s*[:=]\s*([a-z0-9._/-]+)/iu,
    /\[([a-z0-9._/-]{3,})\]/iu,
  ]

  for (const regex of regexes) {
    const match = line.match(regex)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function readSnapshot(source: LogSourceKind, lines: number): SourceSnapshot {
  switch (source) {
    case "worker": {
      if (!existsSync(WORKER_LOG)) {
        return {
          source,
          label: "worker stdout",
          available: false,
          lines: [],
          error: "worker log file missing",
        }
      }
      const proc = Bun.spawnSync(["tail", `-${lines}`, WORKER_LOG], { stdout: "pipe", stderr: "pipe" })
      return {
        source,
        label: "worker stdout",
        available: proc.exitCode === 0,
        lines: proc.stdout.toString().split("\n").map((line) => line.trimEnd()).filter(Boolean),
        error: proc.exitCode === 0 ? undefined : proc.stderr.toString().trim() || "tail failed",
      }
    }
    case "errors": {
      if (!existsSync(WORKER_ERR)) {
        return {
          source,
          label: "worker stderr",
          available: false,
          lines: [],
          error: "worker error log file missing",
        }
      }
      const proc = Bun.spawnSync(["tail", `-${lines}`, WORKER_ERR], { stdout: "pipe", stderr: "pipe" })
      return {
        source,
        label: "worker stderr",
        available: proc.exitCode === 0,
        lines: proc.stdout.toString().split("\n").map((line) => line.trimEnd()).filter(Boolean),
        error: proc.exitCode === 0 ? undefined : proc.stderr.toString().trim() || "tail failed",
      }
    }
    case "server": {
      const proc = Bun.spawnSync(
        ["kubectl", "logs", "-n", "joelclaw", "statefulset/inngest", `--tail=${lines}`],
        { stdout: "pipe", stderr: "pipe" }
      )

      return {
        source,
        label: "inngest server (k8s)",
        available: proc.exitCode === 0,
        lines: proc.stdout.toString().split("\n").map((line) => line.trimEnd()).filter(Boolean),
        error: proc.exitCode === 0 ? undefined : proc.stderr.toString().trim() || "kubectl logs failed",
      }
    }
  }
}

function topEntries(map: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

export function aggregateLogSnapshots(
  snapshots: SourceSnapshot[],
  options: AggregateOptions = {}
): {
  totals: {
    lines: number
    bySeverity: Record<LogSeverity, number>
  }
  bySource: Record<string, { available: boolean; lineCount: number; error?: string }>
  topSignatures: Array<{ severity: LogSeverity; signature: string; count: number }>
  topComponents: Array<{ component: string; count: number }>
  topActions: Array<{ action: string; count: number }>
  samples: {
    errors: string[]
    warns: string[]
  }
} {
  const bySeverity: Record<LogSeverity, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  const bySource: Record<string, { available: boolean; lineCount: number; error?: string }> = {}
  const signatureCounts = new Map<string, number>()
  const componentCounts = new Map<string, number>()
  const actionCounts = new Map<string, number>()
  const errorSamples: string[] = []
  const warnSamples: string[] = []

  let totalLines = 0
  const grepFilter = options.grep?.trim().toLowerCase()

  for (const snapshot of snapshots) {
    bySource[snapshot.source] = {
      available: snapshot.available,
      lineCount: snapshot.lines.length,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    }

    for (const rawLine of snapshot.lines) {
      const line = rawLine.trim()
      if (!line) continue
      if (grepFilter && !line.toLowerCase().includes(grepFilter)) continue

      totalLines += 1
      const parsed = parseJsonLine(line)
      const severity = (parsed?.level ? classifyLogSeverity(parsed.level) : classifyLogSeverity(line))
      bySeverity[severity] += 1

      const component = extractComponent(line, parsed)
      if (component) {
        componentCounts.set(component, (componentCounts.get(component) ?? 0) + 1)
      }

      if (parsed?.action) {
        actionCounts.set(parsed.action, (actionCounts.get(parsed.action) ?? 0) + 1)
      }

      const signatureSeed = parsed?.error || parsed?.message || line
      const signature = normalizeSignature(signatureSeed)
      const signatureKey = `${severity}::${signature}`
      signatureCounts.set(signatureKey, (signatureCounts.get(signatureKey) ?? 0) + 1)

      const sample = `[${snapshot.source}] ${compactLine(line, 220)}`
      if (severity === "error" && errorSamples.length < 5) errorSamples.push(sample)
      if (severity === "warn" && warnSamples.length < 5) warnSamples.push(sample)
    }
  }

  const topSignatures = topEntries(signatureCounts, 8).map(({ key, count }) => {
    const [severityRaw, ...signatureParts] = key.split("::")
    const severity = (severityRaw as LogSeverity) ?? "info"
    return {
      severity,
      signature: signatureParts.join("::"),
      count,
    }
  })

  const topComponents = topEntries(componentCounts, 8).map(({ key, count }) => ({ component: key, count }))
  const topActions = topEntries(actionCounts, 8).map(({ key, count }) => ({ action: key, count }))

  return {
    totals: {
      lines: totalLines,
      bySeverity,
    },
    bySource,
    topSignatures,
    topComponents,
    topActions,
    samples: {
      errors: errorSamples,
      warns: warnSamples,
    },
  }
}

export const logsCmd = Command.make(
  "logs",
  {
    source: Args.text({ name: "source" }).pipe(
      Args.withDefault("worker"),
      Args.withDescription("worker | errors | server | analyze")
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
      const normalizedSource = normalizeSourceArg(source)

      if (!normalizedSource) {
        yield* Console.log(
          respondError(
            "logs",
            `Unknown source: ${source}`,
            "INVALID_SOURCE",
            "Use one of: worker, errors, server, analyze",
            [
              {
                command: "joelclaw logs <source>",
                description: "Read one source",
                params: {
                  source: {
                    description: "Log source",
                    value: "worker",
                    enum: ["worker", "errors", "server", "analyze"],
                    required: true,
                  },
                },
              },
            ]
          )
        )
        return
      }

      if (normalizedSource === "analyze") {
        if (follow) {
          yield* Console.log(
            respondError(
              "logs analyze",
              "Follow mode is not supported for aggregate analysis",
              "NOT_SUPPORTED",
              "Run snapshot analysis: joelclaw logs analyze --lines 400",
              [
                {
                  command: "joelclaw logs <source> --follow",
                  description: "Follow a single source in real time",
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
            )
          )
          return
        }

        const perSourceLines = Math.max(200, Math.min(5000, lines * 20))
        const snapshots: SourceSnapshot[] = [
          readSnapshot("worker", perSourceLines),
          readSnapshot("errors", perSourceLines),
          readSnapshot("server", perSourceLines),
        ]

        const aggregate = aggregateLogSnapshots(snapshots, { grep: grepVal })
        const topError = aggregate.topSignatures.find((entry) => entry.severity === "error")

        yield* Console.log(
          respond(
            "logs analyze",
            {
              perSourceLines,
              grep: grepVal ?? null,
              totals: aggregate.totals,
              sources: aggregate.bySource,
              topSignatures: aggregate.topSignatures,
              topComponents: aggregate.topComponents,
              topActions: aggregate.topActions,
              samples: aggregate.samples,
            },
            [
              {
                command: "joelclaw logs <source> [--grep <grep>] [--lines <lines>]",
                description: "Drill into one source",
                params: {
                  source: {
                    description: "Log source",
                    value: "errors",
                    enum: ["worker", "errors", "server"],
                    required: true,
                  },
                  ...(topError?.signature
                    ? { grep: { description: "Signature filter", value: topError.signature.slice(0, 80) } }
                    : {}),
                  lines: { description: "Line count", value: 120, default: 30 },
                },
              },
              {
                command: "joelclaw otel stats --hours <hours>",
                description: "Compare aggregate logs with OTEL error rate",
                params: {
                  hours: { description: "Lookback window", value: 24, default: 24 },
                },
              },
              {
                command: "joelclaw runs [--status <status>] [--hours <hours>]",
                description: "Check recent failed runs",
                params: {
                  status: {
                    description: "Run status filter",
                    value: "FAILED",
                    enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
                  },
                  hours: { description: "Lookback window", value: 24, default: 24 },
                },
              },
            ]
          )
        )
        return
      }

      // ── Follow mode: tail -f as NDJSON ─────────────────────────
      if (follow) {
        let logFile: string
        let label: string
        switch (normalizedSource) {
          case "errors":
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

        const cmd = `joelclaw logs ${normalizedSource} --follow`
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
                value: normalizedSource,
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

      switch (normalizedSource) {
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
        case "errors": {
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
      if (normalizedSource !== "errors") {
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
      if (normalizedSource !== "server") {
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
      if (normalizedSource !== "worker") {
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
              value: normalizedSource,
              enum: ["worker", "errors", "server"],
              required: true,
            },
            grep: { description: "Filter string", value: "error" },
          },
        })
      }
      next.push({
        command: "joelclaw logs analyze [--lines <lines>] [--grep <grep>]",
        description: "Aggregate worker/errors/server logs for trend analysis",
        params: {
          lines: { description: "Line budget per source", value: 300, default: 300 },
          ...(grepVal ? {} : { grep: { description: "Optional text filter", value: "error" } }),
        },
      })
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

      yield* Console.log(respond(`logs ${normalizedSource}`, {
        source: label,
        showing: shown.length,
        total,
        truncated,
        ...(grepVal ? { grep: grepVal } : {}),
        lines: shown,
      }, next))
    })
)
