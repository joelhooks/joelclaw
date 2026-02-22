/**
 * Typed schemas for Inngest GQL responses.
 * Generated from introspected schema at schema/inngest-gql.json
 * Uses Effect Schema for runtime validation + TypeScript types.
 */
import { Schema as S } from "effect"

// ── Primitives ───────────────────────────────────────────────────────

export const FunctionTrigger = S.Struct({
  type: S.String,
  value: S.NullishOr(S.String),
})

export const InngestFunction = S.Struct({
  id: S.String,
  slug: S.String,
  name: S.String,
  triggers: S.Array(FunctionTrigger),
})

// ── Events ───────────────────────────────────────────────────────────

export const EventV2 = S.Struct({
  id: S.String,
  name: S.String,
  occurredAt: S.String,
  raw: S.String,
})

export const EventsV2Response = S.Struct({
  eventsV2: S.Struct({
    edges: S.Array(S.Struct({
      node: EventV2,
    })),
  }),
})

// ── Runs ─────────────────────────────────────────────────────────────

export const FunctionRunStatus = S.Literal(
  "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "QUEUED"
)

export const FunctionRunNode = S.Struct({
  id: S.String,
  status: S.NullishOr(FunctionRunStatus),
  functionID: S.String,
  startedAt: S.NullishOr(S.String),
  endedAt: S.NullishOr(S.String),
  output: S.NullishOr(S.String),
})

export const RunsResponse = S.Struct({
  runs: S.Struct({
    edges: S.Array(S.Struct({
      node: FunctionRunNode,
    })),
  }),
})

// ── Run Detail ───────────────────────────────────────────────────────

export const RunTrigger = S.Struct({
  eventName: S.NullishOr(S.String),
  IDs: S.NullishOr(S.Array(S.String)),
  timestamp: S.NullishOr(S.String),
})

export const TraceSpan = S.Struct({
  name: S.String,
  status: S.NullishOr(S.String),
  attempts: S.NullishOr(S.Number),
  duration: S.NullishOr(S.Number),
  isRoot: S.NullishOr(S.Boolean),
  startedAt: S.NullishOr(S.String),
  endedAt: S.NullishOr(S.String),
  stepOp: S.NullishOr(S.String),
  stepID: S.NullishOr(S.String),
  outputID: S.NullishOr(S.String),
  childrenSpans: S.NullishOr(S.Array(S.suspend((): S.Schema.Any => TraceSpan))),
})

export const SpanOutput = S.Struct({
  data: S.NullishOr(S.String),
  error: S.NullishOr(S.Struct({
    message: S.NullishOr(S.String),
    name: S.NullishOr(S.String),
    stack: S.NullishOr(S.String),
  })),
})

// ── Loop Event Payloads ──────────────────────────────────────────────

export const LoopEventData = S.Struct({
  loopId: S.String,
  project: S.optional(S.String),
  storyId: S.optional(S.String),
  attempt: S.optional(S.Number),
  tool: S.optional(S.String),
  maxRetries: S.optional(S.Number),
  maxIterations: S.optional(S.Number),
  feedback: S.optional(S.String),
  duration: S.optional(S.Number),
  reason: S.optional(S.String),
})

export const LoopEvent = S.Struct({
  id: S.String,
  name: S.String,
  occurredAt: S.String,
  data: LoopEventData,
})

// ── PRD (Redis) ──────────────────────────────────────────────────────

export const PrdStory = S.Struct({
  id: S.String,
  title: S.String,
  description: S.optional(S.String),
  acceptance_criteria: S.optional(S.Array(S.String)),
  priority: S.Number,
  passes: S.Boolean,
  skipped: S.optional(S.Boolean),
})

export const Prd = S.Struct({
  title: S.String,
  description: S.optional(S.String),
  stories: S.Array(PrdStory),
})

// ── Decoded types ────────────────────────────────────────────────────

export type InngestFunction = typeof InngestFunction.Type
export type EventV2 = typeof EventV2.Type
export type FunctionRunNode = typeof FunctionRunNode.Type
export type RunTrigger = typeof RunTrigger.Type
export type TraceSpan = typeof TraceSpan.Type
export type LoopEvent = typeof LoopEvent.Type
export type LoopEventData = typeof LoopEventData.Type
export type Prd = typeof Prd.Type
export type PrdStory = typeof PrdStory.Type
