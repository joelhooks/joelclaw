import { Effect, Schema } from "effect"
import { normalizeErrorCode } from "../../error-codes"
import { getRunbook, listRunbookCodes, type RunbookPhase, resolveRunbookPhase } from "../../runbooks"
import { type CapabilityPort, capabilityError } from "../contract"
import { runCommandSync } from "../shell"

const HEAL_PHASES = ["diagnose", "fix", "verify", "rollback", "all"] as const

type HealPhase = (typeof HEAL_PHASES)[number]

type HealExecutionRecord = {
  readonly phase: RunbookPhase
  readonly description: string
  readonly command: string
  readonly destructive: boolean
  readonly ok: boolean
  readonly exitCode: number
  readonly output: string
  readonly error?: string
}

const HealListArgsSchema = Schema.Struct({})

const HealListResultSchema = Schema.Struct({
  backend: Schema.String,
  count: Schema.Number,
  runbooks: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      title: Schema.String,
      summary: Schema.String,
      severity: Schema.String,
    })
  ),
})

const HealRunArgsSchema = Schema.Struct({
  code: Schema.String,
  phase: Schema.optional(Schema.Literal(...HEAL_PHASES)),
  context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  execute: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Number),
  maxOutputLines: Schema.optional(Schema.Number),
})

const HealRunResultSchema = Schema.Struct({
  backend: Schema.String,
  mode: Schema.Literal("dry-run", "executed"),
  code: Schema.String,
  phase: Schema.Literal(...HEAL_PHASES),
  title: Schema.String,
  summary: Schema.String,
  severity: Schema.String,
  details: Schema.Unknown,
  ok: Schema.optional(Schema.Boolean),
})

const commands = {
  list: {
    summary: "List deterministic heal runbooks",
    argsSchema: HealListArgsSchema,
    resultSchema: HealListResultSchema,
  },
  run: {
    summary: "Plan or execute deterministic heal runbook phases",
    argsSchema: HealRunArgsSchema,
    resultSchema: HealRunResultSchema,
  },
} as const

type HealCommandName = keyof typeof commands

function decodeArgs<K extends HealCommandName>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "HEAL_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw heal ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function phasesFor(phase: HealPhase): readonly RunbookPhase[] {
  if (phase === "all") {
    return ["diagnose", "fix", "verify"]
  }
  return [phase]
}

function hasUnresolvedPlaceholder(command: string): boolean {
  return /<[^>]+>/.test(command)
}

function normalizeContext(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {}
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 20_000
  return Math.max(1_000, Math.floor(value))
}

function normalizeMaxOutputLines(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 40
  return Math.max(5, Math.floor(value))
}

function truncateOutput(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
  if (lines.length <= maxLines) {
    return lines.join("\n")
  }
  return `${lines.slice(-maxLines).join("\n")}\n...(${lines.length - maxLines} lines truncated)`
}

function executeShell(command: string, timeoutMs: number, maxOutputLines: number): {
  ok: boolean
  exitCode: number
  output: string
  error?: string
} {
  const proc = runCommandSync(["zsh", "-lc", command], {
    timeoutMs,
    env: { TERM: "dumb" },
  })

  const combined = [proc.stdout, proc.stderr].filter(Boolean).join("\n").trim()
  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    output: truncateOutput(combined, maxOutputLines),
    ...(proc.exitCode !== 0
      ? {
          error: proc.error ?? proc.stderr ?? "command failed",
        }
      : {}),
  }
}

function buildDryRunPreview(
  runbookCode: string,
  phase: HealPhase,
  phases: readonly RunbookPhase[],
  context: Record<string, unknown>,
) {
  return Object.fromEntries(
    phases.map((activePhase) => {
      const entries = resolveRunbookPhase(getRunbook(runbookCode)!, activePhase, context).map((entry) => ({
        description: entry.description,
        command: entry.command,
        resolvedCommand: entry.resolvedCommand,
        destructive: entry.destructive ?? false,
        hasUnresolvedPlaceholder: hasUnresolvedPlaceholder(entry.resolvedCommand),
      }))

      return [activePhase, entries]
    })
  )
}

export const runbookHealAdapter: CapabilityPort<typeof commands> = {
  capability: "heal",
  adapter: "runbook-heal",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "list": {
          const _args = yield* decodeArgs("list", rawArgs)
          const runbooks = listRunbookCodes()
            .map((code) => getRunbook(code))
            .filter((runbook): runbook is NonNullable<typeof runbook> => runbook !== null)
            .map((runbook) => ({
              code: runbook.code,
              title: runbook.title,
              summary: runbook.summary,
              severity: runbook.severity,
            }))

          return {
            backend: "runbook-heal",
            count: runbooks.length,
            runbooks,
          }
        }

        case "run": {
          const args = yield* decodeArgs("run", rawArgs)
          const normalizedCode = normalizeErrorCode(args.code)
          const runbook = getRunbook(normalizedCode)

          if (!runbook) {
            return yield* Effect.fail(
              capabilityError(
                "HEAL_RUNBOOK_NOT_FOUND",
                `Runbook not found for error code: ${normalizedCode}`,
                `Use one of: ${listRunbookCodes().join(", ")}`
              )
            )
          }

          const phase = (args.phase ?? "fix") as HealPhase
          const phases = phasesFor(phase)
          const context = normalizeContext(args.context)
          const execute = args.execute === true

          if (!execute) {
            const preview = buildDryRunPreview(runbook.code, phase, phases, context)
            return {
              backend: "runbook-heal",
              mode: "dry-run" as const,
              code: runbook.code,
              phase,
              title: runbook.title,
              summary: runbook.summary,
              severity: runbook.severity,
              details: {
                preview,
              },
            }
          }

          const timeoutMs = normalizeTimeoutMs(args.timeoutMs)
          const maxOutputLines = normalizeMaxOutputLines(args.maxOutputLines)
          const executed: HealExecutionRecord[] = []
          let allOk = true

          for (const activePhase of phases) {
            const entries = resolveRunbookPhase(runbook, activePhase, context)
            for (const entry of entries) {
              if (hasUnresolvedPlaceholder(entry.resolvedCommand)) {
                const failure = {
                  phase: activePhase,
                  description: entry.description,
                  command: entry.resolvedCommand,
                  destructive: entry.destructive ?? false,
                  ok: false,
                  exitCode: 2,
                  output: "",
                  error: "unresolved placeholders in command",
                } satisfies HealExecutionRecord

                executed.push(failure)
                allOk = false
                break
              }

              const result = executeShell(entry.resolvedCommand, timeoutMs, maxOutputLines)
              executed.push({
                phase: activePhase,
                description: entry.description,
                command: entry.resolvedCommand,
                destructive: entry.destructive ?? false,
                ok: result.ok,
                exitCode: result.exitCode,
                output: result.output,
                ...(result.error ? { error: result.error } : {}),
              })

              if (!result.ok) {
                allOk = false
                break
              }
            }

            if (!allOk) break
          }

          if (!allOk) {
            const failedStep = executed.find((entry) => !entry.ok)
            const failureDetail = failedStep
              ? `${failedStep.phase}:${failedStep.command} (${failedStep.error ?? `exit ${failedStep.exitCode}`})`
              : "unknown failure"

            return yield* Effect.fail(
              capabilityError(
                "HEAL_EXECUTION_FAILED",
                `Heal execution failed for ${runbook.code}: ${failureDetail}`,
                "Inspect the failed step, then re-run with --phase diagnose or --phase rollback."
              )
            )
          }

          return {
            backend: "runbook-heal",
            mode: "executed" as const,
            code: runbook.code,
            phase,
            title: runbook.title,
            summary: runbook.summary,
            severity: runbook.severity,
            details: {
              executed,
            },
            ok: true,
          }
        }

        default:
          return yield* Effect.fail(
            capabilityError(
              "HEAL_SUBCOMMAND_UNSUPPORTED",
              `Unsupported heal subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __healAdapterTestUtils = {
  phasesFor,
  hasUnresolvedPlaceholder,
  truncateOutput,
  normalizeTimeoutMs,
  normalizeMaxOutputLines,
}
