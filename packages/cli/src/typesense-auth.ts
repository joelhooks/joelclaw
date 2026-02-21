import { execSync } from "node:child_process"

type TypesenseApiKeyErrorCode =
  | "TYPESENSE_API_KEY_MISSING"
  | "SECRETS_DAEMON_UNAVAILABLE"
  | "SECRETS_LEASE_FAILED"

type SecretsLeaseErrorShape = {
  message?: unknown
  code?: unknown
}

type SecretsLeaseResponse = {
  ok?: unknown
  result?: unknown
  value?: unknown
  token?: unknown
  secret?: unknown
  data?: unknown
  error?: SecretsLeaseErrorShape | string
}

export class TypesenseApiKeyError extends Error {
  constructor(
    readonly code: TypesenseApiKeyErrorCode,
    message: string,
    readonly fix: string
  ) {
    super(message)
    this.name = "TypesenseApiKeyError"
  }
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value == null) return ""
  return String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isDaemonUnavailable(text: string): boolean {
  return /(failed to connect to daemon|daemon unreachable|daemon unavailable|connection refused|econnrefused|connect.*daemon)/iu.test(
    text
  )
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function looksLikeJsonBlob(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function looksLikeToken(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 16) return false
  if (/\s/u.test(trimmed)) return false
  if (/error|failed|daemon|unavailable|invalid|exception/iu.test(trimmed)) return false
  return true
}

function tokenFromParsedLease(parsed: SecretsLeaseResponse): string | null {
  const direct = asString(parsed.result)
    ?? asString(parsed.value)
    ?? asString(parsed.token)
    ?? asString(parsed.secret)
  if (direct && !looksLikeJsonBlob(direct)) return direct

  if (isRecord(parsed.data)) {
    const nested = asString(parsed.data.result)
      ?? asString(parsed.data.value)
      ?? asString(parsed.data.token)
      ?? asString(parsed.data.secret)
    if (nested && !looksLikeJsonBlob(nested)) return nested
  }

  return null
}

function errorFromParsedLease(parsed: SecretsLeaseResponse): TypesenseApiKeyError | null {
  const rawError = parsed.error
  const hasExplicitFailure = parsed.ok === false
  const errorMessage =
    typeof rawError === "string" && rawError.trim().length > 0
      ? rawError.trim()
      : isRecord(rawError) && typeof rawError.message === "string" && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : null
  if (!hasExplicitFailure && !errorMessage) return null

  const message = errorMessage ?? "agent-secrets failed to lease typesense_api_key"

  if (isDaemonUnavailable(message)) {
    return new TypesenseApiKeyError(
      "SECRETS_DAEMON_UNAVAILABLE",
      message,
      "Restart agent-secrets and verify health: launchctl kickstart -k gui/$(id -u)/com.joel.agent-secrets && secrets health"
    )
  }

  return new TypesenseApiKeyError(
    "SECRETS_LEASE_FAILED",
    message,
    "Verify `secrets lease typesense_api_key --ttl 15m` returns a token, or set TYPESENSE_API_KEY directly"
  )
}

function parseLeaseOutput(rawOutput: string): { token?: string; error?: TypesenseApiKeyError } {
  const output = rawOutput.trim()
  if (!output) {
    return {
      error: new TypesenseApiKeyError(
        "SECRETS_LEASE_FAILED",
        "agent-secrets returned an empty response while leasing typesense_api_key",
        "Verify `secrets lease typesense_api_key --ttl 15m` returns a token, or set TYPESENSE_API_KEY directly"
      ),
    }
  }

  const looksJson = output.startsWith("{") || output.startsWith("[") || (output.includes("\"ok\"") && output.includes("{"))
  if (!looksJson) {
    if (isDaemonUnavailable(output)) {
      return {
        error: new TypesenseApiKeyError(
          "SECRETS_DAEMON_UNAVAILABLE",
          output,
          "Restart agent-secrets and verify health: launchctl kickstart -k gui/$(id -u)/com.joel.agent-secrets && secrets health"
        ),
      }
    }
    if (!looksLikeToken(output)) {
      return {
        error: new TypesenseApiKeyError(
          "SECRETS_LEASE_FAILED",
          output.slice(0, 180),
          "Verify `secrets lease typesense_api_key --ttl 15m` returns a token, or set TYPESENSE_API_KEY directly"
        ),
      }
    }
    return { token: output }
  }

  try {
    const parsed = JSON.parse(output) as SecretsLeaseResponse
    const parsedError = errorFromParsedLease(parsed)
    if (parsedError) return { error: parsedError }

    const token = tokenFromParsedLease(parsed)
    if (token) return { token }

    return {
      error: new TypesenseApiKeyError(
        "SECRETS_LEASE_FAILED",
        "agent-secrets returned JSON without a token for typesense_api_key",
        "Verify `secrets lease typesense_api_key --ttl 15m` output format, or set TYPESENSE_API_KEY directly"
      ),
    }
  } catch {
    return {
      error: new TypesenseApiKeyError(
        "SECRETS_LEASE_FAILED",
        output.slice(0, 180),
        "Verify `secrets lease typesense_api_key --ttl 15m` returns a token, or set TYPESENSE_API_KEY directly"
      ),
    }
  }
}

export function isTypesenseApiKeyError(error: unknown): error is TypesenseApiKeyError {
  return error instanceof TypesenseApiKeyError
}

export function resolveTypesenseApiKey(): string {
  const envKey = process.env.TYPESENSE_API_KEY?.trim()
  if (envKey) return envKey

  try {
    const output = execSync("secrets lease typesense_api_key --ttl 15m", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const parsed = parseLeaseOutput(output)
    if (parsed.error) throw parsed.error
    if (parsed.token) return parsed.token
  } catch (error) {
    if (error instanceof TypesenseApiKeyError) throw error

    const stdout = readShellText((error as { stdout?: unknown })?.stdout).trim()
    const stderr = readShellText((error as { stderr?: unknown })?.stderr).trim()
    const combined = [stderr, stdout].filter(Boolean).join("\n")

    const parsed = parseLeaseOutput(combined)
    if (parsed.error) throw parsed.error

    if (isDaemonUnavailable(combined)) {
      throw new TypesenseApiKeyError(
        "SECRETS_DAEMON_UNAVAILABLE",
        combined || "agent-secrets daemon unavailable",
        "Restart agent-secrets and verify health: launchctl kickstart -k gui/$(id -u)/com.joel.agent-secrets && secrets health"
      )
    }

    throw new TypesenseApiKeyError(
      "SECRETS_LEASE_FAILED",
      combined || "Failed to lease typesense_api_key",
      "Verify `secrets lease typesense_api_key --ttl 15m` returns a token, or set TYPESENSE_API_KEY directly"
    )
  }

  throw new TypesenseApiKeyError(
    "TYPESENSE_API_KEY_MISSING",
    "TYPESENSE_API_KEY is not set and no token was leased from agent-secrets",
    "Set TYPESENSE_API_KEY or run `secrets lease typesense_api_key --ttl 15m` and verify the daemon is healthy"
  )
}
