/**
 * HATEOAS-style response envelope for agent consumers.
 * Every command returns this shape — agents always know what to do next.
 */

export interface NextAction {
  readonly command: string
  readonly description: string
}

export interface JoelclawResponse {
  readonly ok: boolean
  readonly command: string
  readonly result: unknown
  readonly error?: { message: string; code: string }
  readonly fix?: string
  readonly next_actions: readonly NextAction[]
}

const normalizeCommand = (command: string): string => {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return "joelclaw"
  }
  if (trimmed.startsWith("joelclaw ")) {
    return trimmed
  }
  if (trimmed === "joelclaw") {
    return trimmed
  }
  if (trimmed.startsWith("igs ")) {
    return `joelclaw ${trimmed.slice(4)}`
  }
  if (trimmed === "igs") {
    return "joelclaw"
  }
  return `joelclaw ${trimmed}`
}

export const respond = (
  command: string,
  result: unknown,
  nextActions: readonly NextAction[],
  ok = true
): string =>
  JSON.stringify(
    {
      ok,
      command: normalizeCommand(command),
      result,
      next_actions: nextActions.map((action) => ({
        ...action,
        command: normalizeCommand(action.command),
      })),
    } satisfies JoelclawResponse,
    null,
    2
  )

export const respondError = (
  command: string,
  message: string,
  code: string,
  fix: string,
  nextActions: readonly NextAction[],
): string =>
  JSON.stringify(
    {
      ok: false,
      command: normalizeCommand(command),
      result: null,
      error: { message, code },
      fix,
      next_actions: nextActions.map((action) => ({
        ...action,
        command: normalizeCommand(action.command),
      })),
    } satisfies JoelclawResponse,
    null,
    2
  )
