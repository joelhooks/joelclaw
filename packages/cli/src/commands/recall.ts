import { readFileSync, statSync } from "node:fs"
import { Args, Command, Options } from "@effect/cli"
import { resolveRepositoryScope } from "@joelclaw/recall"
import { Console, Effect, Schema } from "effect"
import { __recallTestUtils } from "../capabilities/adapters/typesense-recall"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import {
  COMPOSED_RECALL_SCHEMA_VERSION,
  type ComposedRecallRequestV1,
  ComposedRecallRequestV1Schema,
  MAX_RECALL_HITS_PER_LANE,
} from "../recall/contract"
import { respond, respondError } from "../response"

type OptionalValue<T> = { readonly _tag: "Some"; readonly value: T } | { readonly _tag: "None" }

type RecallCapabilityResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

const decodeRequest = Schema.decodeUnknownEither(ComposedRecallRequestV1Schema)

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

function optionalText(value: OptionalValue<string>): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parsePrivacy(value: string): string[] {
  return value
    .split(",")
    .map((tier) => tier.trim())
    .filter(Boolean)
}

function hasInvalidLaneLimit(limits: readonly number[]): boolean {
  return limits.some(
    (value) => !Number.isInteger(value) || value < 1 || value > MAX_RECALL_HITS_PER_LANE,
  )
}

export function readPrivateRecallRequest(source: string): unknown {
  if (source === "-") return JSON.parse(readFileSync(0, "utf8"))
  const stat = statSync(source)
  if (!stat.isFile()) throw new Error("request source is not a regular file")
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("request file must not be readable or writable by group or other users")
  }
  return JSON.parse(readFileSync(source, "utf8"))
}

function unavailableLanes(payload: Record<string, unknown>): Array<{ lane: string; code: string }> {
  const composed = payload.composed
  if (!composed || typeof composed !== "object") return []
  const unavailable = (composed as Record<string, unknown>).unavailable
  if (!Array.isArray(unavailable)) return []
  return unavailable.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const item = value as Record<string, unknown>
    return typeof item.lane === "string" && typeof item.code === "string"
      ? [{ lane: item.lane, code: item.code }]
      : []
  })
}

async function resolveInteractiveRequest(input: {
  readonly query: string
  readonly cwd: string
  readonly project?: string
  readonly workstream?: string
  readonly principalRef: string
  readonly purpose: string
  readonly allowedPrivacy: string
  readonly includeSuperseded: boolean
  readonly reflectionLimit: number
  readonly observationLimit: number
  readonly curatedLimit: number
}): Promise<ComposedRecallRequestV1> {
  let scope: { project: string; workstream: string }
  if (input.project || input.workstream) {
    if (!input.project || !input.workstream) {
      throw new Error("explicit recall scope requires both --project and --workstream")
    }
    scope = { project: input.project, workstream: input.workstream }
  } else {
    const resolution = await resolveRepositoryScope({ cwd: input.cwd })
    if (resolution._tag !== "TrustedRepository") {
      throw new Error(
        "interactive recall requires a trusted GitHub repository or explicit --project and --workstream",
      )
    }
    scope = resolution.scope
  }

  const decoded = decodeRequest({
    _tag: "ComposedRecallRequestV1",
    access: {
      _tag: "RecallAccessV1",
      allowedPrivacy: parsePrivacy(input.allowedPrivacy),
      decidedAt: new Date().toISOString(),
      principalRef: input.principalRef,
      purpose: input.purpose,
    },
    includeSuperseded: input.includeSuperseded,
    limits: {
      curated: input.curatedLimit,
      observations: input.observationLimit,
      reflections: input.reflectionLimit,
    },
    schemaVersion: COMPOSED_RECALL_SCHEMA_VERSION,
    scope: { _tag: "ProjectWorkstream", ...scope },
    text: input.query,
  })
  if (decoded._tag === "Left") throw new Error("interactive recall request is invalid")
  return decoded.right
}

const query = Args.text({ name: "query" }).pipe(Args.optional)
const requestFile = Options.text("request-file").pipe(Options.withDefault(""))
const project = Options.text("project").pipe(Options.withDefault(""))
const workstream = Options.text("workstream").pipe(Options.withDefault(""))
const principalRef = Options.text("principal-ref").pipe(Options.withDefault("operator:joel"))
const purpose = Options.text("purpose").pipe(Options.withDefault("interactive-recall"))
const allowedPrivacy = Options.text("allowed-privacy").pipe(Options.withDefault("public,private"))
const includeSuperseded = Options.boolean("include-superseded").pipe(Options.withDefault(false))
const reflectionLimit = Options.integer("reflection-limit").pipe(Options.withDefault(5))
const observationLimit = Options.integer("observation-limit").pipe(Options.withDefault(5))
const curatedLimit = Options.integer("curated-limit").pipe(Options.withDefault(5))

// Provider-era compatibility flags remain accepted for the dated rollback
// window. They never alter the composed request, and --raw never emits bodies.
const limit = Options.integer("limit").pipe(Options.withDefault(0))
const minScore = Options.float("min-score").pipe(Options.withDefault(0))
const raw = Options.boolean("raw").pipe(Options.withDefault(false))
const includeHold = Options.boolean("include-hold").pipe(Options.withDefault(false))
const includeDiscard = Options.boolean("include-discard").pipe(Options.withDefault(false))
const budget = Options.text("budget").pipe(Options.withDefault("auto"))
const category = Options.text("category").pipe(Options.withDefault(""))

export const recallCmd = Command.make(
  "recall",
  {
    query,
    requestFile,
    project,
    workstream,
    principalRef,
    purpose,
    allowedPrivacy,
    includeSuperseded,
    reflectionLimit,
    observationLimit,
    curatedLimit,
    limit,
    minScore,
    raw,
    includeHold,
    includeDiscard,
    budget,
    category,
  },
  (options) =>
    Effect.gen(function* () {
      const positionalQuery = optionalText(options.query)
      let request: ComposedRecallRequestV1 | undefined

      if (options.requestFile.trim()) {
        if (positionalQuery) {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              "Use either a positional interactive query or --request-file, not both",
              "RECALL_INPUT_AMBIGUOUS",
              "Automatic callers must pass the exact request through --request-file - on stdin.",
            ),
          )
          return
        }
        const rawRequest = yield* Effect.try({
          try: () => readPrivateRecallRequest(options.requestFile.trim()),
          catch: () => new Error("private recall request could not be read"),
        }).pipe(Effect.either)
        if (rawRequest._tag === "Left") {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              rawRequest.left.message,
              "RECALL_REQUEST_UNREADABLE",
              "Use --request-file - for stdin or a 0600 JSON request file.",
            ),
          )
          return
        }
        const decoded = decodeRequest(rawRequest.right)
        if (decoded._tag === "Left") {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              "The private request does not satisfy ComposedRecallRequestV1",
              "RECALL_REQUEST_INVALID",
              "Pass one exact scope, explicit access, bounded lane limits, and a non-empty query.",
            ),
          )
          return
        }
        request = decoded.right
      } else {
        if (!positionalQuery) {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              "Recall needs a positional interactive query or --request-file",
              "RECALL_QUERY_REQUIRED",
              "Use a positional query interactively. Automatic callers use --request-file - and stdin.",
            ),
          )
          return
        }
        if (
          hasInvalidLaneLimit([
            options.reflectionLimit,
            options.observationLimit,
            options.curatedLimit,
          ])
        ) {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              `Lane limits must be integers between 1 and ${MAX_RECALL_HITS_PER_LANE}`,
              "RECALL_LIMIT_INVALID",
              "Set each explicit lane limit between 1 and 50.",
            ),
          )
          return
        }
        const resolved = yield* Effect.tryPromise({
          try: () =>
            resolveInteractiveRequest({
              query: positionalQuery,
              cwd: process.cwd(),
              project: options.project.trim() || undefined,
              workstream: options.workstream.trim() || undefined,
              principalRef: options.principalRef,
              purpose: options.purpose,
              allowedPrivacy: options.allowedPrivacy,
              includeSuperseded: options.includeSuperseded,
              reflectionLimit: options.reflectionLimit,
              observationLimit: options.observationLimit,
              curatedLimit: options.curatedLimit,
            }),
          catch: (error) =>
            new Error(error instanceof Error ? error.message : "scope resolution failed"),
        }).pipe(Effect.either)
        if (resolved._tag === "Left") {
          process.exitCode = 1
          yield* Console.log(
            respondError(
              "recall",
              resolved.left.message,
              "RECALL_SCOPE_REQUIRED",
              "Run inside a trusted GitHub repository or pass both --project and --workstream.",
            ),
          )
          return
        }
        request = resolved.right
      }

      const result = yield* executeCapabilityCommand<RecallCapabilityResult>({
        capability: "recall",
        subcommand: "query",
        args: {
          allowedPrivacy: request.access.allowedPrivacy,
          curatedLimit: request.limits.curated,
          decidedAt: request.access.decidedAt,
          includeSuperseded: request.includeSuperseded,
          observationLimit: request.limits.observations,
          principalRef: request.access.principalRef,
          project: request.scope.project,
          purpose: request.access.purpose,
          query: request.text,
          reflectionLimit: request.limits.reflections,
          workstream: request.scope.workstream,
          // Dated rollback adapter fields are fixed from the composed request.
          // Provider-era flags cannot widen lanes or weaken the rollback gate.
          limit: Math.max(
            request.limits.curated,
            request.limits.observations,
            request.limits.reflections,
          ),
          minScore: 0,
          raw: false,
          includeHold: false,
          includeDiscard: false,
          budget: "auto",
          category: "",
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        process.exitCode = 1
        const error = result.left
        yield* Console.log(
          respondError(
            "recall",
            error.message,
            codeOrFallback(error, "RECALL_FAILED"),
            fixOrFallback(error, "Inspect recall status and configuration."),
            [{ command: "joelclaw status", description: "Check recall adapter and lane health" }],
          ),
        )
        return
      }

      const payload = result.right.payload ?? {}
      const unavailable = unavailableLanes(payload)
      if (unavailable.length > 0) process.exitCode = 3
      const responsePayload = options.limit > 0
        ? {
            ...payload,
            compatibility: {
              deprecatedFlag: "--limit",
              disposition: "ignored",
              replacement: "--reflection-limit/--observation-limit/--curated-limit",
            },
          }
        : payload

      yield* Console.log(
        respond(
          "recall",
          responsePayload,
          [
            {
              command:
                "joelclaw recall <query> --reflection-limit 10 --observation-limit 10 --curated-limit 10",
              description: "Set explicit lane-local limits",
            },
            {
              command: "joelclaw sessions search <query>",
              description: "Search explicit session evidence",
            },
          ],
          unavailable.length === 0,
        ),
      )
    }),
)

export const __recallCommandTestUtils = {
  readPrivateRecallRequest,
  resolveInteractiveRequest,
  unavailableLanes,
}

export { __recallTestUtils }
