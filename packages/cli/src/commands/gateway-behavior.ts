import { createHash, randomUUID } from "node:crypto"
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { type NextAction, respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

export const BEHAVIOR_TYPES = ["keep", "more", "less", "stop", "start"] as const

export type BehaviorType = typeof BEHAVIOR_TYPES[number]

type DirectiveSource = "operator" | "daily-review"

type CandidateStatus = "pending" | "promoted" | "rejected" | "expired"

type BehaviorDirective = {
  id: string
  type: BehaviorType
  text: string
  normalizedText: string
  source: DirectiveSource
  confidence?: number
  evidence?: string[]
  createdAt: string
  promotedFromCandidateId?: string
}

type ActiveBehaviorContract = {
  version: number
  generatedAt: string
  directives: BehaviorDirective[]
  hash: string
}

type HistoryKind = "directive" | "candidate" | "audit"

type HistoryDocument = {
  id: string
  kind: HistoryKind
  status: string
  type?: BehaviorType
  text: string
  normalized_text?: string
  source: string
  directive_id?: string
  candidate_id?: string
  confidence?: number
  evidence?: string[]
  reason?: string
  contract_hash?: string
  created_at: number
  updated_at?: number
  expires_at?: number
  promoted_at?: number
  metadata_json?: string
}

type TypesenseSearchHit = {
  document?: Record<string, unknown>
}

type TypesenseSearchResponse = {
  found?: number
  hits?: TypesenseSearchHit[]
}

type GovernDropReason = "dedupe" | "conflict" | "cap"

type GovernDrop = {
  directive: BehaviorDirective
  reason: GovernDropReason
  conflictWithId?: string
}

type GovernResult = {
  directives: BehaviorDirective[]
  dropped: GovernDrop[]
}

type AddDecision =
  | { kind: "added"; directive: BehaviorDirective; contract: ActiveBehaviorContract }
  | { kind: "deduped"; existing: BehaviorDirective }
  | { kind: "conflict"; conflictWith: BehaviorDirective }
  | { kind: "cap" }

const REDIS_CONTRACT_KEY = "joelclaw:gateway:behavior:contract"
const HISTORY_COLLECTION = "gateway_behavior_history"
const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108"

const CONTRACT_CAP = clampInt(process.env.GATEWAY_BEHAVIOR_CONTRACT_CAP, 24, 8)
const CANDIDATE_TTL_DAYS = clampInt(process.env.GATEWAY_BEHAVIOR_CANDIDATE_TTL_DAYS, 7, 1)

const CONFLICT_MAP: Record<BehaviorType, BehaviorType[]> = {
  keep: ["stop"],
  more: ["less"],
  less: ["more"],
  stop: ["keep", "start"],
  start: ["stop"],
}

function clampInt(value: string | undefined, fallback: number, min: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

function nowIso(): string {
  return new Date().toISOString()
}

function nowTs(): number {
  return Date.now()
}

function addDays(days: number): number {
  return nowTs() + days * 24 * 60 * 60 * 1000
}

async function connectRedis() {
  const Redis = (await import("ioredis")).default
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 5000,
  })
  await redis.connect()
  return redis
}

async function closeRedis(redis: { quit: () => Promise<unknown>; disconnect: () => void }): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}

function escapeFilter(value: string): string {
  return value.replace(/[`\\]/g, "\\$&")
}

async function typesenseRequest(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${path}`, {
    ...(init ?? {}),
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

const HISTORY_COLLECTION_SCHEMA = {
  name: HISTORY_COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "kind", type: "string", facet: true },
    { name: "status", type: "string", facet: true },
    { name: "type", type: "string", facet: true, optional: true },
    { name: "text", type: "string" },
    { name: "normalized_text", type: "string", facet: true, optional: true },
    { name: "source", type: "string", facet: true },
    { name: "directive_id", type: "string", optional: true },
    { name: "candidate_id", type: "string", optional: true },
    { name: "confidence", type: "float", optional: true },
    { name: "evidence", type: "string[]", optional: true },
    { name: "reason", type: "string", optional: true },
    { name: "contract_hash", type: "string", optional: true },
    { name: "created_at", type: "int64" },
    { name: "updated_at", type: "int64", optional: true },
    { name: "expires_at", type: "int64", optional: true },
    { name: "promoted_at", type: "int64", optional: true },
    { name: "metadata_json", type: "string", optional: true },
  ],
  default_sorting_field: "created_at",
} as const

async function ensureHistoryCollection(apiKey: string): Promise<void> {
  const existing = await typesenseRequest(apiKey, `/collections/${HISTORY_COLLECTION}`)
  if (existing.ok) return
  if (existing.status !== 404) {
    const body = await existing.text()
    throw new Error(`Typesense collection check failed (${existing.status}): ${body}`)
  }

  const create = await typesenseRequest(apiKey, "/collections", {
    method: "POST",
    body: JSON.stringify(HISTORY_COLLECTION_SCHEMA),
  })

  if (!create.ok) {
    const body = await create.text()
    if (create.status === 409 || body.toLowerCase().includes("already exists")) return
    throw new Error(`Typesense collection create failed (${create.status}): ${body}`)
  }
}

async function upsertHistoryDoc(apiKey: string, doc: HistoryDocument): Promise<void> {
  const response = await typesenseRequest(
    apiKey,
    `/collections/${HISTORY_COLLECTION}/documents?action=upsert`,
    {
      method: "POST",
      body: JSON.stringify(doc),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Typesense upsert failed (${response.status}): ${body}`)
  }
}

async function getHistoryDoc(apiKey: string, id: string): Promise<Record<string, unknown> | null> {
  const response = await typesenseRequest(
    apiKey,
    `/collections/${HISTORY_COLLECTION}/documents/${encodeURIComponent(id)}`,
  )

  if (response.status === 404) return null
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Typesense get failed (${response.status}): ${body}`)
  }

  return (await response.json()) as Record<string, unknown>
}

async function searchHistory(
  apiKey: string,
  options: {
    filterBy?: string
    sortBy?: string
    perPage?: number
    page?: number
  },
): Promise<TypesenseSearchResponse> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "text,reason,kind,type,status,source",
    per_page: String(options.perPage ?? 20),
    page: String(options.page ?? 1),
  })

  if (options.filterBy) params.set("filter_by", options.filterBy)
  if (options.sortBy) params.set("sort_by", options.sortBy)

  const response = await typesenseRequest(
    apiKey,
    `/collections/${HISTORY_COLLECTION}/documents/search?${params.toString()}`,
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Typesense search failed (${response.status}): ${body}`)
  }

  return (await response.json()) as TypesenseSearchResponse
}

async function countHistory(apiKey: string, filterBy?: string): Promise<number> {
  const result = await searchHistory(apiKey, {
    filterBy,
    perPage: 1,
    page: 1,
  })
  return Number(result.found ?? 0)
}

function normalizeDirectiveText(text: string): { text: string; normalizedText: string } {
  const collapsed = text.replace(/\s+/g, " ").trim()
  const cleaned = collapsed.replace(/[.!?;:]+$/g, "").trim()

  if (cleaned.length === 0) {
    throw new Error("Directive text cannot be empty")
  }

  if (cleaned.length < 4) {
    throw new Error("Directive text is too short")
  }

  if (cleaned.length > 320) {
    throw new Error("Directive text exceeds 320 characters")
  }

  return {
    text: collapsed,
    normalizedText: cleaned.toLowerCase(),
  }
}

function directiveSortTs(value: BehaviorDirective): number {
  const parsed = Date.parse(value.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortByCreatedAtAsc<T extends { createdAt: string }>(values: T[]): T[] {
  return [...values].sort((a, b) => {
    const aTs = Date.parse(a.createdAt)
    const bTs = Date.parse(b.createdAt)
    const safeA = Number.isFinite(aTs) ? aTs : 0
    const safeB = Number.isFinite(bTs) ? bTs : 0
    return safeA - safeB
  })
}

function computeContractHash(directives: BehaviorDirective[]): string {
  const canonical = directives
    .map((directive) => ({
      type: directive.type,
      text: directive.text,
      normalizedText: directive.normalizedText,
      source: directive.source,
    }))
    .sort((a, b) => {
      const byType = a.type.localeCompare(b.type)
      if (byType !== 0) return byType
      return a.normalizedText.localeCompare(b.normalizedText)
    })

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 20)
}

function emptyContract(): ActiveBehaviorContract {
  const directives: BehaviorDirective[] = []
  return {
    version: 0,
    generatedAt: nowIso(),
    directives,
    hash: computeContractHash(directives),
  }
}

function parseBehaviorType(value: unknown): BehaviorType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if ((BEHAVIOR_TYPES as readonly string[]).includes(normalized)) {
    return normalized as BehaviorType
  }
  return null
}

function parseDirective(value: unknown): BehaviorDirective | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>

  const id = typeof record.id === "string" ? record.id.trim() : ""
  const type = parseBehaviorType(record.type)
  const text = typeof record.text === "string" ? record.text.trim() : ""
  const normalizedText = typeof record.normalizedText === "string" ? record.normalizedText.trim() : ""
  const source = record.source === "daily-review" ? "daily-review" : "operator"
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : ""

  if (!id || !type || !text || !normalizedText || !createdAt) return null

  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? record.confidence
    : undefined

  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter((entry): entry is string => typeof entry === "string")
    : undefined

  const promotedFromCandidateId = typeof record.promotedFromCandidateId === "string"
    ? record.promotedFromCandidateId
    : undefined

  return {
    id,
    type,
    text,
    normalizedText,
    source,
    ...(confidence != null ? { confidence } : {}),
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
    ...(promotedFromCandidateId ? { promotedFromCandidateId } : {}),
    createdAt,
  }
}

function parseContract(raw: string | null): ActiveBehaviorContract {
  if (!raw) return emptyContract()

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const version = typeof parsed.version === "number" && Number.isFinite(parsed.version)
      ? Math.max(0, Math.floor(parsed.version))
      : 0
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : nowIso()
    const directives = Array.isArray(parsed.directives)
      ? parsed.directives
          .map((entry) => parseDirective(entry))
          .filter((entry): entry is BehaviorDirective => entry != null)
      : []

    return {
      version,
      generatedAt,
      directives: sortByCreatedAtAsc(directives),
      hash: computeContractHash(directives),
    }
  } catch {
    return emptyContract()
  }
}

async function loadContract(redis: { get: (key: string) => Promise<string | null> }): Promise<ActiveBehaviorContract> {
  const raw = await redis.get(REDIS_CONTRACT_KEY)
  return parseContract(raw)
}

function nextContract(previous: ActiveBehaviorContract, directives: BehaviorDirective[]): ActiveBehaviorContract {
  const normalized = sortByCreatedAtAsc(directives)
  return {
    version: previous.version + 1,
    generatedAt: nowIso(),
    directives: normalized,
    hash: computeContractHash(normalized),
  }
}

async function persistContract(
  redis: { set: (key: string, value: string) => Promise<unknown> },
  contract: ActiveBehaviorContract,
): Promise<void> {
  await redis.set(REDIS_CONTRACT_KEY, JSON.stringify(contract))
}

function directiveConflict(existingType: BehaviorType, incomingType: BehaviorType): boolean {
  return (CONFLICT_MAP[existingType] ?? []).includes(incomingType)
}

function findDuplicate(
  directives: BehaviorDirective[],
  type: BehaviorType,
  normalizedText: string,
): BehaviorDirective | null {
  return directives.find((directive) => directive.type === type && directive.normalizedText === normalizedText) ?? null
}

function findConflict(
  directives: BehaviorDirective[],
  type: BehaviorType,
  normalizedText: string,
): BehaviorDirective | null {
  return directives.find((directive) => (
    directive.normalizedText === normalizedText
      && directiveConflict(directive.type, type)
  )) ?? null
}

function addDirectiveToContract(
  contract: ActiveBehaviorContract,
  input: {
    type: BehaviorType
    text: string
    normalizedText: string
    source: DirectiveSource
    confidence?: number
    evidence?: string[]
    promotedFromCandidateId?: string
  },
  cap = CONTRACT_CAP,
): AddDecision {
  const duplicate = findDuplicate(contract.directives, input.type, input.normalizedText)
  if (duplicate) return { kind: "deduped", existing: duplicate }

  const conflict = findConflict(contract.directives, input.type, input.normalizedText)
  if (conflict) return { kind: "conflict", conflictWith: conflict }

  if (contract.directives.length >= cap) return { kind: "cap" }

  const directive: BehaviorDirective = {
    id: randomUUID(),
    type: input.type,
    text: input.text,
    normalizedText: input.normalizedText,
    source: input.source,
    ...(input.confidence != null ? { confidence: input.confidence } : {}),
    ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
    ...(input.promotedFromCandidateId ? { promotedFromCandidateId: input.promotedFromCandidateId } : {}),
    createdAt: nowIso(),
  }

  const contractNext = nextContract(contract, [...contract.directives, directive])
  return {
    kind: "added",
    directive,
    contract: contractNext,
  }
}

function governContractDirectives(
  directives: BehaviorDirective[],
  cap = CONTRACT_CAP,
): GovernResult {
  const sorted = sortByCreatedAtAsc(directives)
  const kept: BehaviorDirective[] = []
  const dropped: GovernDrop[] = []

  for (const directive of sorted) {
    const duplicate = findDuplicate(kept, directive.type, directive.normalizedText)
    if (duplicate) {
      dropped.push({ directive, reason: "dedupe" })
      continue
    }

    const conflict = findConflict(kept, directive.type, directive.normalizedText)
    if (conflict) {
      dropped.push({ directive, reason: "conflict", conflictWithId: conflict.id })
      continue
    }

    kept.push(directive)
  }

  if (kept.length <= cap) {
    return { directives: kept, dropped }
  }

  const byAge = [...kept].sort((a, b) => directiveSortTs(a) - directiveSortTs(b))
  const overflow = Math.max(0, byAge.length - cap)
  const capDropped = byAge.slice(0, overflow)
  const keepIds = new Set(byAge.slice(overflow).map((directive) => directive.id))

  for (const directive of capDropped) {
    dropped.push({ directive, reason: "cap" })
  }

  return {
    directives: kept.filter((directive) => keepIds.has(directive.id)),
    dropped,
  }
}

function parseEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function parseCandidateStatus(value: unknown): CandidateStatus {
  if (value === "promoted") return "promoted"
  if (value === "rejected") return "rejected"
  if (value === "expired") return "expired"
  return "pending"
}

type CandidateRecord = {
  id: string
  type: BehaviorType
  text: string
  normalizedText: string
  confidence?: number
  evidence: string[]
  source: DirectiveSource
  status: CandidateStatus
  createdAt: number
  expiresAt?: number
}

function parseCandidate(record: Record<string, unknown>): CandidateRecord | null {
  if (record.kind !== "candidate") return null
  const id = typeof record.id === "string" ? record.id : ""
  const type = parseBehaviorType(record.type)
  const text = typeof record.text === "string" ? record.text.trim() : ""
  const normalizedText = typeof record.normalized_text === "string"
    ? record.normalized_text.trim()
    : ""
  const source = record.source === "operator" ? "operator" : "daily-review"
  const status = parseCandidateStatus(record.status)
  const createdAt = typeof record.created_at === "number" && Number.isFinite(record.created_at)
    ? Math.floor(record.created_at)
    : 0

  if (!id || !type || !text || !normalizedText || createdAt <= 0) return null

  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? record.confidence
    : undefined

  const expiresAt = typeof record.expires_at === "number" && Number.isFinite(record.expires_at)
    ? Math.floor(record.expires_at)
    : undefined

  return {
    id,
    type,
    text,
    normalizedText,
    ...(confidence != null ? { confidence } : {}),
    evidence: parseEvidence(record.evidence),
    source,
    status,
    createdAt,
    ...(expiresAt != null ? { expiresAt } : {}),
  }
}

function compactDirective(directive: BehaviorDirective) {
  return {
    id: directive.id,
    type: directive.type,
    text: directive.text,
    source: directive.source,
    ...(directive.confidence != null ? { confidence: directive.confidence } : {}),
    ...(directive.evidence && directive.evidence.length > 0 ? { evidence: directive.evidence } : {}),
    createdAt: directive.createdAt,
    normalizedText: directive.normalizedText,
  }
}

function compactCandidate(candidate: CandidateRecord) {
  return {
    id: candidate.id,
    type: candidate.type,
    text: candidate.text,
    source: candidate.source,
    status: candidate.status,
    ...(candidate.confidence != null ? { confidence: candidate.confidence } : {}),
    evidence: candidate.evidence,
    createdAt: new Date(candidate.createdAt).toISOString(),
    ...(candidate.expiresAt != null
      ? {
          expiresAt: new Date(candidate.expiresAt).toISOString(),
          expiresInSeconds: Math.max(0, Math.floor((candidate.expiresAt - nowTs()) / 1000)),
        }
      : {}),
  }
}

function directiveHistoryDoc(
  directive: BehaviorDirective,
  contractHash: string,
  status: string,
): HistoryDocument {
  return {
    id: `directive:${directive.id}`,
    kind: "directive",
    status,
    type: directive.type,
    text: directive.text,
    normalized_text: directive.normalizedText,
    source: directive.source,
    directive_id: directive.id,
    ...(directive.confidence != null ? { confidence: directive.confidence } : {}),
    ...(directive.evidence && directive.evidence.length > 0 ? { evidence: directive.evidence } : {}),
    contract_hash: contractHash,
    created_at: Math.floor(Date.parse(directive.createdAt) || nowTs()),
    updated_at: nowTs(),
  }
}

function candidateStatusDoc(
  candidate: CandidateRecord,
  status: CandidateStatus,
  reason: string,
): HistoryDocument {
  return {
    id: candidate.id,
    kind: "candidate",
    status,
    type: candidate.type,
    text: candidate.text,
    normalized_text: candidate.normalizedText,
    source: candidate.source,
    candidate_id: candidate.id,
    ...(candidate.confidence != null ? { confidence: candidate.confidence } : {}),
    ...(candidate.evidence.length > 0 ? { evidence: candidate.evidence } : {}),
    reason,
    created_at: candidate.createdAt,
    updated_at: nowTs(),
    ...(candidate.expiresAt != null ? { expires_at: candidate.expiresAt } : {}),
    ...(status === "promoted" ? { promoted_at: nowTs() } : {}),
  }
}

function auditDoc(
  action: string,
  detail: {
    status: string
    type?: BehaviorType
    text: string
    source: string
    reason?: string
    directiveId?: string
    candidateId?: string
    contractHash?: string
    metadata?: Record<string, unknown>
  },
): HistoryDocument {
  return {
    id: `audit:${randomUUID()}`,
    kind: "audit",
    status: detail.status,
    ...(detail.type ? { type: detail.type } : {}),
    text: detail.text,
    source: detail.source,
    ...(detail.reason ? { reason: detail.reason } : {}),
    ...(detail.directiveId ? { directive_id: detail.directiveId } : {}),
    ...(detail.candidateId ? { candidate_id: detail.candidateId } : {}),
    ...(detail.contractHash ? { contract_hash: detail.contractHash } : {}),
    ...(detail.metadata
      ? { metadata_json: JSON.stringify({ action, ...detail.metadata }) }
      : { metadata_json: JSON.stringify({ action }) }),
    created_at: nowTs(),
  }
}

async function expireStaleCandidates(apiKey: string): Promise<{ expired: number; ids: string[] }> {
  const currentTs = nowTs()
  const result = await searchHistory(apiKey, {
    filterBy: `kind:=candidate && status:=pending && expires_at:<=${currentTs}`,
    sortBy: "created_at:asc",
    perPage: 250,
  })

  const docs = (result.hits ?? [])
    .map((hit) => hit.document ?? {})
    .map((doc) => parseCandidate(doc))
    .filter((doc): doc is CandidateRecord => doc != null)

  for (const candidate of docs) {
    await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "expired", "stale-candidate-expired"))
    await upsertHistoryDoc(apiKey, auditDoc("candidate.expired", {
      status: "expired",
      type: candidate.type,
      text: candidate.text,
      source: candidate.source,
      reason: "stale-candidate-expired",
      candidateId: candidate.id,
    }))
  }

  return {
    expired: docs.length,
    ids: docs.map((candidate) => candidate.id),
  }
}

async function listPendingCandidates(apiKey: string): Promise<CandidateRecord[]> {
  const currentTs = nowTs()
  const result = await searchHistory(apiKey, {
    filterBy: `kind:=candidate && status:=pending && expires_at:>${currentTs}`,
    sortBy: "created_at:desc",
    perPage: 50,
  })

  return (result.hits ?? [])
    .map((hit) => hit.document ?? {})
    .map((doc) => parseCandidate(doc))
    .filter((doc): doc is CandidateRecord => doc != null)
}

async function requireStores<T>(
  callback: (stores: {
    redis: Awaited<ReturnType<typeof connectRedis>>
    apiKey: string
  }) => Promise<T>,
): Promise<T> {
  const redis = await connectRedis()

  try {
    const apiKey = resolveTypesenseApiKey()
    await ensureHistoryCollection(apiKey)
    return await callback({ redis, apiKey })
  } finally {
    await closeRedis(redis)
  }
}

function behaviorErrorEnvelope(command: string, error: unknown, fallbackFix: string): string {
  if (isTypesenseApiKeyError(error)) {
    return respondError(
      command,
      error.message,
      error.code,
      error.fix,
      [
        { command: "joelclaw status", description: "Check system health" },
        { command: "joelclaw gateway behavior list", description: "Retry behavior contract read" },
      ],
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return respondError(
    command,
    message,
    "GATEWAY_BEHAVIOR_FAILED",
    fallbackFix,
    [
      { command: "joelclaw gateway behavior list", description: "Inspect current behavior contract" },
      { command: "joelclaw status", description: "Check system health" },
    ],
  )
}

function defaultBehaviorNextActions(): NextAction[] {
  return [
    {
      command: "joelclaw gateway behavior add --type <type> --text <text>",
      description: "Add an operator directive to the active contract",
      params: {
        type: { required: true, enum: BEHAVIOR_TYPES },
        text: { required: true, description: "Directive text" },
      },
    },
    { command: "joelclaw gateway behavior list", description: "List active contract + pending candidates" },
    { command: "joelclaw gateway behavior stats", description: "View behavior control-plane stats" },
  ]
}

const addTypeOpt = Options.choice("type", BEHAVIOR_TYPES).pipe(
  Options.withDescription("Directive type"),
)

const addTextOpt = Options.text("text").pipe(
  Options.withDescription("Directive text"),
)

const candidateIdOpt = Options.text("id").pipe(
  Options.withDescription("Candidate ID from gateway behavior list"),
)

const directiveIdOpt = Options.text("id").pipe(
  Options.withDescription("Directive ID from active contract"),
)

const behaviorAdd = Command.make(
  "add",
  {
    type: addTypeOpt,
    text: addTextOpt,
  },
  ({ type, text }) =>
    Effect.gen(function* () {
      const command = "gateway behavior add"

      let normalized: { text: string; normalizedText: string }
      try {
        normalized = normalizeDirectiveText(text)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(
          respondError(
            command,
            message,
            "INVALID_DIRECTIVE_TEXT",
            "Provide a concise directive like --text \"frequent status handoffs during delegation\"",
            defaultBehaviorNextActions(),
          ),
        )
        return
      }

      try {
        const result = yield* Effect.promise(() =>
          requireStores(async ({ redis, apiKey }) => {
            await expireStaleCandidates(apiKey)

            const contract = await loadContract(redis)
            const decision = addDirectiveToContract(contract, {
              type,
              text: normalized.text,
              normalizedText: normalized.normalizedText,
              source: "operator",
            })

            if (decision.kind === "deduped") {
              await upsertHistoryDoc(apiKey, auditDoc("directive.add.deduped", {
                status: "deduped",
                type,
                text: normalized.text,
                source: "operator",
                reason: `directive already active (${decision.existing.id})`,
                directiveId: decision.existing.id,
              }))

              return {
                action: "deduped" as const,
                contract,
                directive: decision.existing,
              }
            }

            if (decision.kind === "conflict") {
              await upsertHistoryDoc(apiKey, auditDoc("directive.add.rejected", {
                status: "rejected",
                type,
                text: normalized.text,
                source: "operator",
                reason: `conflicts with ${decision.conflictWith.type}:${decision.conflictWith.id}`,
                directiveId: decision.conflictWith.id,
              }))

              return {
                action: "conflict" as const,
                conflictWith: decision.conflictWith,
              }
            }

            if (decision.kind === "cap") {
              await upsertHistoryDoc(apiKey, auditDoc("directive.add.rejected", {
                status: "rejected",
                type,
                text: normalized.text,
                source: "operator",
                reason: `contract cap ${CONTRACT_CAP} reached`,
              }))

              return {
                action: "cap" as const,
              }
            }

            await upsertHistoryDoc(apiKey, directiveHistoryDoc(decision.directive, decision.contract.hash, "active"))
            await upsertHistoryDoc(apiKey, auditDoc("directive.added", {
              status: "active",
              type: decision.directive.type,
              text: decision.directive.text,
              source: decision.directive.source,
              directiveId: decision.directive.id,
              contractHash: decision.contract.hash,
            }))

            await persistContract(redis, decision.contract)

            return {
              action: "added" as const,
              contract: decision.contract,
              directive: decision.directive,
            }
          }),
        )

        if (result.action === "conflict") {
          yield* Console.log(
            respondError(
              command,
              `Directive conflicts with existing ${result.conflictWith.type.toUpperCase()}: ${result.conflictWith.text}`,
              "BEHAVIOR_CONFLICT",
              "Remove or rewrite the conflicting directive, then retry.",
              [
                { command: "joelclaw gateway behavior list", description: "Inspect active directives" },
                {
                  command: "joelclaw gateway behavior remove --id <directive-id>",
                  description: "Remove conflicting directive",
                  params: {
                    "directive-id": { value: result.conflictWith.id, required: true },
                  },
                },
              ],
            ),
          )
          return
        }

        if (result.action === "cap") {
          yield* Console.log(
            respondError(
              command,
              `Active contract cap reached (${CONTRACT_CAP} directives)` ,
              "BEHAVIOR_CONTRACT_CAP",
              "Remove an existing directive before adding another one.",
              [
                { command: "joelclaw gateway behavior list", description: "Inspect active directives" },
                {
                  command: "joelclaw gateway behavior remove --id <directive-id>",
                  description: "Remove a directive",
                  params: {
                    "directive-id": { description: "Directive ID from active contract", required: true },
                  },
                },
              ],
            ),
          )
          return
        }

        yield* Console.log(
          respond(
            command,
            {
              action: result.action,
              contract: {
                version: result.contract.version,
                hash: result.contract.hash,
                generatedAt: result.contract.generatedAt,
                directiveCount: result.contract.directives.length,
              },
              directive: compactDirective(result.directive),
            },
            [
              { command: "joelclaw gateway behavior list", description: "List active contract and pending candidates" },
              { command: "joelclaw gateway behavior stats", description: "Inspect behavior control-plane stats" },
            ],
          ),
        )
      } catch (error) {
        yield* Console.log(
          behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
        )
      }
    }),
).pipe(Command.withDescription("Add an operator directive to the active behavior contract"))

const behaviorList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const command = "gateway behavior list"

    try {
      const result = yield* Effect.promise(() =>
        requireStores(async ({ redis, apiKey }) => {
          const expired = await expireStaleCandidates(apiKey)
          const contract = await loadContract(redis)
          const candidates = await listPendingCandidates(apiKey)

          return {
            contract,
            candidates,
            expired,
          }
        }),
      )

      yield* Console.log(
        respond(
          command,
          {
            contract: {
              version: result.contract.version,
              hash: result.contract.hash,
              generatedAt: result.contract.generatedAt,
              directiveCount: result.contract.directives.length,
              directives: result.contract.directives.map(compactDirective),
            },
            candidates: result.candidates.map(compactCandidate),
            governance: {
              contractCap: CONTRACT_CAP,
              candidateTtlDays: CANDIDATE_TTL_DAYS,
              expiredCandidatesThisRun: result.expired.expired,
            },
          },
          [
            {
              command: "joelclaw gateway behavior add --type <type> --text <text>",
              description: "Add an operator directive",
              params: {
                type: { required: true, enum: BEHAVIOR_TYPES },
                text: { required: true },
              },
            },
            {
              command: "joelclaw gateway behavior promote --id <candidate-id>",
              description: "Promote a pending candidate",
              params: {
                "candidate-id": { required: true, description: "Candidate ID from this list" },
              },
            },
          ],
        ),
      )
    } catch (error) {
      yield* Console.log(
        behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
      )
    }
  }),
).pipe(Command.withDescription("List active behavior contract + pending candidates"))

const behaviorPromote = Command.make(
  "promote",
  { id: candidateIdOpt },
  ({ id }) =>
    Effect.gen(function* () {
      const command = "gateway behavior promote"
      const candidateId = id.trim()
      if (!candidateId) {
        yield* Console.log(
          respondError(
            command,
            "Candidate id is required",
            "MISSING_CANDIDATE_ID",
            "Pass --id <candidate-id> from `joelclaw gateway behavior list`.",
            [
              { command: "joelclaw gateway behavior list", description: "List pending candidates" },
            ],
          ),
        )
        return
      }

      try {
        const result = yield* Effect.promise(() =>
          requireStores(async ({ redis, apiKey }) => {
            await expireStaleCandidates(apiKey)

            const rawCandidate = await getHistoryDoc(apiKey, candidateId)
            if (!rawCandidate) {
              return { action: "not-found" as const }
            }

            const candidate = parseCandidate(rawCandidate)
            if (!candidate) {
              return { action: "invalid" as const }
            }

            if (candidate.status !== "pending") {
              return {
                action: "not-pending" as const,
                status: candidate.status,
              }
            }

            if (candidate.expiresAt != null && candidate.expiresAt <= nowTs()) {
              await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "expired", "candidate expired before promote"))
              await upsertHistoryDoc(apiKey, auditDoc("candidate.promote.expired", {
                status: "expired",
                type: candidate.type,
                text: candidate.text,
                source: candidate.source,
                candidateId: candidate.id,
                reason: "candidate expired before promote",
              }))
              return { action: "expired" as const }
            }

            const contract = await loadContract(redis)
            const decision = addDirectiveToContract(contract, {
              type: candidate.type,
              text: candidate.text,
              normalizedText: candidate.normalizedText,
              source: "daily-review",
              confidence: candidate.confidence,
              evidence: candidate.evidence,
              promotedFromCandidateId: candidate.id,
            })

            if (decision.kind === "deduped") {
              await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "promoted", "candidate deduped against active directive"))
              await upsertHistoryDoc(apiKey, auditDoc("candidate.promoted.deduped", {
                status: "promoted",
                type: candidate.type,
                text: candidate.text,
                source: candidate.source,
                candidateId: candidate.id,
                directiveId: decision.existing.id,
                reason: `deduped against ${decision.existing.id}`,
              }))

              return {
                action: "deduped" as const,
                contract,
                directive: decision.existing,
              }
            }

            if (decision.kind === "conflict") {
              await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "rejected", `conflicts with ${decision.conflictWith.type}:${decision.conflictWith.id}`))
              await upsertHistoryDoc(apiKey, auditDoc("candidate.promote.rejected", {
                status: "rejected",
                type: candidate.type,
                text: candidate.text,
                source: candidate.source,
                candidateId: candidate.id,
                directiveId: decision.conflictWith.id,
                reason: `conflicts with ${decision.conflictWith.type}:${decision.conflictWith.id}`,
              }))

              return {
                action: "conflict" as const,
                conflictWith: decision.conflictWith,
              }
            }

            if (decision.kind === "cap") {
              await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "rejected", `contract cap ${CONTRACT_CAP} reached`))
              await upsertHistoryDoc(apiKey, auditDoc("candidate.promote.rejected", {
                status: "rejected",
                type: candidate.type,
                text: candidate.text,
                source: candidate.source,
                candidateId: candidate.id,
                reason: `contract cap ${CONTRACT_CAP} reached`,
              }))

              return { action: "cap" as const }
            }

            await upsertHistoryDoc(apiKey, candidateStatusDoc(candidate, "promoted", "promoted to active contract"))
            await upsertHistoryDoc(apiKey, directiveHistoryDoc(decision.directive, decision.contract.hash, "active"))
            await upsertHistoryDoc(apiKey, auditDoc("candidate.promoted", {
              status: "promoted",
              type: decision.directive.type,
              text: decision.directive.text,
              source: decision.directive.source,
              candidateId: candidate.id,
              directiveId: decision.directive.id,
              contractHash: decision.contract.hash,
            }))

            await persistContract(redis, decision.contract)

            return {
              action: "promoted" as const,
              contract: decision.contract,
              directive: decision.directive,
            }
          }),
        )

        if (result.action === "not-found") {
          yield* Console.log(
            respondError(
              command,
              `Candidate not found: ${candidateId}`,
              "CANDIDATE_NOT_FOUND",
              "Run `joelclaw gateway behavior list` and retry with a pending candidate id.",
              [{ command: "joelclaw gateway behavior list", description: "List pending candidates" }],
            ),
          )
          return
        }

        if (result.action === "invalid") {
          yield* Console.log(
            respondError(
              command,
              `${candidateId} is not a candidate record`,
              "INVALID_CANDIDATE_RECORD",
              "Use an id from the candidates section in `joelclaw gateway behavior list`.",
              [{ command: "joelclaw gateway behavior list", description: "List pending candidates" }],
            ),
          )
          return
        }

        if (result.action === "not-pending") {
          yield* Console.log(
            respondError(
              command,
              `Candidate ${candidateId} is ${result.status}`,
              "CANDIDATE_NOT_PENDING",
              "Only pending candidates can be promoted.",
              [{ command: "joelclaw gateway behavior list", description: "List pending candidates" }],
            ),
          )
          return
        }

        if (result.action === "expired") {
          yield* Console.log(
            respondError(
              command,
              `Candidate ${candidateId} expired`,
              "CANDIDATE_EXPIRED",
              "Wait for the next daily review cycle or add the directive manually.",
              defaultBehaviorNextActions(),
            ),
          )
          return
        }

        if (result.action === "conflict") {
          yield* Console.log(
            respondError(
              command,
              `Candidate conflicts with active ${result.conflictWith.type.toUpperCase()}: ${result.conflictWith.text}`,
              "BEHAVIOR_CONFLICT",
              "Remove conflicting directive or manually add revised directive text.",
              [
                { command: "joelclaw gateway behavior list", description: "Inspect contract and pending candidates" },
                {
                  command: "joelclaw gateway behavior remove --id <directive-id>",
                  description: "Remove conflicting directive",
                  params: {
                    "directive-id": { value: result.conflictWith.id, required: true },
                  },
                },
              ],
            ),
          )
          return
        }

        if (result.action === "cap") {
          yield* Console.log(
            respondError(
              command,
              `Active contract cap reached (${CONTRACT_CAP} directives)` ,
              "BEHAVIOR_CONTRACT_CAP",
              "Remove an existing directive before promoting candidates.",
              [{ command: "joelclaw gateway behavior list", description: "Inspect current directives" }],
            ),
          )
          return
        }

        yield* Console.log(
          respond(
            command,
            {
              action: result.action,
              contract: {
                version: result.contract.version,
                hash: result.contract.hash,
                generatedAt: result.contract.generatedAt,
                directiveCount: result.contract.directives.length,
              },
              directive: compactDirective(result.directive),
            },
            [
              { command: "joelclaw gateway behavior list", description: "List active contract + pending candidates" },
              { command: "joelclaw gateway behavior stats", description: "Inspect behavior control-plane stats" },
            ],
          ),
        )
      } catch (error) {
        yield* Console.log(
          behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
        )
      }
    }),
).pipe(Command.withDescription("Promote a pending daily-review candidate into active contract"))

const behaviorRemove = Command.make(
  "remove",
  { id: directiveIdOpt },
  ({ id }) =>
    Effect.gen(function* () {
      const command = "gateway behavior remove"
      const directiveId = id.trim()
      if (!directiveId) {
        yield* Console.log(
          respondError(
            command,
            "Directive id is required",
            "MISSING_DIRECTIVE_ID",
            "Pass --id <directive-id> from `joelclaw gateway behavior list`.",
            [{ command: "joelclaw gateway behavior list", description: "Inspect active directives" }],
          ),
        )
        return
      }

      try {
        const result = yield* Effect.promise(() =>
          requireStores(async ({ redis, apiKey }) => {
            await expireStaleCandidates(apiKey)
            const contract = await loadContract(redis)
            const directive = contract.directives.find((entry) => entry.id === directiveId)

            if (!directive) return { removed: false as const }

            const next = nextContract(
              contract,
              contract.directives.filter((entry) => entry.id !== directiveId),
            )

            await upsertHistoryDoc(apiKey, directiveHistoryDoc(directive, next.hash, "removed"))
            await upsertHistoryDoc(apiKey, auditDoc("directive.removed", {
              status: "removed",
              type: directive.type,
              text: directive.text,
              source: "operator",
              directiveId: directive.id,
              contractHash: next.hash,
            }))

            await persistContract(redis, next)

            return {
              removed: true as const,
              directive,
              contract: next,
            }
          }),
        )

        if (!result.removed) {
          yield* Console.log(
            respondError(
              command,
              `Directive not found: ${directiveId}`,
              "DIRECTIVE_NOT_FOUND",
              "Run `joelclaw gateway behavior list` and retry with a valid directive id.",
              [{ command: "joelclaw gateway behavior list", description: "List active directives" }],
            ),
          )
          return
        }

        yield* Console.log(
          respond(
            command,
            {
              removed: compactDirective(result.directive),
              contract: {
                version: result.contract.version,
                hash: result.contract.hash,
                generatedAt: result.contract.generatedAt,
                directiveCount: result.contract.directives.length,
              },
            },
            [
              { command: "joelclaw gateway behavior list", description: "Inspect active contract" },
              defaultBehaviorNextActions()[0]!,
            ],
          ),
        )
      } catch (error) {
        yield* Console.log(
          behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
        )
      }
    }),
).pipe(Command.withDescription("Remove an active directive from the behavior contract"))

const behaviorApply = Command.make("apply", {}, () =>
  Effect.gen(function* () {
    const command = "gateway behavior apply"

    try {
      const result = yield* Effect.promise(() =>
        requireStores(async ({ redis, apiKey }) => {
          const expired = await expireStaleCandidates(apiKey)
          const contract = await loadContract(redis)
          const governed = governContractDirectives(contract.directives)

          const changed = governed.dropped.length > 0
            || governed.directives.length !== contract.directives.length

          if (!changed) {
            return {
              changed: false as const,
              expired,
              contract,
              dropped: [] as GovernDrop[],
            }
          }

          const next = nextContract(contract, governed.directives)

          for (const drop of governed.dropped) {
            await upsertHistoryDoc(apiKey, directiveHistoryDoc(drop.directive, next.hash, drop.reason === "cap" ? "capped" : "removed"))
            await upsertHistoryDoc(apiKey, auditDoc("directive.apply.dropped", {
              status: drop.reason,
              type: drop.directive.type,
              text: drop.directive.text,
              source: "operator",
              directiveId: drop.directive.id,
              contractHash: next.hash,
              reason: drop.reason,
              metadata: {
                conflictWithId: drop.conflictWithId,
              },
            }))
          }

          await persistContract(redis, next)

          return {
            changed: true as const,
            expired,
            contract: next,
            dropped: governed.dropped,
          }
        }),
      )

      yield* Console.log(
        respond(
          command,
          {
            changed: result.changed,
            contract: {
              version: result.contract.version,
              hash: result.contract.hash,
              generatedAt: result.contract.generatedAt,
              directiveCount: result.contract.directives.length,
            },
            dropped: result.dropped.map((drop) => ({
              id: drop.directive.id,
              type: drop.directive.type,
              text: drop.directive.text,
              reason: drop.reason,
              ...(drop.conflictWithId ? { conflictWithId: drop.conflictWithId } : {}),
            })),
            expiredCandidatesThisRun: result.expired.expired,
          },
          [
            { command: "joelclaw gateway behavior list", description: "Inspect normalized contract" },
            { command: "joelclaw gateway behavior stats", description: "Inspect governance stats" },
          ],
        ),
      )
    } catch (error) {
      yield* Console.log(
        behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
      )
    }
  }),
).pipe(Command.withDescription("Apply governance rules (dedupe/conflict/cap/expiry) to active contract"))

const behaviorStats = Command.make("stats", {}, () =>
  Effect.gen(function* () {
    const command = "gateway behavior stats"

    try {
      const result = yield* Effect.promise(() =>
        requireStores(async ({ redis, apiKey }) => {
          const expired = await expireStaleCandidates(apiKey)
          const contract = await loadContract(redis)

          const [
            totalDirectiveDocs,
            activeDirectiveDocs,
            removedDirectiveDocs,
            pendingCandidates,
            promotedCandidates,
            rejectedCandidates,
            expiredCandidates,
            auditEntries,
          ] = await Promise.all([
            countHistory(apiKey, "kind:=directive"),
            countHistory(apiKey, "kind:=directive && status:=active"),
            countHistory(apiKey, "kind:=directive && status:[removed,capped]"),
            countHistory(apiKey, "kind:=candidate && status:=pending"),
            countHistory(apiKey, "kind:=candidate && status:=promoted"),
            countHistory(apiKey, "kind:=candidate && status:=rejected"),
            countHistory(apiKey, "kind:=candidate && status:=expired"),
            countHistory(apiKey, "kind:=audit"),
          ])

          return {
            contract,
            expired,
            history: {
              totalDirectiveDocs,
              activeDirectiveDocs,
              removedDirectiveDocs,
              pendingCandidates,
              promotedCandidates,
              rejectedCandidates,
              expiredCandidates,
              auditEntries,
            },
          }
        }),
      )

      yield* Console.log(
        respond(
          command,
          {
            contract: {
              version: result.contract.version,
              hash: result.contract.hash,
              generatedAt: result.contract.generatedAt,
              activeDirectiveCount: result.contract.directives.length,
            },
            governance: {
              contractCap: CONTRACT_CAP,
              candidateTtlDays: CANDIDATE_TTL_DAYS,
              expiredCandidatesThisRun: result.expired.expired,
              conflictRules: {
                keep: ["stop"],
                more: ["less"],
                less: ["more"],
                stop: ["keep", "start"],
                start: ["stop"],
              },
            },
            history: result.history,
          },
          [
            { command: "joelclaw gateway behavior list", description: "Inspect active directives + pending candidates" },
            { command: "joelclaw gateway behavior apply", description: "Re-apply governance rules now" },
          ],
        ),
      )
    } catch (error) {
      yield* Console.log(
        behaviorErrorEnvelope(command, error, "Verify Redis + Typesense connectivity, then retry."),
      )
    }
  }),
).pipe(Command.withDescription("Show behavior contract and history analytics"))

export const gatewayBehaviorCmd = Command.make("behavior", {}, () =>
  Console.log(
    respond(
      "gateway behavior",
      {
        description: "Gateway behavior control plane (ADR-0211): Redis active contract + Typesense directive/candidate history",
        contract: {
          redisKey: REDIS_CONTRACT_KEY,
          cap: CONTRACT_CAP,
        },
        history: {
          collection: HISTORY_COLLECTION,
          candidateTtlDays: CANDIDATE_TTL_DAYS,
        },
        subcommands: {
          add: "joelclaw gateway behavior add --type keep|more|less|stop|start --text <text>",
          list: "joelclaw gateway behavior list",
          promote: "joelclaw gateway behavior promote --id <candidate-id>",
          remove: "joelclaw gateway behavior remove --id <directive-id>",
          apply: "joelclaw gateway behavior apply",
          stats: "joelclaw gateway behavior stats",
        },
      },
      defaultBehaviorNextActions(),
    ),
  ),
).pipe(
  Command.withDescription("Gateway behavior directives and candidate promotion"),
  Command.withSubcommands([
    behaviorAdd,
    behaviorList,
    behaviorPromote,
    behaviorRemove,
    behaviorApply,
    behaviorStats,
  ]),
)

export const __gatewayBehaviorTestUtils = {
  normalizeDirectiveText,
  addDirectiveToContract,
  governContractDirectives,
  parseContract,
  computeContractHash,
  CONTRACT_CAP,
  CANDIDATE_TTL_DAYS,
}
