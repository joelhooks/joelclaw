import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { execSync } from "node:child_process"
import { normalizeErrorCode } from "../error-codes"
import {
  getRunbook,
  listRunbookCodes,
  resolveRunbookPhase,
  type RunbookPhase,
} from "../runbooks"
import { respond, respondError } from "../response"

type RecoverPhase = RunbookPhase | "all"

type CommandExecution = {
  readonly phase: RunbookPhase
  readonly description: string
  readonly command: string
  readonly destructive: boolean
  readonly ok: boolean
  readonly exitCode: number
  readonly output: string
  readonly error?: string
}

function normalizePhase(value: string): RecoverPhase | null {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "diagnose"
    || normalized === "fix"
    || normalized === "verify"
    || normalized === "rollback"
    || normalized === "all"
  ) {
    return normalized
  }
  return null
}

function parseContext(raw: string): { ok: true; context: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "--context must decode to a JSON object" }
    }
    return { ok: true, context: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: `Invalid JSON in --context: ${error}` }
  }
}

function truncateOutput(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/).filter(Boolean)
  if (lines.length <= maxLines) return lines.join("\n")
  return `${lines.slice(-maxLines).join("\n")}\n...(${lines.length - maxLines} lines truncated)`
}

function hasUnresolvedPlaceholder(command: string): boolean {
  return /<[^>]+>/.test(command)
}

function executeShell(command: string, timeoutMs: number, maxOutputLines: number): {
  ok: boolean
  exitCode: number
  output: string
  error?: string
} {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    })

    return {
      ok: true,
      exitCode: 0,
      output: truncateOutput(stdout.trim(), maxOutputLines),
    }
  } catch (error) {
    const err = error as {
      status?: number
      message?: string
      stderr?: Buffer | string
      stdout?: Buffer | string
    }

    const stderr = typeof err.stderr === "string"
      ? err.stderr
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf-8")
        : ""
    const stdout = typeof err.stdout === "string"
      ? err.stdout
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf-8")
        : ""

    return {
      ok: false,
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: truncateOutput([stdout, stderr].filter(Boolean).join("\n").trim(), maxOutputLines),
      error: err.message ?? "command failed",
    }
  }
}

function phasesFor(phase: RecoverPhase): readonly RunbookPhase[] {
  if (phase === "all") {
    return ["diagnose", "fix", "verify"]
  }
  return [phase]
}

const codeArg = Args.text({ name: "error-code" }).pipe(
  Args.withDescription("Error code (e.g. TYPESENSE_UNREACHABLE) or 'list'")
)

const executeOpt = Options.boolean("execute").pipe(
  Options.withDefault(false),
  Options.withDescription("Execute runbook commands (default is dry-run)")
)

const phaseOpt = Options.text("phase").pipe(
  Options.withDefault("fix"),
  Options.withDescription("Runbook phase: diagnose|fix|verify|rollback|all")
)

const contextOpt = Options.text("context").pipe(
  Options.withDefault("{}"),
  Options.withDescription("JSON object for placeholder substitution, e.g. '{\"run-id\":\"...\"}'")
)

const timeoutOpt = Options.integer("timeout-ms").pipe(
  Options.withDefault(20_000),
  Options.withDescription("Per-command timeout when --execute is used")
)

const maxOutputLinesOpt = Options.integer("max-output-lines").pipe(
  Options.withDefault(40),
  Options.withDescription("Max output lines captured per executed command")
)

export const recoverCmd = Command.make(
  "recover",
  {
    code: codeArg,
    execute: executeOpt,
    phase: phaseOpt,
    context: contextOpt,
    timeoutMs: timeoutOpt,
    maxOutputLines: maxOutputLinesOpt,
  },
  ({ code, execute, phase, context, timeoutMs, maxOutputLines }) =>
    Effect.gen(function* () {
      const normalizedCode = normalizeErrorCode(code)

      if (normalizedCode === "LIST") {
        const codes = listRunbookCodes()
        yield* Console.log(respond("recover", {
          description: "Deterministic error recovery runbooks",
          count: codes.length,
          codes,
        }, [
          {
            command: "recover <error-code> [--phase <phase>]",
            description: "Preview runbook steps (dry-run)",
            params: {
              "error-code": { description: "Runbook error code", value: codes[0] ?? "TYPESENSE_UNREACHABLE", required: true },
              phase: { description: "Phase to preview", value: "fix", enum: ["diagnose", "fix", "verify", "rollback", "all"] },
            },
          },
        ]))
        return
      }

      const runbook = getRunbook(normalizedCode)
      if (!runbook) {
        yield* Console.log(respondError(
          "recover",
          `Runbook not found for error code: ${normalizedCode}`,
          "RUNBOOK_NOT_FOUND",
          `Use one of: ${listRunbookCodes().join(", ")}`,
          [
            { command: "recover list", description: "List supported runbook codes" },
            { command: "capabilities", description: "Discover operational command flows" },
          ],
        ))
        return
      }

      const parsedContext = parseContext(context)
      if (!parsedContext.ok) {
        yield* Console.log(respondError(
          "recover",
          parsedContext.error,
          "INVALID_CONTEXT_JSON",
          "Pass --context as a valid JSON object",
          [
            {
              command: "recover <error-code> --context <context>",
              description: "Retry with valid JSON context",
              params: {
                "error-code": { value: normalizedCode, required: true },
                context: { value: "{}" },
              },
            },
          ],
        ))
        return
      }

      const normalizedPhase = normalizePhase(phase)
      if (!normalizedPhase) {
        yield* Console.log(respondError(
          "recover",
          `Invalid phase: ${phase}`,
          "INVALID_RECOVER_PHASE",
          "Use one of diagnose|fix|verify|rollback|all",
          [
            {
              command: "recover <error-code> --phase <phase>",
              description: "Retry with a valid phase",
              params: {
                "error-code": { value: normalizedCode, required: true },
                phase: { value: "fix", enum: ["diagnose", "fix", "verify", "rollback", "all"] },
              },
            },
          ],
        ))
        return
      }

      const phases = phasesFor(normalizedPhase)

      if (!execute) {
        const preview = Object.fromEntries(
          phases.map((activePhase) => [
            activePhase,
            resolveRunbookPhase(runbook, activePhase, parsedContext.context).map((entry) => ({
              description: entry.description,
              command: entry.command,
              resolvedCommand: entry.resolvedCommand,
              destructive: entry.destructive ?? false,
              hasUnresolvedPlaceholder: hasUnresolvedPlaceholder(entry.resolvedCommand),
            })),
          ])
        )

        yield* Console.log(respond("recover", {
          mode: "dry-run",
          code: runbook.code,
          title: runbook.title,
          summary: runbook.summary,
          severity: runbook.severity,
          phase: normalizedPhase,
          preview,
        }, [
          {
            command: "recover <error-code> --phase <phase> --execute [--context <context>]",
            description: "Execute runbook phase commands",
            params: {
              "error-code": { value: runbook.code, required: true },
              phase: { value: normalizedPhase === "all" ? "fix" : normalizedPhase, enum: ["diagnose", "fix", "verify", "rollback", "all"] },
              context: { value: context, default: "{}" },
            },
          },
          { command: "status", description: "Check system health before running fixes" },
        ]))
        return
      }

      const executed: CommandExecution[] = []
      let allOk = true

      for (const activePhase of phases) {
        const phaseEntries = resolveRunbookPhase(runbook, activePhase, parsedContext.context)
        for (const entry of phaseEntries) {
          if (hasUnresolvedPlaceholder(entry.resolvedCommand)) {
            executed.push({
              phase: activePhase,
              description: entry.description,
              command: entry.resolvedCommand,
              destructive: entry.destructive ?? false,
              ok: false,
              exitCode: 2,
              output: "",
              error: "unresolved placeholders in command",
            })
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
            error: result.error,
          })

          if (!result.ok) {
            allOk = false
            break
          }
        }

        if (!allOk) break
      }

      const command = "recover"
      if (!allOk) {
        const failedStep = executed.find((entry) => !entry.ok)
        const failureDetail = failedStep
          ? `${failedStep.phase}:${failedStep.command} (${failedStep.error ?? `exit ${failedStep.exitCode}`})`
          : "unknown failure"

        yield* Console.log(respondError(
          command,
          `Recovery execution failed for ${runbook.code}: ${failureDetail}`,
          "RUNBOOK_EXEC_FAILED",
          "Inspect failed step, then run rollback or diagnose phase",
          [
            {
              command: "recover <error-code> --phase rollback --execute [--context <context>]",
              description: "Run rollback phase",
              params: {
                "error-code": { value: runbook.code, required: true },
                context: { value: context, default: "{}" },
              },
            },
            {
              command: "recover <error-code> --phase diagnose [--context <context>]",
              description: "Review diagnostic plan",
              params: {
                "error-code": { value: runbook.code, required: true },
                context: { value: context, default: "{}" },
              },
            },
          ],
        ))
        return
      }

      yield* Console.log(respond(command, {
        mode: "executed",
        code: runbook.code,
        phase: normalizedPhase,
        ok: true,
        executed,
      }, [
        {
          command: "recover <error-code> --phase verify --execute [--context <context>]",
          description: "Run verification phase",
          params: {
            "error-code": { value: runbook.code, required: true },
            context: { value: context, default: "{}" },
          },
        },
        { command: "status", description: "Confirm overall system health" },
      ]))
    })
)

export const __recoverTestUtils = {
  normalizePhase,
  parseContext,
  truncateOutput,
  hasUnresolvedPlaceholder,
}
