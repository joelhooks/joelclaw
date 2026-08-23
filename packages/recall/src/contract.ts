export const COMPOSED_RECALL_SCHEMA_VERSION = 1 as const

export const RECALL_LANE_ORDER = [
  "flowing-reflections",
  "flowing-observations",
  "curated-pages",
] as const

export type RecallLaneName = (typeof RECALL_LANE_ORDER)[number]
export type RecallPrivacyTier = "public" | "private" | "sensitive"

const RECALL_UNAVAILABLE_CODES = [
  "not-configured",
  "untrusted-executable",
  "credential-unavailable",
  "invalid-input",
  "store-unavailable",
  "contract-violation",
  "contract-mismatch",
  "malformed-response",
  "timeout",
  "process-failed",
  "not-requested",
] as const

export type ComposedRecallRequestV1 = {
  readonly _tag: "ComposedRecallRequestV1"
  readonly access: {
    readonly _tag: "RecallAccessV1"
    readonly allowedPrivacy: readonly RecallPrivacyTier[]
    readonly decidedAt: string
    readonly principalRef: string
    readonly purpose: string
  }
  readonly includeSuperseded: boolean
  readonly limits: {
    readonly curated: number
    readonly observations: number
    readonly reflections: number
  }
  readonly schemaVersion: 1
  readonly scope: {
    readonly _tag: "ProjectWorkstream"
    readonly project: string
    readonly workstream: string
  }
  readonly text: string
}

export type ParsedRecallItem = {
  readonly evidenceIds: readonly string[]
  readonly id: string
  readonly kind: string
  readonly lane: RecallLaneName
  readonly privacy: RecallPrivacyTier
  readonly rank: number
  readonly score: number
  readonly scopeBinding: "record-scope" | "retrieval-scope"
  readonly summary?: string
  readonly title: string
}

export type ParsedRecallLane =
  | {
      readonly _tag: "available"
      readonly name: RecallLaneName
      readonly source: string
      readonly health: "Healthy" | "Stale" | "Failed" | "Unknown"
      readonly items: readonly ParsedRecallItem[]
    }
  | {
      readonly _tag: "unavailable"
      readonly name: RecallLaneName
      readonly source: string
      readonly code: string
    }

export type ParsedComposedRecall = {
  readonly adapter: "flowing-memory-recall"
  readonly ok: boolean
  readonly lanes: readonly [ParsedRecallLane, ParsedRecallLane, ParsedRecallLane]
  readonly unavailable: readonly { readonly lane: RecallLaneName; readonly code: string }[]
  readonly envelope: Record<string, unknown>
}

export type FormattedRecallLane = {
  readonly name: RecallLaneName
  readonly health: string
  readonly source: string
  readonly lines: readonly string[]
}

export class RecallContractError extends Error {
  readonly code = "RECALL_RESPONSE_CONTRACT_INVALID"

  constructor(detail: string) {
    super(`Recall response contract is invalid: ${detail}`)
    this.name = "RecallContractError"
  }
}

function record(value: unknown, detail: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecallContractError(detail)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RecallContractError(detail)
  }
  return value
}

function number(value: unknown, detail: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RecallContractError(detail)
  }
  return value
}

function isLaneName(value: unknown): value is RecallLaneName {
  return typeof value === "string" && RECALL_LANE_ORDER.includes(value as RecallLaneName)
}

function isPrivacy(value: unknown): value is RecallPrivacyTier {
  return value === "public" || value === "private" || value === "sensitive"
}

const LANE_FIELDS: ReadonlyArray<readonly [string, RecallLaneName]> = [
  ["flowingReflections", "flowing-reflections"],
  ["flowingObservations", "flowing-observations"],
  ["curatedPages", "curated-pages"],
]

function parseItem(
  value: unknown,
  expectedLane: RecallLaneName,
  expectedRank: number,
  expectedScope: { readonly project: string; readonly workstream: string },
  allowedPrivacy: readonly RecallPrivacyTier[],
): ParsedRecallItem {
  const item = record(value, `${expectedLane} item ${expectedRank}`)
  if (item.lane !== expectedLane) throw new RecallContractError(`${expectedLane} item lane`)
  if (item.rank !== expectedRank) throw new RecallContractError(`${expectedLane} item rank`)
  if (!isPrivacy(item.privacy) || !allowedPrivacy.includes(item.privacy)) {
    throw new RecallContractError(`${expectedLane} item privacy`)
  }
  const scope = record(item.scope, `${expectedLane} item scope`)
  if (scope.project !== expectedScope.project || scope.workstream !== expectedScope.workstream) {
    throw new RecallContractError(`${expectedLane} item scope`)
  }
  if (item.scopeBinding !== "record-scope" && item.scopeBinding !== "retrieval-scope") {
    throw new RecallContractError(`${expectedLane} item scope binding`)
  }
  if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.every((id) => typeof id === "string")) {
    throw new RecallContractError(`${expectedLane} item evidence IDs`)
  }
  if (expectedLane !== "curated-pages" && item.evidenceIds.length === 0) {
    throw new RecallContractError(`${expectedLane} item evidence IDs`)
  }

  return {
    evidenceIds: item.evidenceIds,
    id: string(item.id, `${expectedLane} item ID`),
    kind: string(item.kind, `${expectedLane} item kind`),
    lane: expectedLane,
    privacy: item.privacy,
    rank: expectedRank,
    score: number(item.score, `${expectedLane} item score`),
    scopeBinding: item.scopeBinding,
    ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
    title: string(item.title, `${expectedLane} item title`),
  }
}

function parseLane(
  value: unknown,
  field: string,
  expectedName: RecallLaneName,
  expectedScope: { readonly project: string; readonly workstream: string },
  allowedPrivacy: readonly RecallPrivacyTier[],
): ParsedRecallLane {
  const lane = record(value, `${expectedName} lane`)
  if (lane.lane !== expectedName) throw new RecallContractError(`${field} lane name`)
  const source = string(lane.source, `${expectedName} source`)

  if (lane._tag === "RecallLaneUnavailableV1") {
    const code = string(lane.code, `${expectedName} unavailable code`)
    if (!RECALL_UNAVAILABLE_CODES.includes(code as (typeof RECALL_UNAVAILABLE_CODES)[number])) {
      throw new RecallContractError(`${expectedName} unavailable code`)
    }
    return {
      _tag: "unavailable",
      name: expectedName,
      source,
      code,
    }
  }
  if (lane._tag !== "RecallLaneAvailableV1") {
    throw new RecallContractError(`${expectedName} lane tag`)
  }

  const healthRecord = record(lane.health, `${expectedName} health`)
  const health = healthRecord._tag
  if (health !== "Healthy" && health !== "Stale" && health !== "Failed" && health !== "Unknown") {
    throw new RecallContractError(`${expectedName} health tag`)
  }
  if (health === "Stale") string(healthRecord.detail, `${expectedName} stale detail`)
  if (health === "Failed") string(healthRecord.detail, `${expectedName} failed detail`)
  if (health === "Unknown") string(healthRecord.reason, `${expectedName} unknown reason`)
  const expectedScale = expectedName === "curated-pages" ? "bm25-negated" : "unit-interval"
  if (lane.scoreScale !== expectedScale)
    throw new RecallContractError(`${expectedName} score scale`)
  if (!Array.isArray(lane.items)) throw new RecallContractError(`${expectedName} items`)

  return {
    _tag: "available",
    name: expectedName,
    source,
    health,
    items: lane.items.map((item, index) =>
      parseItem(item, expectedName, index + 1, expectedScope, allowedPrivacy),
    ),
  }
}

export function parseComposedRecallEnvelope(value: unknown): ParsedComposedRecall {
  const envelope = record(value, "envelope")
  if (typeof envelope.ok !== "boolean") throw new RecallContractError("envelope ok flag")
  const result = record(envelope.result, "envelope result")
  if (result.adapter !== "flowing-memory-recall") throw new RecallContractError("adapter")
  const composed = record(result.composed, "composed result")
  if (composed._tag !== "ComposedRecallResultV1" || composed.schemaVersion !== 1) {
    throw new RecallContractError("composed schema version")
  }
  const request = record(composed.request, "composed request")
  const scope = record(request.scope, "request scope")
  const access = record(request.access, "request access")
  const project = string(scope.project, "request project")
  const workstream = string(scope.workstream, "request workstream")
  if (!Array.isArray(access.allowedPrivacy) || access.allowedPrivacy.length === 0) {
    throw new RecallContractError("request privacy grant")
  }
  const allowedPrivacy = access.allowedPrivacy.map((tier) => {
    if (!isPrivacy(tier)) throw new RecallContractError("request privacy grant")
    return tier
  })
  if (new Set(allowedPrivacy).size !== allowedPrivacy.length) {
    throw new RecallContractError("request privacy grant")
  }
  const resolvedScope = record(composed.resolvedScope, "resolved scope")
  if (resolvedScope.project !== project || resolvedScope.workstream !== workstream) {
    throw new RecallContractError("resolved scope")
  }
  const resolvedAccess = record(composed.resolvedAccess, "resolved access")
  if (
    resolvedAccess.principalRef !== access.principalRef ||
    resolvedAccess.purpose !== access.purpose ||
    resolvedAccess.decidedAt !== access.decidedAt ||
    JSON.stringify(resolvedAccess.allowedPrivacy) !== JSON.stringify(allowedPrivacy)
  ) {
    throw new RecallContractError("resolved access")
  }
  const lanesObject = record(composed.lanes, "composed lanes")
  const actualFields = Object.keys(lanesObject).sort()
  const expectedFields = LANE_FIELDS.map(([field]) => field).sort()
  if (actualFields.join("\u0000") !== expectedFields.join("\u0000")) {
    throw new RecallContractError("unknown or missing lane field")
  }

  const lanes = LANE_FIELDS.map(([field, lane]) =>
    parseLane(lanesObject[field], field, lane, { project, workstream }, allowedPrivacy),
  ) as [ParsedRecallLane, ParsedRecallLane, ParsedRecallLane]
  if (lanes.some((lane, index) => lane.name !== RECALL_LANE_ORDER[index])) {
    throw new RecallContractError("lane ordering")
  }

  if (!Array.isArray(composed.unavailable)) throw new RecallContractError("unavailable summary")
  const unavailable = composed.unavailable.map((entry, index) => {
    const item = record(entry, `unavailable entry ${index + 1}`)
    if (!isLaneName(item.lane)) throw new RecallContractError("unavailable lane name")
    const code = string(item.code, "unavailable code")
    if (!RECALL_UNAVAILABLE_CODES.includes(code as (typeof RECALL_UNAVAILABLE_CODES)[number])) {
      throw new RecallContractError("unavailable code")
    }
    return { lane: item.lane, code }
  })

  const laneUnavailable = lanes.flatMap((lane) =>
    lane._tag === "unavailable" ? [{ lane: lane.name, code: lane.code }] : [],
  )
  if (JSON.stringify(unavailable) !== JSON.stringify(laneUnavailable)) {
    throw new RecallContractError("unavailable summary does not match lanes")
  }

  return {
    adapter: "flowing-memory-recall",
    ok: envelope.ok,
    lanes,
    unavailable,
    envelope,
  }
}

export function formatRecallLanes(
  recall: ParsedComposedRecall,
  options: { readonly maxItemsPerLane?: number } = {},
): readonly FormattedRecallLane[] {
  const maxItems = Math.max(1, Math.min(options.maxItemsPerLane ?? 5, 50))
  return recall.lanes.map((lane) => {
    if (lane._tag === "unavailable") {
      return {
        name: lane.name,
        health: `unavailable:${lane.code}`,
        source: lane.source,
        lines: [],
      }
    }
    return {
      name: lane.name,
      health: lane.health,
      source: lane.source,
      lines: lane.items.slice(0, maxItems).map((item) => {
        const body = (item.summary?.trim() || item.title).replaceAll(/\s+/gu, " ")
        return `${item.rank}. [${item.kind} | ${item.privacy}] ${body}`
      }),
    }
  })
}

export function formatRecallText(
  recall: ParsedComposedRecall,
  options: { readonly maxItemsPerLane?: number } = {},
): string {
  return formatRecallLanes(recall, options)
    .map((lane) => {
      const heading = `${lane.name} (${lane.health}; ${lane.source})`
      return lane.lines.length > 0
        ? `${heading}\n${lane.lines.join("\n")}`
        : `${heading}\n(no items)`
    })
    .join("\n\n")
}
