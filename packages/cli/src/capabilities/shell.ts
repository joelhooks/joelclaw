export type CommandRunResult = {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  missingExecutable: boolean
  error?: string
}

function decodeText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value == null) return ""
  return String(value)
}

export function runCommandSync(
  command: string[],
  options: {
    timeoutMs?: number
    env?: Record<string, string | undefined>
  } = {},
): CommandRunResult {
  try {
    const proc = Bun.spawnSync(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 10_000,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })

    return {
      command,
      exitCode: proc.exitCode ?? 0,
      stdout: decodeText(proc.stdout).trim(),
      stderr: decodeText(proc.stderr).trim(),
      missingExecutable: false,
    }
  } catch (error) {
    const message = decodeText((error as { message?: unknown })?.message).trim() || String(error)
    return {
      command,
      exitCode: 127,
      stdout: "",
      stderr: message,
      error: message,
      missingExecutable: /executable not found/i.test(message),
    }
  }
}

export function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function parseJsonFromMixedOutput(...chunks: string[]): unknown | undefined {
  const joined = chunks.filter(Boolean).join("\n").trim()
  if (!joined) return undefined

  const direct = tryParseJson(joined)
  if (direct !== undefined) return direct

  const startIndex = joined.indexOf("{")
  const endIndex = joined.lastIndexOf("}")
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return undefined
  return tryParseJson(joined.slice(startIndex, endIndex + 1))
}
