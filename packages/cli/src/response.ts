/**
 * HATEOAS-style response envelope for agent consumers.
 * Every command returns this shape — agents always know what to do next.
 *
 * next_actions use standard CLI template syntax (POSIX/docopt conventions):
 *   <required>    — required positional argument
 *   [--flag]      — optional boolean flag
 *   [--flag <v>]  — optional flag with value
 *
 * When `params` is present, `command` is a template. Agent fills placeholders.
 * When `params` is absent, `command` is a literal. Agent runs it as-is.
 * When a param has `value`, it's pre-filled from context (agent can override).
 */

export interface NextActionParam {
  readonly description?: string
  /** Pre-filled value from current context */
  readonly value?: string | number
  /** Default if omitted */
  readonly default?: string | number
  /** Valid choices */
  readonly enum?: readonly string[]
  /** Is this param required? (positional args with <brackets> are required) */
  readonly required?: boolean
}

export interface NextAction {
  /** Command template (POSIX syntax) or literal command if no params */
  readonly command: string
  readonly description: string
  /** Placeholder descriptions — presence indicates command is a template */
  readonly params?: Record<string, NextActionParam>
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
  if (trimmed === "joelclaw" || trimmed.startsWith("joelclaw ")) {
    return trimmed
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
