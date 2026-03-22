import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ensureCollection, search, upsert } from "../../lib/typesense"
import { emitOtelEvent } from "../../observability/emit"
import { inngest } from "../client"
import { pushGatewayEvent } from "./agent-loop/utils"

const HISTORY_COLLECTION = "gateway_behavior_history"
const CANDIDATE_TTL_DAYS = Math.max(1, Number.parseInt(process.env.GATEWAY_BEHAVIOR_CANDIDATE_TTL_DAYS ?? "7", 10) || 7)
const REVIEW_WINDOW_HOURS = 24
const GATEWAY_SESSION_DIR = process.env.GATEWAY_SESSION_DIR
  ?? join(process.env.HOME ?? "/Users/joel", ".joelclaw", "sessions", "gateway")
const ENABLE_DIGEST = process.env.GATEWAY_BEHAVIOR_REVIEW_DIGEST === "1"
const MAX_EVIDENCE_SNIPPETS = 3

type SessionMessage = {
  role: "user" | "assistant"
  text: string
  timestamp: number
}

type OTelSignal = {
  action: string
  component: string
  timestamp: number
}

type PatternCandidate = {
  id: string
  bucket: "good_patterns" | "bad_patterns"
  type: "keep" | "more" | "less" | "stop" | "start"
  text: string
  normalizedText: string
  confidence: number
  evidence: string[]
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

function normalizeCandidateText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.!?;:]+$/g, "").trim().toLowerCase()
}

function clipSnippet(text: string, max = 220): string {
  const compacted = text.replace(/\s+/g, " ").trim()
  if (compacted.length <= max) return compacted
  return `${compacted.slice(0, Math.max(1, max - 1))}…`
}

function scoreFromCount(count: number, base = 0.55): number {
  return Math.min(0.95, Number((base + Math.min(count, 6) * 0.06).toFixed(2)))
}

function addDays(days: number, now = Date.now()): number {
  return now + days * 24 * 60 * 60 * 1000
}

function parseMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  const chunks = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return ""
      const block = entry as Record<string, unknown>
      if (block.type !== "text") return ""
      return typeof block.text === "string" ? block.text : ""
    })
    .filter((value) => value.length > 0)

  return chunks.join("\n").trim()
}

function parseSessionMessages(raw: string, cutoffTs: number): SessionMessage[] {
  const lines = raw.split("\n")
  const messages: SessionMessage[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type !== "message") continue

      const timestampIso = typeof parsed.timestamp === "string" ? parsed.timestamp : ""
      const timestamp = Date.parse(timestampIso)
      if (!Number.isFinite(timestamp) || timestamp < cutoffTs) continue

      const message = parsed.message as Record<string, unknown> | undefined
      if (!message) continue
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null
      if (!role) continue

      const text = parseMessageText(message.content)
      if (!text) continue

      messages.push({ role, text, timestamp })
    } catch {
      // ignore malformed lines
    }
  }

  return messages
}

function loadRecentGatewayMessages(windowHours: number): SessionMessage[] {
  if (!existsSync(GATEWAY_SESSION_DIR)) return []

  const cutoffTs = Date.now() - windowHours * 60 * 60 * 1000
  const files = readdirSync(GATEWAY_SESSION_DIR)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => ({
      path: join(GATEWAY_SESSION_DIR, entry),
      mtime: statSync(join(GATEWAY_SESSION_DIR, entry)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)

  const messages: SessionMessage[] = []
  for (const file of files) {
    if (file.mtime < cutoffTs) continue
    try {
      const raw = readFileSync(file.path, "utf-8")
      messages.push(...parseSessionMessages(raw, cutoffTs))
    } catch {
      // ignore unreadable files
    }
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp)
}

async function loadRecentGatewayOtel(windowHours: number): Promise<OTelSignal[]> {
  const cutoffTs = Date.now() - windowHours * 60 * 60 * 1000

  const result = await search({
    collection: "otel_events",
    q: "*",
    query_by: "action,component,source,error,metadata_json,search_text",
    per_page: 250,
    sort_by: "timestamp:desc",
    include_fields: "action,component,source,timestamp",
    filter_by: `timestamp:>=${cutoffTs} && source:=\`gateway\``,
  })

  const signals: OTelSignal[] = []
  for (const hit of result.hits ?? []) {
    const doc = hit.document as Record<string, unknown>
    const action = typeof doc.action === "string" ? doc.action : ""
    const component = typeof doc.component === "string" ? doc.component : ""
    const timestamp = typeof doc.timestamp === "number" && Number.isFinite(doc.timestamp)
      ? doc.timestamp
      : cutoffTs

    if (!action) continue
    signals.push({ action, component, timestamp })
  }

  return signals
}

function buildCandidates(messages: SessionMessage[], otelSignals: OTelSignal[]): PatternCandidate[] {
  const assistantMessages = messages.filter((message) => message.role === "assistant")

  const statusSignals = assistantMessages.filter((message) =>
    /\b(status:|done:|blocked:|handoff|check-?in|delegat)/i.test(message.text),
  )

  const delegationSignals = assistantMessages.filter((message) =>
    /\b(delegate|delegated|dispatch|codex|background work|handoff)/i.test(message.text),
  )

  const longMonologues = assistantMessages.filter((message) => message.text.length >= 1200)

  const heartbeatVerbosity = assistantMessages.filter((message) =>
    /heartbeat/i.test(message.text) && message.text.length >= 260,
  )

  const backgroundDispatchCount = otelSignals.filter((signal) =>
    signal.action === "events.dispatched.background_only"
      || signal.action === "outbound.console_forward.suppressed_policy",
  ).length

  const candidates: PatternCandidate[] = []

  if (statusSignals.length >= 3 || backgroundDispatchCount >= 3) {
    candidates.push({
      id: `candidate:${randomUUID()}`,
      bucket: "good_patterns",
      type: "keep",
      text: "frequent status handoffs during delegated/background work",
      normalizedText: "frequent status handoffs during delegated/background work",
      confidence: scoreFromCount(statusSignals.length + backgroundDispatchCount, 0.58),
      evidence: statusSignals.slice(0, MAX_EVIDENCE_SNIPPETS).map((entry) => clipSnippet(entry.text)),
    })
  }

  if (delegationSignals.length >= 3) {
    candidates.push({
      id: `candidate:${randomUUID()}`,
      bucket: "good_patterns",
      type: "keep",
      text: "delegate implementation quickly and stay interruptible",
      normalizedText: "delegate implementation quickly and stay interruptible",
      confidence: scoreFromCount(delegationSignals.length, 0.56),
      evidence: delegationSignals.slice(0, MAX_EVIDENCE_SNIPPETS).map((entry) => clipSnippet(entry.text)),
    })
  }

  if (longMonologues.length >= 2) {
    candidates.push({
      id: `candidate:${randomUUID()}`,
      bucket: "bad_patterns",
      type: "less",
      text: "long strategy monologues during active ops windows",
      normalizedText: "long strategy monologues during active ops windows",
      confidence: scoreFromCount(longMonologues.length, 0.6),
      evidence: longMonologues.slice(0, MAX_EVIDENCE_SNIPPETS).map((entry) => clipSnippet(entry.text)),
    })
  }

  if (heartbeatVerbosity.length >= 2) {
    candidates.push({
      id: `candidate:${randomUUID()}`,
      bucket: "bad_patterns",
      type: "stop",
      text: "redundant heartbeat verbosity",
      normalizedText: "redundant heartbeat verbosity",
      confidence: scoreFromCount(heartbeatVerbosity.length, 0.61),
      evidence: heartbeatVerbosity.slice(0, MAX_EVIDENCE_SNIPPETS).map((entry) => clipSnippet(entry.text)),
    })
  }

  // Deduplicate same type+normalized text within one review run.
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.type}:${normalizeCandidateText(candidate.normalizedText)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function existingPendingKeys(): Promise<Set<string>> {
  const currentTs = Date.now()
  const result = await search({
    collection: HISTORY_COLLECTION,
    q: "*",
    query_by: "text,reason,kind,type,status,source",
    per_page: 250,
    include_fields: "type,normalized_text",
    filter_by: `kind:=candidate && status:=pending && expires_at:>${currentTs}`,
  })

  const keys = new Set<string>()
  for (const hit of result.hits ?? []) {
    const doc = hit.document as Record<string, unknown>
    const type = typeof doc.type === "string" ? doc.type.toLowerCase() : ""
    const normalized = typeof doc.normalized_text === "string"
      ? normalizeCandidateText(doc.normalized_text)
      : ""
    if (!type || !normalized) continue
    keys.add(`${type}:${normalized}`)
  }

  return keys
}

async function expireStalePendingCandidates(): Promise<number> {
  const now = Date.now()
  const stale = await search({
    collection: HISTORY_COLLECTION,
    q: "*",
    query_by: "text,reason,kind,type,status,source",
    per_page: 250,
    include_fields: "id,type,text,normalized_text,source,confidence,evidence,created_at,expires_at",
    filter_by: `kind:=candidate && status:=pending && expires_at:<=${now}`,
  })

  let expired = 0

  for (const hit of stale.hits ?? []) {
    const doc = hit.document as Record<string, unknown>
    const id = typeof doc.id === "string" ? doc.id : ""
    if (!id) continue

    await upsert(HISTORY_COLLECTION, {
      ...doc,
      id,
      kind: "candidate",
      status: "expired",
      reason: "stale-candidate-expired",
      updated_at: now,
    })

    await upsert(HISTORY_COLLECTION, {
      id: `audit:${randomUUID()}`,
      kind: "audit",
      status: "expired",
      type: doc.type,
      text: typeof doc.text === "string" ? doc.text : "(candidate expired)",
      normalized_text: doc.normalized_text,
      source: "daily-review",
      candidate_id: id,
      reason: "stale-candidate-expired",
      created_at: now,
      metadata_json: JSON.stringify({ action: "candidate.expired" }),
    })

    expired += 1
  }

  return expired
}

export const gatewayBehaviorDailyReview = inngest.createFunction(
  {
    id: "gateway/behavior.daily-review",
    name: "Gateway behavior daily review (advisory)",
    retries: 2,
  },
  { cron: "TZ=America/Los_Angeles 15 8 * * *" },
  async ({ step }) => {
    const loaded = await step.run("load-gateway-session-evidence", async () => {
      const messages = loadRecentGatewayMessages(REVIEW_WINDOW_HOURS)
      const otel = await loadRecentGatewayOtel(REVIEW_WINDOW_HOURS)
      return {
        messageCount: messages.length,
        otelCount: otel.length,
        messages,
        otel,
      }
    })

    const candidates = await step.run("derive-behavior-candidates", async () =>
      buildCandidates(loaded.messages, loaded.otel),
    )

    const persisted = await step.run("persist-candidates", async () => {
      await ensureCollection(HISTORY_COLLECTION, HISTORY_COLLECTION_SCHEMA)
      const expired = await expireStalePendingCandidates()
      const pendingKeys = await existingPendingKeys()

      let inserted = 0
      let skippedDuplicates = 0
      const insertedCandidates: PatternCandidate[] = []

      for (const candidate of candidates) {
        const key = `${candidate.type}:${normalizeCandidateText(candidate.normalizedText)}`
        if (pendingKeys.has(key)) {
          skippedDuplicates += 1
          continue
        }

        const createdAt = Date.now()
        const expiresAt = addDays(CANDIDATE_TTL_DAYS)

        await upsert(HISTORY_COLLECTION, {
          id: candidate.id,
          kind: "candidate",
          status: "pending",
          type: candidate.type,
          text: candidate.text,
          normalized_text: candidate.normalizedText,
          source: "daily-review",
          confidence: candidate.confidence,
          evidence: candidate.evidence,
          created_at: createdAt,
          expires_at: expiresAt,
          metadata_json: JSON.stringify({
            bucket: candidate.bucket,
            windowHours: REVIEW_WINDOW_HOURS,
            advisoryOnly: true,
          }),
        })

        inserted += 1
        pendingKeys.add(key)
        insertedCandidates.push(candidate)

        await upsert(HISTORY_COLLECTION, {
          id: `audit:${randomUUID()}`,
          kind: "audit",
          status: "candidate-created",
          type: candidate.type,
          text: candidate.text,
          normalized_text: candidate.normalizedText,
          source: "daily-review",
          candidate_id: candidate.id,
          created_at: createdAt,
          metadata_json: JSON.stringify({
            action: "candidate.created",
            bucket: candidate.bucket,
            confidence: candidate.confidence,
          }),
        })
      }

      return {
        inserted,
        skippedDuplicates,
        expired,
        insertedCandidates,
      }
    })

    await step.run("emit-behavior-review-otel", async () => {
      await emitOtelEvent({
        level: candidates.length > 0 ? "info" : "debug",
        source: "worker",
        component: "gateway-behavior-review",
        action: "gateway.behavior.reviewed",
        success: true,
        metadata: {
          windowHours: REVIEW_WINDOW_HOURS,
          messageCount: loaded.messageCount,
          otelCount: loaded.otelCount,
          generatedCandidates: candidates.length,
          insertedCandidates: persisted.inserted,
          skippedDuplicates: persisted.skippedDuplicates,
          expiredCandidates: persisted.expired,
          goodPatterns: candidates.filter((candidate) => candidate.bucket === "good_patterns").length,
          badPatterns: candidates.filter((candidate) => candidate.bucket === "bad_patterns").length,
          advisoryOnly: true,
        },
      })
    })

    await step.run("optional-digest", async () => {
      if (!ENABLE_DIGEST) return { sent: false }
      if (persisted.insertedCandidates.length === 0) return { sent: false }

      const good = persisted.insertedCandidates.filter((candidate) => candidate.bucket === "good_patterns")
      const bad = persisted.insertedCandidates.filter((candidate) => candidate.bucket === "bad_patterns")

      const lines = [
        "## 📐 Gateway Behavior Candidate Review (advisory)",
        "",
        `${persisted.insertedCandidates.length} new candidate(s) from last 24h.`,
        "No auto-activation: promote manually with `joelclaw gateway behavior promote --id <candidate-id>`.",
        "",
      ]

      if (good.length > 0) {
        lines.push("### good_patterns")
        for (const candidate of good) {
          lines.push(`- ${candidate.id}: ${candidate.type.toUpperCase()} — ${candidate.text}`)
        }
        lines.push("")
      }

      if (bad.length > 0) {
        lines.push("### bad_patterns")
        for (const candidate of bad) {
          lines.push(`- ${candidate.id}: ${candidate.type.toUpperCase()} — ${candidate.text}`)
        }
        lines.push("")
      }

      await pushGatewayEvent({
        type: "gateway.behavior.review.candidates",
        source: "inngest/gateway-behavior-review",
        payload: {
          prompt: lines.join("\n").trim(),
          level: "info",
          immediateTelegram: false,
        },
      })

      return { sent: true }
    })

    return {
      advisoryOnly: true,
      windowHours: REVIEW_WINDOW_HOURS,
      messageCount: loaded.messageCount,
      otelCount: loaded.otelCount,
      generatedCandidates: candidates.length,
      insertedCandidates: persisted.inserted,
      skippedDuplicates: persisted.skippedDuplicates,
      expiredCandidates: persisted.expired,
      good_patterns: candidates
        .filter((candidate) => candidate.bucket === "good_patterns")
        .map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          text: candidate.text,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        })),
      bad_patterns: candidates
        .filter((candidate) => candidate.bucket === "bad_patterns")
        .map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          text: candidate.text,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        })),
    }
  },
)

export const __gatewayBehaviorReviewTestUtils = {
  normalizeCandidateText,
  buildCandidates,
  clipSnippet,
}
