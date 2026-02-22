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
 *
 */

import { normalizeErrorCode } from "./error-codes"
import { getRunbook } from "./runbooks"

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

export interface JoelclawEnvelope {
  readonly ok: boolean
  readonly command: string
  readonly result: unknown
  readonly error?: { message: string; code: string }
  readonly fix?: string
  readonly next_actions: readonly NextAction[]
}

export interface EnvelopeValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

const RECOVER_PHASES = ["diagnose", "fix", "verify", "rollback", "all"] as const

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

const normalizeNextActions = (nextActions: readonly NextAction[]): readonly NextAction[] =>
  nextActions.map((action) => ({
    ...action,
    command: normalizeCommand(action.command),
  }))

function hasRecoverAction(nextActions: readonly NextAction[]): boolean {
  return nextActions.some((action) => normalizeCommand(action.command).startsWith("joelclaw recover"))
}

function recoverActionForCode(code: string): NextAction | null {
  const normalizedCode = normalizeErrorCode(code)
  const runbook = getRunbook(normalizedCode)
  if (!runbook) return null

  return {
    command: "recover <error-code> [--phase <phase>] [--context <context>]",
    description: `Preview deterministic recovery runbook for ${runbook.code}`,
    params: {
      "error-code": {
        description: "Runbook error code",
        value: runbook.code,
        required: true,
      },
      phase: {
        description: "Runbook phase",
        value: "fix",
        enum: RECOVER_PHASES,
      },
      context: {
        description: "Optional JSON context for command placeholders",
        value: "{}",
        default: "{}",
      },
    },
  }
}

export function withRecoverNextActions(
  code: string,
  nextActions: readonly NextAction[]
): readonly NextAction[] {
  if (hasRecoverAction(nextActions)) return nextActions
  const recoverAction = recoverActionForCode(code)
  if (!recoverAction) return nextActions
  return [...nextActions, recoverAction]
}

export const buildSuccessEnvelope = (
  command: string,
  result: unknown,
  nextActions: readonly NextAction[],
  ok = true
): JoelclawEnvelope => ({
  ok,
  command: normalizeCommand(command),
  result,
  next_actions: normalizeNextActions(nextActions),
})

export const buildErrorEnvelope = (
  command: string,
  message: string,
  code: string,
  fix: string,
  nextActions: readonly NextAction[],
): JoelclawEnvelope => ({
  ok: false,
  command: normalizeCommand(command),
  result: null,
  error: { message, code },
  fix,
  next_actions: normalizeNextActions(withRecoverNextActions(code, nextActions)),
})

export const validateJoelclawEnvelope = (value: unknown): EnvelopeValidationResult => {
  const errors: string[] = []

  if (!value || typeof value !== "object") {
    return { valid: false, errors: ["Envelope must be an object"] }
  }

  const envelope = value as Record<string, unknown>

  if (typeof envelope.ok !== "boolean") {
    errors.push("ok must be boolean")
  }

  if (typeof envelope.command !== "string" || envelope.command.trim().length === 0) {
    errors.push("command must be non-empty string")
  }

  if (!("result" in envelope)) {
    errors.push("result field is required")
  }

  if (!Array.isArray(envelope.next_actions)) {
    errors.push("next_actions must be an array")
  } else {
    envelope.next_actions.forEach((action, index) => {
      if (!action || typeof action !== "object") {
        errors.push(`next_actions[${index}] must be an object`)
        return
      }
      const a = action as Record<string, unknown>
      if (typeof a.command !== "string" || a.command.trim().length === 0) {
        errors.push(`next_actions[${index}].command must be non-empty string`)
      }
      if (typeof a.description !== "string" || a.description.trim().length === 0) {
        errors.push(`next_actions[${index}].description must be non-empty string`)
      }
    })
  }

  if ("error" in envelope && envelope.error != null) {
    if (!envelope.error || typeof envelope.error !== "object") {
      errors.push("error must be an object when present")
    } else {
      const e = envelope.error as Record<string, unknown>
      if (typeof e.message !== "string" || e.message.trim().length === 0) {
        errors.push("error.message must be non-empty string")
      }
      if (typeof e.code !== "string" || e.code.trim().length === 0) {
        errors.push("error.code must be non-empty string")
      }
    }
    if (typeof envelope.fix !== "string" || envelope.fix.trim().length === 0) {
      errors.push("fix must be non-empty string when error is present")
    }
  }

  return { valid: errors.length === 0, errors }
}

export const respond = (
  command: string,
  result: unknown,
  nextActions: readonly NextAction[],
  ok = true
): string => {
  const envelope = buildSuccessEnvelope(command, result, nextActions, ok)
  return JSON.stringify(envelope satisfies JoelclawEnvelope, null, 2)
}

export const respondError = (
  command: string,
  message: string,
  code: string,
  fix: string,
  nextActions: readonly NextAction[],
): string =>
  JSON.stringify(
    buildErrorEnvelope(command, message, code, fix, nextActions) satisfies JoelclawEnvelope,
    null,
    2
  )
