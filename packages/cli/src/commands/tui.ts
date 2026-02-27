import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

const WS_PORT_FILE = "/tmp/joelclaw/gateway.ws.port"
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000
const TOOL_RESULT_LIMIT = 500

const urlOption = Options.text("url").pipe(
  Options.withDescription("Gateway websocket URL (default: reads /tmp/joelclaw/gateway.ws.port)"),
  Options.optional,
)

const observeOption = Options.boolean("observe").pipe(
  Options.withDescription("Observe-only mode (cannot send prompts)"),
  Options.withDefault(false),
)

type StatusPayload = {
  sessionId?: string
  isStreaming?: boolean
  model?: string
  uptimeMs?: number
  pid?: number
  channelInfo?: unknown
  queueDepth?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveUrl(url: { _tag: "None" } | { _tag: "Some"; value: string }): Promise<string> {
  if (url._tag === "Some") return url.value

  const portText = (await readFile(WS_PORT_FILE, "utf8")).trim()
  const port = Number.parseInt(portText, 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid gateway WS port file: ${WS_PORT_FILE}`)
  }

  return `ws://127.0.0.1:${port}`
}

function truncateText(text: string, max = TOOL_RESULT_LIMIT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}... [truncated]`
}

function extractToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : JSON.stringify(content)
  }

  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") {
      parts.push(String(item))
      continue
    }

    const typed = item as { type?: string; text?: string }
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text)
      continue
    }

    parts.push(JSON.stringify(item))
  }

  return parts.join("\n")
}

function formatUptime(uptimeMs: number | undefined): string {
  if (!uptimeMs || uptimeMs <= 0) return "0s"

  const total = Math.floor(uptimeMs / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function printStatus(status: StatusPayload): void {
  const nextActions = [
    { command: "joelclaw tui", description: "Attach this terminal to the gateway session" },
    { command: "joelclaw gateway status", description: "Check Redis gateway channel health" },
    { command: "joelclaw gateway restart", description: "Restart the gateway daemon" },
  ]

  console.log(respond("tui status", {
    sessionId: status.sessionId ?? "unknown",
    model: status.model ?? "unknown",
    isStreaming: Boolean(status.isStreaming),
    queueDepth: status.queueDepth ?? 0,
    uptime: formatUptime(status.uptimeMs),
    pid: status.pid ?? "unknown",
    channelInfo: status.channelInfo ?? {},
  }, nextActions))
}

function isStatusPayload(value: unknown): value is { data: StatusPayload } {
  return Boolean(value) && typeof value === "object" && "data" in value
}

export const tuiCmd = Command.make("tui", {
  url: urlOption,
  observe: observeOption,
}, ({ url, observe }) =>
  Effect.gen(function* () {
    const wsUrl = yield* Effect.tryPromise({
      try: () => resolveUrl(url),
      catch: (error) => new Error(`Unable to resolve gateway URL: ${error}`),
    })

    let shouldExit = false
    let backoffMs = MIN_BACKOFF_MS

    while (!shouldExit) {
      const reconnectMessage = observe
        ? `[tui] connecting (observe) ${wsUrl}`
        : `[tui] connecting ${wsUrl}`
      yield* Console.log(reconnectMessage)

      const runResult = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ shouldReconnect: boolean }>((resolve) => {
            const ws = new WebSocket(wsUrl)
            let connected = false
            let streamOpen = false
            let finished = false
            const connectTimeout = setTimeout(() => {
              if (!connected && ws.readyState !== WebSocket.CLOSED) {
                process.stdout.write(`[tui] connect timeout ${wsUrl}\\n`)
                ws.close()
              }
            }, 10_000)

            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
              terminal: true,
              prompt: observe ? "observe> " : "you> ",
            })

            const send = (payload: Record<string, unknown>) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload))
              }
            }

            const cleanupAndResolve = (shouldReconnect: boolean) => {
              if (finished) return
              finished = true
              clearTimeout(connectTimeout)
              try {
                rl.close()
              } catch {}
              resolve({ shouldReconnect })
            }

            rl.on("line", (line) => {
              const text = line.trim()
              if (!text) {
                if (connected) rl.prompt()
                return
              }

              if (text === "/quit" || text === "/exit") {
                shouldExit = true
                ws.close()
                cleanupAndResolve(false)
                return
              }

              if (text === "/status") {
                send({ type: "status" })
                if (connected) rl.prompt()
                return
              }

              if (text === "/abort") {
                if (observe) {
                  process.stdout.write("[tui] observe mode: abort disabled\\n")
                } else {
                  send({ type: "abort" })
                }
                if (connected) rl.prompt()
                return
              }

              if (observe) {
                process.stdout.write("[tui] observe mode: prompt sending disabled\\n")
                if (connected) rl.prompt()
                return
              }

              send({ type: "prompt", text })
            })

            ws.onopen = () => {
              connected = true
              backoffMs = MIN_BACKOFF_MS
              process.stdout.write(`[tui] connected ${wsUrl}\\n`)
              send({ type: "status" })
              rl.prompt()
            }

            ws.onerror = () => {
              if (!connected) {
                process.stdout.write(`[tui] connection failed ${wsUrl}\\n`)
              }
            }

            ws.onmessage = (event) => {
              try {
                const message = JSON.parse(String(event.data)) as Record<string, unknown>
                const messageType = typeof message.type === "string" ? message.type : "unknown"

                if (messageType === "text_delta") {
                  const delta = typeof message.delta === "string" ? message.delta : ""
                  if (delta.length > 0) {
                    streamOpen = true
                    process.stdout.write(delta)
                  }
                  return
                }

                if (messageType === "tool_call") {
                  const toolName = typeof message.toolName === "string" ? message.toolName : "tool"
                  const input = message.input
                  const commandText = typeof input === "object" && input && "command" in (input as any)
                    ? String((input as any).command)
                    : JSON.stringify(input)
                  process.stdout.write(`\\n\\x1b[2m[tool: ${toolName}] ${truncateText(commandText, 200)}\\x1b[0m\\n`)
                  return
                }

                if (messageType === "tool_result") {
                  const resultText = truncateText(extractToolContent(message.content))
                  process.stdout.write(`\\n${resultText}\\n`)
                  return
                }

                if (messageType === "turn_end") {
                  if (streamOpen) {
                    process.stdout.write("\\n")
                    streamOpen = false
                  }
                  process.stdout.write("\\n----------------------------------------\\n")
                  rl.prompt()
                  return
                }

                if (messageType === "status" && isStatusPayload(message)) {
                  if (streamOpen) process.stdout.write("\\n")
                  printStatus(message.data)
                  rl.prompt()
                  return
                }

                if (messageType === "error") {
                  const msg = typeof message.message === "string" ? message.message : "Unknown gateway error"
                  process.stdout.write(`\\n[tui] error: ${msg}\\n`)
                  rl.prompt()
                  return
                }
              } catch (error) {
                process.stdout.write(`\\n[tui] message parse error: ${error}\\n`)
              }
            }

            ws.onclose = () => {
              if (shouldExit) {
                cleanupAndResolve(false)
                return
              }

              process.stdout.write("\\n[tui] disconnected from gateway\\n")
              cleanupAndResolve(true)
            }
          }),
        catch: (error) => new Error(`${error}`),
      })

      if (shouldExit) break
      if (!runResult.shouldReconnect) break

      yield* Console.log(`[tui] reconnecting in ${Math.round(backoffMs / 1000)}s...`)
      yield* Effect.tryPromise({
        try: () => sleep(backoffMs),
        catch: () => new Error("Reconnect sleep interrupted"),
      })
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  })
)
