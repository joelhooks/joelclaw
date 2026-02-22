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
 * TOON support (spike): pass --toon flag to encode the result field in
 * Token-Oriented Object Notation for ~40% token savings on array data.
 * Envelope (ok, command, next_actions) stays JSON. Only result changes.
 * Revert: remove @toon-format/toon dep and toonEnabled/encodeToon code.
 */

import { encode as toonEncode } from "@toon-format/toon"

/** TOON is default. Pass --json to get plain JSON output. */
export const toonEnabled = !process.argv.includes("--json")

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
  next_actions: normalizeNextActions(nextActions),
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

  if (toonEnabled) {
    // Hybrid output: JSON envelope with TOON-encoded result
    // Envelope stays JSON for parseability, result gets token savings
    let toonResult: string
    try {
      toonResult = toonEncode(result as Record<string, unknown>)
    } catch {
      // Fall back to JSON if TOON can't encode (primitives, etc.)
      toonResult = JSON.stringify(result, null, 2)
    }

    return JSON.stringify(
      {
        ok: envelope.ok,
        command: envelope.command,
        result_format: "toon" as const,
        next_actions: envelope.next_actions,
      },
      null,
      2
    ) + "\n---TOON---\n" + toonResult
  }

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
