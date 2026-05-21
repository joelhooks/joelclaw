import { Buffer } from "node:buffer"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const RUN_CHUNKS_COLLECTION = "run_chunks_dev"
const SESSION_SEARCH_SOURCES = ["typesense", "ssh", "local", "both"] as const

type SessionSearchSource = typeof SESSION_SEARCH_SOURCES[number]
type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

type SessionHit = {
  source: "typesense" | "ssh" | "local"
  id: string
  runId?: string
  sessionId?: string
  machineId?: string
  startedAt?: string
  role?: string
  path?: string
  cwdKey?: string
  score?: number
  snippets: string[]
  extraction?: Extraction | { id: string; path?: string; error: string }
}

type TypesenseHit = {
  document?: Record<string, unknown>
  highlights?: Array<{ field?: string; snippet?: string; value?: string }>
  text_match?: number
  text_match_info?: { score?: number }
}

type TypesenseSearchResponse = {
  found?: number
  hits?: TypesenseHit[]
}

type RemoteSearchResponse = {
  ok?: boolean
  host?: string
  root?: string
  query?: string
  found?: number
  searched_files?: number
  max_files?: number
  hits?: Array<{
    path?: string
    session_id?: string
    started_at?: string
    cwd_key?: string
    mtime?: string
    snippets?: string[]
  }>
  error?: string
}

function writeEnvelope(output: string): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stdout.write(output)
    process.stdout.write("\n")
  })
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function quoteFilterValue(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``
}

function timestampFromMillis(value: unknown): string | undefined {
  const millis = asNumber(value)
  return millis == null ? undefined : new Date(millis).toISOString()
}

function firstHighlight(hit: TypesenseHit): string | undefined {
  for (const highlight of hit.highlights ?? []) {
    const snippet = asString(highlight.snippet) ?? asString(highlight.value)
    if (snippet) return snippet
  }
  return undefined
}

function tagsSessionId(doc: Record<string, unknown>): string | undefined {
  const tags = Array.isArray(doc.tags) ? doc.tags : []
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith("session:")) {
      return tag.slice("session:".length)
    }
  }
  return undefined
}

async function searchTypesense(input: {
  query: string
  machine: string
  limit: number
}): Promise<{ ok: true; found: number; hits: SessionHit[] }> {
  const apiKey = resolveTypesenseApiKey()
  const params = new URLSearchParams({
    q: input.query,
    query_by: "text",
    per_page: String(input.limit),
    sort_by: "started_at:desc",
    include_fields: "id,run_id,machine_id,started_at,role,text,tags",
    exclude_fields: "embedding",
  })

  const filters = ["agent_runtime:=pi"]
  if (input.machine && input.machine !== "all") {
    filters.push(`machine_id:=${quoteFilterValue(input.machine)}`)
  }
  params.set("filter_by", filters.join(" && "))

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${RUN_CHUNKS_COLLECTION}/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )

  if (!response.ok) {
    throw new Error(`Typesense session search failed (${response.status}): ${await response.text()}`)
  }

  const body = (await response.json()) as TypesenseSearchResponse
  const hits = (body.hits ?? []).map<SessionHit>((hit) => {
    const doc = hit.document ?? {}
    const runId = asString(doc.run_id)
    const id = asString(doc.id) ?? runId ?? "unknown"
    const text = asString(doc.text)
    const snippet = firstHighlight(hit) ?? (text ? text.replace(/\s+/g, " ").slice(0, 500) : "")

    return {
      source: "typesense",
      id,
      runId,
      sessionId: tagsSessionId(doc),
      machineId: asString(doc.machine_id),
      startedAt: timestampFromMillis(doc.started_at),
      role: asString(doc.role),
      score: asNumber(hit.text_match) ?? asNumber(hit.text_match_info?.score),
      snippets: snippet ? [snippet] : [],
    }
  })

  return { ok: true, found: body.found ?? hits.length, hits }
}

const REMOTE_SESSION_SEARCH_SCRIPT = String.raw`
import base64
import datetime
import json
import os
import sys

args = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
query = str(args.get("query") or "")
limit = int(args.get("limit") or 8)
max_files = int(args.get("max_files") or 2000)
root = os.path.expanduser(str(args.get("root") or "~/.pi/agent/sessions"))
query_l = query.lower()
terms = [term for term in query_l.split() if term]

def flatten(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(flatten(item) for item in value)
    if isinstance(value, dict):
        parts = []
        for key in ("role", "type", "toolName", "name", "content", "text", "message", "arguments"):
            if key in value:
                parts.append(flatten(value.get(key)))
        if not parts:
            parts = [flatten(v) for v in value.values()]
        return " ".join(part for part in parts if part)
    return str(value)

def matches(text):
    lower = text.lower()
    if query_l and query_l in lower:
        return True
    return bool(terms) and all(term in lower for term in terms)

def snippet(text):
    clean = " ".join(text.split())
    lower = clean.lower()
    index = lower.find(query_l) if query_l else -1
    if index < 0 and terms:
        index = min([lower.find(term) for term in terms if lower.find(term) >= 0] or [-1])
    if index < 0:
        return clean[:500]
    start = max(0, index - 180)
    end = min(len(clean), index + 320)
    return clean[start:end]

def normalize_started(raw):
    # Pi filenames use 2026-05-20T15-24-37-070Z. Return ISO-ish UTC.
    try:
        date, rest = raw.split("T", 1)
        rest = rest[:-1] if rest.endswith("Z") else rest
        hour, minute, second, millis = rest.split("-", 3)
        return f"{date}T{hour}:{minute}:{second}.{millis}Z"
    except Exception:
        return raw

def session_meta(path):
    base = os.path.basename(path)
    stem = base[:-6] if base.endswith(".jsonl") else base
    if "_" in stem:
        started, session_id = stem.rsplit("_", 1)
    else:
        started, session_id = "", stem
    return normalize_started(started), session_id

files = []
for dirpath, _dirnames, filenames in os.walk(root):
    for name in filenames:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(dirpath, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        files.append((stat.st_mtime, path))
files.sort(reverse=True)

hits = []
searched = 0
for _mtime, path in files[:max_files]:
    searched += 1
    snippets = []
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                text = line
                try:
                    text = flatten(json.loads(line))
                except Exception:
                    pass
                if matches(text):
                    snippets.append(snippet(text))
                    if len(snippets) >= 3:
                        break
    except OSError:
        continue
    if not snippets:
        continue

    started, session_id = session_meta(path)
    hits.append({
        "path": path,
        "session_id": session_id,
        "started_at": started,
        "cwd_key": os.path.basename(os.path.dirname(path)),
        "mtime": datetime.datetime.fromtimestamp(_mtime, datetime.timezone.utc).isoformat(),
        "snippets": snippets,
    })
    if len(hits) >= limit:
        break

print(json.dumps({
    "ok": True,
    "root": root,
    "query": query,
    "found": len(hits),
    "searched_files": searched,
    "max_files": max_files,
    "hits": hits,
}))
`

function parseRawSessionSearch(input: {
  parsed: RemoteSearchResponse
  source: "ssh" | "local"
  machineId: string
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  if (input.parsed.ok === false) throw new Error(input.parsed.error ?? `${input.source} session search failed`)

  const hits = (input.parsed.hits ?? []).map<SessionHit>((hit) => ({
    source: input.source,
    id: asString(hit.session_id) ?? asString(hit.path) ?? "unknown",
    sessionId: asString(hit.session_id),
    machineId: input.machineId,
    startedAt: asString(hit.started_at),
    path: asString(hit.path),
    cwdKey: asString(hit.cwd_key),
    snippets: Array.isArray(hit.snippets) ? hit.snippets.filter((item): item is string => typeof item === "string") : [],
  }))

  return { ok: true, found: input.parsed.found ?? hits.length, searchedFiles: input.parsed.searched_files, hits }
}

function rawSessionPayload(input: { query: string; limit: number; maxFiles: number }): string {
  return Buffer.from(JSON.stringify({
    query: input.query,
    limit: input.limit,
    max_files: input.maxFiles,
  })).toString("base64")
}

function searchLocal(input: {
  query: string
  limit: number
  machine: string
  maxFiles: number
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  const proc = spawnSync("python3", ["-", rawSessionPayload(input)], {
    input: REMOTE_SESSION_SEARCH_SCRIPT,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 4,
  })

  if (proc.error) throw proc.error
  if (proc.status !== 0) {
    throw new Error(`local session search failed (${proc.status}): ${proc.stderr || proc.stdout}`)
  }

  return parseRawSessionSearch({
    parsed: JSON.parse(proc.stdout) as RemoteSearchResponse,
    source: "local",
    machineId: input.machine,
  })
}

function searchRemote(input: {
  query: string
  limit: number
  sshTarget: string
  maxFiles: number
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  const proc = spawnSync("ssh", [input.sshTarget, "python3", "-", rawSessionPayload(input)], {
    input: REMOTE_SESSION_SEARCH_SCRIPT,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 4,
  })

  if (proc.error) throw proc.error
  if (proc.status !== 0) {
    throw new Error(`ssh session search failed (${proc.status}): ${proc.stderr || proc.stdout}`)
  }

  return parseRawSessionSearch({
    parsed: JSON.parse(proc.stdout) as RemoteSearchResponse,
    source: "ssh",
    machineId: input.sshTarget.includes("dark-wizard") ? "dark-wizard" : input.sshTarget,
  })
}

function localHostname(): string | undefined {
  const proc = spawnSync("hostname", [], { encoding: "utf8", timeout: 2_000 })
  if (proc.status !== 0) return undefined
  return proc.stdout.trim().toLowerCase()
}

function isLocalMachine(machine: string): boolean {
  const hostname = localHostname()
  if (!hostname) return false
  const normalized = machine.toLowerCase()
  return hostname === normalized || hostname === `${normalized}.local`
}

function hasLocalTypesenseCredential(): boolean {
  if (process.env.TYPESENSE_API_KEY?.trim()) return true
  const systemBusEnv = join(process.env.HOME ?? "", ".config", "system-bus.env")
  return existsSync(systemBusEnv)
}

type TranscriptEntry = {
  line: number
  raw: unknown
  text: string
  role?: string
  kind?: string
}

type Evidence = {
  line: number
  role?: string
  kind?: string
  text: string
}

type Extraction = {
  sessionId?: string
  path: string
  startedAt?: string
  cwdKey?: string
  query: string
  lineCount: number
  evidence: Evidence[]
  userPrompts: Evidence[]
  decisions: Evidence[]
  commandsRun: Evidence[]
  filesTouched: string[]
  outputsReceipts: Evidence[]
  verification: Evidence[]
  blockers: Evidence[]
  nextActions: Evidence[]
  redacted: boolean
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]"],
  [/(authorization\s*[:=]\s*)[^\s"']+/giu, "$1[REDACTED]"],
  [/(cookie\s*[:=]\s*)[^\n]+/giu, "$1[REDACTED]"],
  [/sk_live_[A-Za-z0-9]+/gu, "sk_live_[REDACTED]"],
  [/sk_test_[A-Za-z0-9]+/gu, "sk_test_[REDACTED]"],
  [/rk_live_[A-Za-z0-9]+/gu, "rk_live_[REDACTED]"],
  [/vercel_[A-Za-z0-9]+/giu, "vercel_[REDACTED]"],
  [/lin_api_[A-Za-z0-9]+/giu, "lin_api_[REDACTED]"],
  [/[a-z][a-z0-9+.-]+:\/\/[^\s:@]+:[^\s@]+@[^\s"']+/giu, "[REDACTED_DATABASE_URL]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_PRIVATE_KEY]"],
  [/([A-Z0-9_]*(?:API|AUTH|TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)["']?[^"'\s]+["']?/giu, "$1[REDACTED]"],
]

function redactSecrets(input: string): { text: string; redacted: boolean } {
  let text = input
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return { text, redacted: text !== input }
}

function flattenTranscript(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(flattenTranscript).filter(Boolean).join(" ")
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of ["role", "type", "toolName", "name", "command", "path", "content", "text", "message", "stdout", "stderr", "arguments", "result"]) {
      if (key in record) parts.push(flattenTranscript(record[key]))
    }
    if (parts.length === 0) {
      for (const item of Object.values(record)) parts.push(flattenTranscript(item))
    }
    return parts.filter(Boolean).join(" ")
  }
  return String(value)
}

function roleOf(raw: unknown, text: string): string | undefined {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>
    const role = asString(record.role) ?? asString((record.message as Record<string, unknown> | undefined)?.role)
    if (role) return role
  }
  if (/\buser\b/i.test(text)) return "user"
  if (/\bassistant\b/i.test(text)) return "assistant"
  return undefined
}

function kindOf(raw: unknown, text: string): string | undefined {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>
    return asString(record.type) ?? asString(record.kind) ?? asString(record.toolName)
  }
  if (/toolCall|tool call/i.test(text)) return "tool_call"
  if (/toolResult|tool result/i.test(text)) return "tool_result"
  return undefined
}

function sessionMetaFromPath(path: string): { sessionId?: string; startedAt?: string; cwdKey?: string } {
  const base = path.split("/").pop() ?? path
  const stem = base.endsWith(".jsonl") ? base.slice(0, -6) : base
  const underscore = stem.lastIndexOf("_")
  const rawStarted = underscore >= 0 ? stem.slice(0, underscore) : undefined
  const sessionId = underscore >= 0 ? stem.slice(underscore + 1) : stem
  return {
    sessionId,
    startedAt: rawStarted?.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"),
    cwdKey: path.split("/").at(-2),
  }
}

function findSessionPath(idOrPath: string): string {
  if (existsSync(idOrPath)) return idOrPath
  const root = join(process.env.HOME ?? "", ".pi", "agent", "sessions")
  const matches: string[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith(".jsonl") && path.includes(idOrPath)) matches.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  if (matches.length === 0) throw new Error(`No local session transcript found for ${idOrPath}`)
  matches.sort()
  return matches.at(-1) ?? matches[0]
}

function readTranscript(path: string): { entries: TranscriptEntry[]; redacted: boolean } {
  let redacted = false
  const entries = readFileSync(path, "utf8").split("\n").flatMap((line, index): TranscriptEntry[] => {
    if (!line.trim()) return []
    let raw: unknown = line
    try { raw = JSON.parse(line) } catch { /* raw text */ }
    const flattened = flattenTranscript(raw).replace(/\s+/g, " ").trim()
    const safe = redactSecrets(flattened)
    if (safe.redacted) redacted = true
    return [{ line: index + 1, raw, text: safe.text, role: roleOf(raw, flattened), kind: kindOf(raw, flattened) }]
  })
  return { entries, redacted }
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter((term) => term.length > 2)
}

function matchesQuery(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (q && lower.includes(q)) return true
  const terms = queryTerms(query)
  return terms.length > 0 && terms.every((term) => lower.includes(term))
}

function evidence(entry: TranscriptEntry): Evidence {
  return { line: entry.line, role: entry.role, kind: entry.kind, text: entry.text.slice(0, 600) }
}

function uniqueEvidence(entries: TranscriptEntry[], limit: number): Evidence[] {
  const seen = new Set<number>()
  const out: Evidence[] = []
  for (const entry of entries) {
    if (seen.has(entry.line) || !entry.text) continue
    seen.add(entry.line)
    out.push(evidence(entry))
    if (out.length >= limit) break
  }
  return out
}

function regexEntries(entries: TranscriptEntry[], regex: RegExp, limit: number): Evidence[] {
  return uniqueEvidence(entries.filter((entry) => regex.test(entry.text)), limit)
}

function extractFiles(entries: TranscriptEntry[]): string[] {
  const files = new Set<string>()
  const filePattern = /(?:\.{0,2}\/|~\/|\/Users\/|packages\/|apps\/|docs\/|skills\/|scripts\/)[A-Za-z0-9._/@:+-]+/gu
  for (const entry of entries) {
    for (const match of entry.text.matchAll(filePattern)) files.add(match[0])
    if (files.size >= 80) break
  }
  return [...files].slice(0, 80)
}

function extractSession(idOrPath: string, query: string): Extraction {
  const path = findSessionPath(idOrPath)
  const { entries, redacted } = readTranscript(path)
  const matchedIndexes = new Set<number>()
  entries.forEach((entry, index) => {
    if (matchesQuery(entry.text, query)) {
      for (let i = Math.max(0, index - 4); i <= Math.min(entries.length - 1, index + 10); i++) matchedIndexes.add(i)
    }
  })
  const relevant = [...matchedIndexes].sort((a, b) => a - b).map((index) => entries[index])
  const fallback = relevant.length > 0 ? relevant : entries.slice(0, 80)
  const commandRe = /\b(bun|pnpm|npm|yarn|git|ssh|scp|rsync|kubectl|curl|joelclaw|slog|python3?|node|jq|rg|find|ls|cat|sed|awk)\b[^\n]{0,500}/iu
  const decisionRe = /\b(decid(?:e|ed|ing)|decision|ADR|accepted|rejected|instead|tradeoff|root cause|because)\b/iu
  const outputRe = /\b(receipt|output|result|returned|status|commit|run id|eventId|verified|passed|failed|error)\b/iu
  const verifyRe = /\b(test|check|verify|verified|passes|passed|build|tsc|biome|lint|smoke)\b/iu
  const blockerRe = /\b(blocked|blocker|fail(?:ed|ing)?|error|missing|unavailable|timeout|denied|cannot|can't|stuck)\b/iu
  const nextRe = /\b(next action|next step|TODO|follow[- ]?up|remaining|blocker|handoff)\b/iu
  return {
    ...sessionMetaFromPath(path),
    path,
    query,
    lineCount: entries.length,
    evidence: uniqueEvidence(fallback, 16),
    userPrompts: uniqueEvidence(entries.filter((entry) => entry.role === "user" && (matchesQuery(entry.text, query) || relevant.includes(entry))), 10),
    decisions: regexEntries(fallback, decisionRe, 12),
    commandsRun: regexEntries(fallback, commandRe, 16),
    filesTouched: extractFiles(fallback),
    outputsReceipts: regexEntries(fallback, outputRe, 12),
    verification: regexEntries(fallback, verifyRe, 12),
    blockers: regexEntries(fallback, blockerRe, 12),
    nextActions: regexEntries(fallback, nextRe, 10),
    redacted,
  }
}

function extractionMarkdown(extraction: Extraction): string {
  const section = (title: string, items: Evidence[]) => [`## ${title}`, ...(items.length ? items.map((item) => `- L${item.line}${item.role ? ` ${item.role}` : ""}${item.kind ? `/${item.kind}` : ""}: ${item.text}`) : ["- none found"]), ""].join("\n")
  return [
    `# Session extraction`,
    `- session: ${extraction.sessionId ?? "unknown"}`,
    `- path: ${extraction.path}`,
    `- started: ${extraction.startedAt ?? "unknown"}`,
    `- cwd: ${extraction.cwdKey ?? "unknown"}`,
    `- query: ${extraction.query}`,
    `- lines: ${extraction.lineCount}`,
    `- redacted: ${extraction.redacted}`,
    "",
    section("User prompts", extraction.userPrompts),
    section("Decisions", extraction.decisions),
    section("Commands run", extraction.commandsRun),
    `## Files touched\n${extraction.filesTouched.length ? extraction.filesTouched.map((file) => `- ${file}`).join("\n") : "- none found"}\n`,
    section("Outputs / receipts", extraction.outputsReceipts),
    section("Verification", extraction.verification),
    section("Blockers", extraction.blockers),
    section("Next actions", extraction.nextActions),
    section("Evidence", extraction.evidence),
  ].join("\n")
}

function inspectSession(idOrPath: string, around: string, before: number, after: number): { sessionId?: string; startedAt?: string; cwdKey?: string; path: string; around: string; matches: Array<{ matchLine: number; startLine: number; endLine: number; entries: Evidence[] }>; redacted: boolean } {
  const path = findSessionPath(idOrPath)
  const { entries, redacted } = readTranscript(path)
  const regex = new RegExp(around, "iu")
  const matches = entries.flatMap((entry, index) => {
    if (!regex.test(entry.text)) return []
    const start = Math.max(0, index - before)
    const end = Math.min(entries.length - 1, index + after)
    return [{ matchLine: entry.line, startLine: entries[start]?.line ?? entry.line, endLine: entries[end]?.line ?? entry.line, entries: entries.slice(start, end + 1).map(evidence) }]
  }).slice(0, 8)
  return { ...sessionMetaFromPath(path), path, around, matches, redacted }
}

type SignalKind = "friction" | "preference" | "decision" | "praise" | "correction" | "workflow-pattern" | "failure" | "repair-request" | "any"

type ImprovementSurface = "system-prompt" | "skill" | "cli" | "harness" | "docs" | "memory" | "adr" | "none"

type ImprovementRoute = {
  machineState: "unrouted" | "routeByCategory" | "routeBySignals" | "assignSurface" | "done"
  surface: ImprovementSurface
  target?: string
  confidence: "low" | "medium" | "high"
  reviewPriority: "low" | "normal" | "high"
  suggestedNextStep: string
  reason: string
}

type TurnKind = "operator_intent" | "task_payload" | "source_material" | "review_feedback" | "handoff" | "approval" | "unknown"

type FrictionHit = {
  sessionId?: string
  path: string
  startedAt?: string
  cwdKey?: string
  line: number
  phrase: string
  kind: Exclude<SignalKind, "any">
  category: string
  severity: "low" | "medium" | "high"
  signals: string[]
  turnKind: TurnKind
  userTurn: Evidence
  previousAssistant?: Evidence
  nextAssistant?: Evidence
  evidence: Evidence[]
  improvement?: ImprovementRoute
}

const DEFAULT_FRICTION_PHRASES = [
  "don't",
  "dont",
  "stop",
  "why did you",
  "i asked",
  "not that",
  "generic",
  "sludge",
  "pisses me off",
  "pissed me off",
  "wrong",
  "stale",
  "not what i asked",
  "you should",
  "instead",
  "bullshit",
  "dogshit",
  "horseshit",
  "trash",
  "garbage",
  "sucks",
]

const DEFAULT_SIGNAL_PHRASES = [
  ...DEFAULT_FRICTION_PHRASES,
  "fuck",
  "fucking",
  "fuckin",
  "fuck yeah",
  "fuckin love",
  "love this",
  "approved",
  "ship it",
  "remember this",
  "capture this",
  "make this durable",
  "this is the pattern",
  "we should",
  "the rule is",
]

function parseSinceMs(input: string): number {
  const trimmed = input.trim().toLowerCase()
  const match = trimmed.match(/^(\d+)([hdw])$/u)
  if (!match) return 14 * 24 * 60 * 60 * 1000
  const amount = Number(match[1])
  const unit = match[2]
  if (unit === "h") return amount * 60 * 60 * 1000
  if (unit === "d") return amount * 24 * 60 * 60 * 1000
  return amount * 7 * 24 * 60 * 60 * 1000
}

function listLocalSessionFiles(maxFiles: number, since: string): string[] {
  const root = join(process.env.HOME ?? "", ".pi", "agent", "sessions")
  const cutoff = Date.now() - parseSinceMs(since)
  const files: Array<{ path: string; mtime: number }> = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith(".jsonl") && stat.mtimeMs >= cutoff) files.push({ path, mtime: stat.mtimeMs })
    }
  }
  if (existsSync(root)) walk(root)
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((file) => file.path)
}

function matchedPhrase(text: string, phrases = DEFAULT_SIGNAL_PHRASES): string | undefined {
  const lower = text.toLowerCase()
  return phrases.find((phrase) => lower.includes(phrase))
}

function classifyTurnKind(text: string): TurnKind {
  const normalized = text.toLowerCase().replace(/^message user text\s+/u, "").trim()
  if (normalized.startsWith("## review feedback from cursor") || normalized.includes("i edited last assistant message")) return "review_feedback"
  if (normalized.startsWith("## handoff") || normalized.startsWith("handoff:") || normalized.startsWith("continue ") || normalized.startsWith("you are taking over from") || normalized.startsWith("## session recovery")) return "handoff"
  if (normalized.startsWith("task:") || normalized.startsWith("[read from:") || normalized.includes("read this transcript chunk in full") || normalized.includes("your job is ")) return "task_payload"
  if (normalized.startsWith("<skill ") || normalized.startsWith("# session briefing") || normalized.includes("<read-files>") || normalized.includes("<modified-files>") || normalized.includes("```md")) return "source_material"
  if (/^(approved|ship it|sure|yes|yep|ok|do it)\b/u.test(normalized)) return "approval"
  if (normalized.length > 1800 && /context:|goal:|requirements:|current state:|instructions:/u.test(normalized)) return "task_payload"
  return "operator_intent"
}

function isSignalEligibleTurn(turnKind: TurnKind): boolean {
  return turnKind === "operator_intent" || turnKind === "review_feedback" || turnKind === "approval"
}

function classifySignal(text: string): { kind: Exclude<SignalKind, "any">; category: string; severity: "low" | "medium" | "high"; signals: string[] } {
  const lower = text.toLowerCase()
  const signals: string[] = []
  if (/fuck|fucking|fuckin/u.test(lower)) signals.push("strong-emphasis")
  if (/bullshit|dogshit|horseshit|trash|garbage|sucks|sludge/u.test(lower)) signals.push("output-or-process-insult")
  if (/don't|dont|stop|why did you|i asked|not that|not what i asked|wrong|stale|generic/u.test(lower)) signals.push("user-correction")
  if (/remember this|capture this|make this durable|the rule is|this is the pattern/u.test(lower)) signals.push("memory-worthy")
  if (/approved|ship it|fuck yeah|love this|fuckin love/u.test(lower)) signals.push("approval-or-praise")
  if (/we should|decision|decided|the rule is/u.test(lower)) signals.push("decision-or-preference")

  if (/stale|old|current-session echo|source material|tweet archive/u.test(lower)) return { kind: "friction", category: "stale-or-wrong-context", severity: "high", signals }
  if (/generic|sludge|fluff|bullshit|dogshit|horseshit|trash|garbage|sucks/u.test(lower)) return { kind: "friction", category: "generic-or-bad-output", severity: "high", signals }
  if (/wrong|not that|not what i asked|i asked|why did you/u.test(lower)) return { kind: "friction", category: "ignored-or-misread-instruction", severity: "high", signals }
  if (/don't|dont|stop/u.test(lower)) return { kind: "friction", category: "violated-preference-or-boundary", severity: "high", signals }
  if (/piss|pissed/u.test(lower)) return { kind: "friction", category: "operator-frustration", severity: "high", signals }
  if (/approved|ship it|fuck yeah|love this|fuckin love/u.test(lower)) return { kind: "praise", category: "approval-or-positive-preference", severity: "medium", signals }
  if (/remember this|capture this|make this durable|this is the pattern/u.test(lower)) return { kind: "preference", category: "memory-worthy-guidance", severity: "high", signals }
  if (/we should|the rule is|decision|decided/u.test(lower)) return { kind: "decision", category: "decision-or-rule", severity: "medium", signals }
  if (/fuck|fucking|fuckin/u.test(lower)) return { kind: "workflow-pattern", category: "strong-emphasis", severity: "medium", signals }
  return { kind: "correction", category: "correction", severity: "low", signals }
}

function nearbyAssistant(entries: TranscriptEntry[], index: number, direction: -1 | 1): Evidence | undefined {
  for (let offset = 1; offset <= 8; offset++) {
    const entry = entries[index + offset * direction]
    if (!entry) break
    if (entry.role === "assistant") return evidence(entry)
  }
  return undefined
}

function mineSignalsFromSession(path: string, kind: SignalKind, phrases = DEFAULT_SIGNAL_PHRASES): FrictionHit[] {
  const { entries } = readTranscript(path)
  const meta = sessionMetaFromPath(path)
  return entries.flatMap((entry, index): FrictionHit[] => {
    if (entry.role !== "user") return []
    if (entry.kind && /tool|custom|system|summary|briefing/i.test(entry.kind)) return []
    const turnKind = classifyTurnKind(entry.text)
    if (!isSignalEligibleTurn(turnKind)) return []
    const phrase = matchedPhrase(entry.text, phrases)
    if (!phrase) return []
    const classified = classifySignal(entry.text)
    if (kind !== "any" && classified.kind !== kind) return []
    const start = Math.max(0, index - 3)
    const end = Math.min(entries.length - 1, index + 5)
    return [{
      ...meta,
      path,
      line: entry.line,
      phrase,
      ...classified,
      turnKind,
      userTurn: evidence(entry),
      previousAssistant: nearbyAssistant(entries, index, -1),
      nextAssistant: nearbyAssistant(entries, index, 1),
      evidence: entries.slice(start, end + 1).map(evidence),
    }]
  })
}

function routeSignalImprovement(hit: FrictionHit): ImprovementRoute {
  const base = { machineState: "done" as const }
  if (hit.category === "stale-or-wrong-context") {
    return { ...base, surface: "skill", target: "session-search", confidence: "high", reviewPriority: "high", suggestedNextStep: "Tighten source-material/current-session/user-turn distinction in the session-search skill or prompt guidance", reason: "stale/wrong context failures usually mean retrieval or recovery instructions are underspecified" }
  }
  if (hit.category === "generic-or-bad-output") {
    return { ...base, surface: "skill", target: "joel-writing-style", confidence: "high", reviewPriority: "high", suggestedNextStep: "Add a concrete anti-sludge example or tighten output-quality guidance", reason: "generic/bad output is usually a writing-style or task-framing failure" }
  }
  if (hit.category === "ignored-or-misread-instruction") {
    return { ...base, surface: "harness", target: "instruction-following review", confidence: "high", reviewPriority: "high", suggestedNextStep: "Review the previous assistant/action and add a harness guard if this instruction miss recurs", reason: "wrong/not-that/I-asked signals usually mean the agent violated or misread a concrete instruction" }
  }
  if (hit.category === "violated-preference-or-boundary") {
    return { ...base, surface: "system-prompt", target: "SOUL/agency guidance proposal", confidence: "medium", reviewPriority: "high", suggestedNextStep: "Propose a prompt or skill clarification only if the same boundary violation recurs", reason: "explicit stop/don't corrections indicate preference or boundary handling" }
  }
  if (hit.category === "operator-frustration") {
    return { ...base, surface: "harness", target: "prompt/harness tuning dataset", confidence: "medium", reviewPriority: "high", suggestedNextStep: "Review adjacent evidence and route the repeated frustration to a prompt, skill, or harness patch", reason: "operator frustration is high-signal but needs context before choosing a mutation surface" }
  }
  if (hit.signals.includes("memory-worthy")) {
    return { ...base, surface: "memory", target: "memory proposal", confidence: "high", reviewPriority: "high", suggestedNextStep: "Stage derived reusable guidance, not raw transcript text", reason: "memory-worthy signal was explicit in the user turn" }
  }
  if (hit.kind === "decision") {
    return { ...base, surface: "adr", target: "docs/decisions or project docs", confidence: "high", reviewPriority: "normal", suggestedNextStep: "Consider ADR/docs capture if the decision is durable, surprising, and trade-off backed", reason: "decision/rule signals may need durable architectural context" }
  }
  if (hit.kind === "praise") {
    return { ...base, surface: "skill", target: "positive pattern candidate", confidence: "medium", reviewPriority: "normal", suggestedNextStep: "Preserve the behavior as a positive example if repeated", reason: "praise/approval identifies harness behavior worth keeping" }
  }
  if (hit.signals.includes("strong-emphasis")) {
    return { ...base, surface: "harness", target: "prompt/harness tuning dataset", confidence: "medium", reviewPriority: hit.severity === "high" ? "high" : "low", suggestedNextStep: "Use as high-signal review example before changing prompts", reason: "strong emphasis marks an important turn but does not identify the fix surface by itself" }
  }
  if (hit.kind === "correction") {
    return { ...base, surface: "docs", target: "task or skill docs", confidence: "low", reviewPriority: "low", suggestedNextStep: "Review adjacent evidence and route manually if repeated", reason: "low-confidence correction needs human/agent review before mutation" }
  }
  return { ...base, surface: "none", confidence: "low", reviewPriority: "low", suggestedNextStep: "No obvious system improvement route yet", reason: "signal did not match a routing rule" }
}

function routeSignals(hits: FrictionHit[]): FrictionHit[] {
  return hits.map((hit) => ({ ...hit, improvement: routeSignalImprovement(hit) }))
}

function evaluateRoutes(hits: FrictionHit[]): { total: number; routed: number; unrouted: number; bySurface: Record<string, number>; byKind: Record<string, number>; byTurnKind: Record<string, number>; byConfidence: Record<string, number>; byReviewPriority: Record<string, number>; warnings: string[] } {
  const bySurface: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byTurnKind: Record<string, number> = {}
  const byConfidence: Record<string, number> = {}
  const byReviewPriority: Record<string, number> = {}
  const warnings: string[] = []
  for (const hit of hits) {
    const surface = hit.improvement?.surface ?? "none"
    bySurface[surface] = (bySurface[surface] ?? 0) + 1
    byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1
    byTurnKind[hit.turnKind] = (byTurnKind[hit.turnKind] ?? 0) + 1
    const confidence = hit.improvement?.confidence ?? "low"
    const priority = hit.improvement?.reviewPriority ?? "low"
    byConfidence[confidence] = (byConfidence[confidence] ?? 0) + 1
    byReviewPriority[priority] = (byReviewPriority[priority] ?? 0) + 1
  }
  const routed = hits.filter((hit) => hit.improvement && hit.improvement.surface !== "none").length
  if ((bySurface.none ?? 0) > 0) warnings.push("Some signals have no improvement route; label them in review-out before tuning rules")
  if ((bySurface["system-prompt"] ?? 0) > 0) warnings.push("System-prompt routes require proposal/review, not unilateral SOUL.md edits")
  return { total: hits.length, routed, unrouted: hits.length - routed, bySurface, byKind, byTurnKind, byConfidence, byReviewPriority, warnings }
}

function signalHitId(hit: FrictionHit): string {
  return createHash("sha256").update(`${hit.path}:${hit.line}:${hit.kind}:${hit.category}:${hit.phrase}`).digest("hex").slice(0, 16)
}

function sampleSignals(hits: FrictionHit[], sample: number): FrictionHit[] {
  if (sample <= 0 || hits.length <= sample) return hits
  const buckets = new Map<string, FrictionHit[]>()
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.category}`
    buckets.set(key, [...(buckets.get(key) ?? []), hit])
  }
  const out: FrictionHit[] = []
  const bucketList = [...buckets.values()].sort((a, b) => b.length - a.length)
  let index = 0
  while (out.length < sample && bucketList.some((bucket) => index < bucket.length)) {
    for (const bucket of bucketList) {
      const hit = bucket[index]
      if (hit) out.push(hit)
      if (out.length >= sample) break
    }
    index++
  }
  return out
}

function reviewRow(hit: FrictionHit): Record<string, unknown> {
  return {
    hitId: signalHitId(hit),
    verdict: null,
    correctedKind: null,
    note: null,
    predictedKind: hit.kind,
    predictedCategory: hit.category,
    turnKind: hit.turnKind,
    improvement: hit.improvement,
    severity: hit.severity,
    signals: hit.signals,
    phrase: hit.phrase,
    path: hit.path,
    line: hit.line,
    text: hit.userTurn.text,
    previousAssistant: hit.previousAssistant?.text,
    nextAssistant: hit.nextAssistant?.text,
  }
}

function writeReviewOut(path: string, hits: FrictionHit[]): { path: string; rows: number } {
  const expanded = path.startsWith("~/") ? join(process.env.HOME ?? "", path.slice(2)) : path
  mkdirSync(dirname(expanded), { recursive: true })
  writeFileSync(expanded, `${hits.map((hit) => JSON.stringify(reviewRow(hit))).join("\n")}\n`, "utf8")
  return { path: expanded, rows: hits.length }
}

function summarizeFriction(hits: FrictionHit[]): Array<{ kind: string; category: string; count: number; severity: string; examples: Array<{ path: string; line: number; phrase: string; text: string }> }> {
  const byCategory = new Map<string, FrictionHit[]>()
  for (const hit of hits) byCategory.set(hit.category, [...(byCategory.get(hit.category) ?? []), hit])
  return [...byCategory.entries()]
    .map(([category, items]) => ({
      kind: items[0]?.kind ?? "unknown",
      category,
      count: items.length,
      severity: items.some((item) => item.severity === "high") ? "high" : items.some((item) => item.severity === "medium") ? "medium" : "low",
      examples: items.slice(0, 3).map((item) => ({ path: item.path, line: item.line, phrase: item.phrase, text: item.userTurn.text })),
    }))
    .sort((a, b) => b.count - a.count)
}

async function searchTypesenseChunks(input: { query: string; machine: string; limit: number }): Promise<{ found: number; chunks: SessionHit[]; unavailable?: string }> {
  try {
    const result = await searchTypesense(input)
    return { found: result.found, chunks: result.hits }
  } catch (error) {
    return { found: 0, chunks: [], unavailable: error instanceof Error ? error.message : String(error) }
  }
}

function mergeHits(typesenseHits: SessionHit[], sshHits: SessionHit[], limit: number): SessionHit[] {
  const merged: SessionHit[] = []
  const seen = new Set<string>()
  for (const hit of [...typesenseHits, ...sshHits]) {
    const key = hit.runId ?? hit.sessionId ?? hit.path ?? hit.id
    if (seen.has(`${hit.source}:${key}`)) continue
    seen.add(`${hit.source}:${key}`)
    merged.push(hit)
    if (merged.length >= limit * 2) break
  }
  return merged
}

const searchQueryArg = Args.text({ name: "query" }).pipe(
  Args.withDescription("Search query for session/run text")
)

const sourceOpt = Options.choice("source", SESSION_SEARCH_SOURCES).pipe(
  Options.withDefault("both" as SessionSearchSource),
  Options.withDescription("Search source: Typesense derived chunks, local raw Pi sessions, SSH raw Pi sessions, or both")
)

const machineOpt = Options.text("machine").pipe(
  Options.withDefault("dark-wizard"),
  Options.withDescription("Machine filter for Typesense results; use 'all' for every machine")
)

const sshTargetOpt = Options.text("ssh-target").pipe(
  Options.withDefault("joel@dark-wizard"),
  Options.withDescription("SSH target for raw remote Pi session search")
)

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDefault(8),
  Options.withDescription("Results per source")
)

const maxFilesOpt = Options.integer("max-files").pipe(
  Options.withDefault(2000),
  Options.withDescription("Maximum remote .jsonl files to scan over SSH")
)

const extractOpt = Options.boolean("extract").pipe(
  Options.withDefault(false),
  Options.withDescription("Extract bounded task context for matching local/raw session hits")
)

const formatOpt = Options.choice("format", ["json", "markdown"] as const).pipe(
  Options.withDefault("json" as const),
  Options.withDescription("Output format for extraction payloads")
)

const contextBeforeOpt = Options.integer("context-before").pipe(
  Options.withDefault(2),
  Options.withDescription("Chunks or transcript lines before a match")
)

const contextAfterOpt = Options.integer("context-after").pipe(
  Options.withDefault(4),
  Options.withDescription("Chunks or transcript lines after a match")
)

const beforeOpt = Options.integer("before").pipe(
  Options.withDefault(20),
  Options.withDescription("Transcript lines before inspect match")
)

const afterOpt = Options.integer("after").pipe(
  Options.withDefault(80),
  Options.withDescription("Transcript lines after inspect match")
)

const aroundOpt = Options.text("around").pipe(
  Options.withDescription("Regex to inspect around")
)

const extractQueryOpt = Options.text("query").pipe(
  Options.withDefault(""),
  Options.withDescription("Topic/query to extract relevant context for")
)

const sinceOpt = Options.text("since").pipe(
  Options.withDefault("14d"),
  Options.withDescription("Time window for local signal mining, e.g. 24h, 7d, 4w")
)

const signalKindOpt = Options.choice("kind", ["friction", "preference", "decision", "praise", "correction", "workflow-pattern", "failure", "repair-request", "any"] as const).pipe(
  Options.withDefault("friction" as const),
  Options.withDescription("Session signal kind to mine")
)

const sampleOpt = Options.integer("sample").pipe(
  Options.withDefault(0),
  Options.withDescription("Balanced sample size across signal categories; 0 disables sampling")
)

const reviewOutOpt = Options.text("review-out").pipe(
  Options.optional,
  Options.withDescription("Write sampled candidates as JSONL review rows for golden-set labeling")
)

const evaluateOpt = Options.boolean("evaluate").pipe(
  Options.withDefault(false),
  Options.withDescription("Include a small routing evaluation summary for sampled/emitted signals")
)

const sessionArg = Args.text({ name: "session-id-or-path" }).pipe(
  Args.withDescription("Local raw session JSONL path or session id substring")
)

const searchCmd = Command.make(
  "search",
  {
    query: searchQueryArg,
    source: sourceOpt,
    machine: machineOpt,
    sshTarget: sshTargetOpt,
    limit: limitOpt,
    maxFiles: maxFilesOpt,
    extract: extractOpt,
  },
  ({ query, source, machine, sshTarget, limit, maxFiles, extract }) =>
    Effect.gen(function* () {
      try {
        const rawSource = source === "both"
          ? (isLocalMachine(machine) ? "local" : "ssh")
          : source
        const sources = source === "both" ? ["typesense", rawSource] as const : [rawSource]
        const skipTypesense = source === "both" && rawSource === "local" && !hasLocalTypesenseCredential()
        let typesenseUnavailable: string | undefined
        const typesense = sources.includes("typesense") && !skipTypesense
          ? yield* Effect.promise(async () => {
            try {
              return await searchTypesense({ query, machine, limit })
            } catch (error) {
              if (source === "both") {
                typesenseUnavailable = error instanceof Error ? error.message : String(error)
                return undefined
              }
              throw error
            }
          })
          : undefined
        const local = sources.includes("local")
          ? searchLocal({ query, limit, machine, maxFiles })
          : undefined
        const remote = sources.includes("ssh")
          ? searchRemote({ query, limit, sshTarget, maxFiles })
          : undefined

        const hits = mergeHits(typesense?.hits ?? [], [...(local?.hits ?? []), ...(remote?.hits ?? [])], limit)

        const hitsWithExtractions = extract
          ? hits.map((hit) => {
            if (!hit.path) return hit
            try { return { ...hit, extraction: extractSession(hit.path, query) } }
            catch (error) { return { ...hit, extraction: { id: hit.id, path: hit.path, error: error instanceof Error ? error.message : String(error) } } }
          })
          : hits
        const extractions = extract
          ? hitsWithExtractions.flatMap((hit) => hit.extraction ? [hit.extraction] : [])
          : undefined

        yield* writeEnvelope(respond("sessions search", {
          query,
          source,
          resolvedRawSource: source === "both" ? rawSource : undefined,
          machine,
          sshTarget: sources.includes("ssh") ? sshTarget : undefined,
          typesense: typesense ? { found: typesense.found, returned: typesense.hits.length } : undefined,
          typesenseSkipped: skipTypesense ? "missing local TYPESENSE_API_KEY or ~/.config/system-bus.env; raw local search still ran" : undefined,
          typesenseUnavailable,
          local: local ? { found: local.found, rawReturned: local.hits.length, emittedHits: hitsWithExtractions.filter((hit) => hit.source === "local").length, searchedFiles: local.searchedFiles } : undefined,
          ssh: remote ? { found: remote.found, rawReturned: remote.hits.length, emittedHits: hitsWithExtractions.filter((hit) => hit.source === "ssh").length, searchedFiles: remote.searchedFiles } : undefined,
          hits: hitsWithExtractions,
          extractions,
        }, [
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source typesense --machine ${machine} --limit ${limit}`,
            description: "Search Central Typesense session chunks only",
          },
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source local --machine ${machine} --limit ${limit}`,
            description: "Search raw local Pi session files",
          },
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source ssh --ssh-target ${sshTarget} --limit ${limit}`,
            description: "Search raw remote Pi session files over SSH",
          },
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source ${source} --machine ${machine} --limit ${limit} --extract`,
            description: "Search and extract bounded task context from top raw hits",
          },
          {
            command: "knowledge search \"typesense session indexing recovery runbook\"",
            description: "Find the recovery runbook when Typesense is stale or session search looks wrong",
          },
        ]))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* writeEnvelope(respondError(
            "sessions search",
            error.message,
            error.code,
            error.fix,
            [
              { command: "secrets status", description: "Check agent-secrets health" },
              { command: "sessions search <query> --source local", description: "Bypass Typesense and search raw local session files", params: { query: { required: true } } },
              { command: "sessions search <query> --source ssh", description: "Bypass Typesense and search raw remote session files", params: { query: { required: true } } },
            ]
          ))
          return
        }

        const message = error instanceof Error ? error.message : String(error)
        const code = message.includes("ssh") ? "SESSION_SEARCH_SSH_FAILED" : "SESSION_SEARCH_FAILED"
        yield* writeEnvelope(respondError(
          "sessions search",
          message,
          code,
          code === "SESSION_SEARCH_SSH_FAILED"
            ? "Verify SSH access: ssh joel@dark-wizard 'hostname && python3 --version'"
            : message.includes("local session search")
              ? "Verify local Pi sessions and Python: python3 --version && find ~/.pi/agent/sessions -type f -name '*.jsonl' | head"
              : "Check Typesense health and the session indexing runbook",
          [
            { command: "status", description: "Check joelclaw service health" },
            { command: "knowledge search \"typesense session indexing recovery runbook\"", description: "Find the session indexing recovery runbook" },
          ]
        ))
      }
    })
).pipe(Command.withDescription("Search captured Runs and raw remote Pi sessions"))

const extractCmd = Command.make(
  "extract",
  { session: sessionArg, query: extractQueryOpt, format: formatOpt },
  ({ session, query, format }) => Effect.gen(function* () {
    try {
      const extraction = extractSession(session, query || session)
      yield* writeEnvelope(respond("sessions extract", {
        format,
        extraction,
        markdown: format === "markdown" ? extractionMarkdown(extraction) : undefined,
      }, [
        { command: `sessions inspect ${JSON.stringify(extraction.path)} --around <regex>`, description: "Inspect exact transcript lines around a regex", params: { regex: { required: true } } },
        { command: `sessions extract ${JSON.stringify(extraction.path)} --query ${JSON.stringify(query || session)} --format markdown`, description: "Render the same extraction as markdown" },
      ]))
    } catch (error) {
      yield* writeEnvelope(respondError("sessions extract", error instanceof Error ? error.message : String(error), "SESSION_EXTRACT_FAILED", "Verify the session id/path exists locally under ~/.pi/agent/sessions", [
        { command: "sessions search <query> --source local --extract", description: "Find local candidate sessions first", params: { query: { required: true } } },
      ]))
    }
  })
).pipe(Command.withDescription("Extract bounded task context from a raw local session transcript"))

const inspectCmd = Command.make(
  "inspect",
  { session: sessionArg, around: aroundOpt, before: beforeOpt, after: afterOpt },
  ({ session, around, before, after }) => Effect.gen(function* () {
    try {
      yield* writeEnvelope(respond("sessions inspect", inspectSession(session, around, before, after), [
        { command: `sessions extract ${JSON.stringify(session)} --query ${JSON.stringify(around)}`, description: "Extract structured task context for this match" },
      ]))
    } catch (error) {
      yield* writeEnvelope(respondError("sessions inspect", error instanceof Error ? error.message : String(error), "SESSION_INSPECT_FAILED", "Verify the regex and local session id/path", []))
    }
  })
).pipe(Command.withDescription("Deterministically inspect raw transcript lines around a regex"))

function signalCommand(name: "signals" | "friction", fixedKind?: SignalKind) {
  return Command.make(
    name,
    { source: sourceOpt, machine: machineOpt, sshTarget: sshTargetOpt, limit: limitOpt, maxFiles: maxFilesOpt, since: sinceOpt, kind: signalKindOpt, sample: sampleOpt, reviewOut: reviewOutOpt, evaluate: evaluateOpt },
    ({ source, machine, sshTarget, limit, maxFiles, since, kind, sample, reviewOut, evaluate }) => Effect.gen(function* () {
      const resolvedKind = fixedKind ?? kind
      try {
        if (source === "typesense") {
          yield* writeEnvelope(respondError(`sessions ${name}`, "Typesense-only signal mining is not supported yet because it needs role-aware raw transcript context", "SIGNALS_TYPESENSE_UNSUPPORTED", "Use --source local on the Machine with raw Pi sessions, or --source both from Central to relay to the satellite", [
            { command: `joelclaw session ${name} --source local --machine <machine>`, description: "Mine local raw session transcripts", params: { machine: { value: machine } } },
          ]))
          return
        }

        if (source === "ssh" || (source === "both" && !isLocalMachine(machine))) {
          const reviewPath = parseOptionalText(reviewOut)
          const remote = `joelclaw session ${name} --source local --machine ${machine} --limit ${limit} --max-files ${maxFiles} --since ${since}${sample > 0 ? ` --sample ${sample}` : ""}${evaluate ? " --evaluate" : ""}${reviewPath ? ` --review-out ${JSON.stringify(reviewPath)}` : ""}${fixedKind ? "" : ` --kind ${resolvedKind}`}`
          const proc = spawnSync("ssh", [sshTarget, remote], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 * 8 })
          if (proc.status !== 0 || proc.error) throw new Error(proc.stderr || proc.stdout || proc.error?.message || "remote signal mining failed")
          process.stdout.write(proc.stdout.endsWith("\n") ? proc.stdout : `${proc.stdout}\n`)
          return
        }

        const files = listLocalSessionFiles(maxFiles, since)
        const allHits = files.flatMap((path) => mineSignalsFromSession(path, resolvedKind))
        const routedSample = routeSignals(sampleSignals(allHits, sample))
        const hits = routedSample.slice(0, limit)
        const reviewPath = parseOptionalText(reviewOut)
        const review = reviewPath ? writeReviewOut(reviewPath, hits) : undefined
        yield* writeEnvelope(respond(`sessions ${name}`, {
          kind: resolvedKind,
          source,
          resolvedRawSource: "local",
          machine,
          since,
          scannedFiles: files.length,
          found: allHits.length,
          sampledHits: routedSample.length,
          emittedHits: hits.length,
          review,
          evaluation: evaluate ? evaluateRoutes(hits) : undefined,
          actorFilter: "role=user only in v1; assistant/tool turns are included only as evidence context",
          turnKindFilter: "operator_intent, review_feedback, and approval only; task_payload/source_material/handoff are excluded by default",
          identityFilter: "best-effort local user; explicit user identity metadata is not available in raw Pi JSONL yet",
          phrases: resolvedKind === "friction" ? DEFAULT_FRICTION_PHRASES : DEFAULT_SIGNAL_PHRASES,
          clusters: summarizeFriction(allHits),
          hits: hits.map((hit) => ({ hitId: signalHitId(hit), ...hit })),
        }, [
          { command: "joelclaw session inspect <session-id-or-path> --around <regex>", description: "Verify a signal hit with exact surrounding transcript lines", params: { "session-id-or-path": { required: true }, regex: { required: true } } },
          { command: "joelclaw session search <query> --extract", description: "Recover broader task context for a signal hit", params: { query: { required: true } } },
        ]))
      } catch (error) {
        yield* writeEnvelope(respondError(`sessions ${name}`, error instanceof Error ? error.message : String(error), "SIGNAL_MINING_FAILED", "Verify raw session files and rerun with --source local on the target Machine", [
          { command: "joelclaw satellite health --notify", description: "Ask Central for repair if this satellite looks broken" },
        ]))
      }
    })
  ).pipe(Command.withDescription(name === "friction" ? "Alias for sessions signals --kind friction" : "Mine role-aware high-signal user turns from raw session transcripts"))
}

const signalsCmd = signalCommand("signals")
const frictionCmd = signalCommand("friction", "friction")

const chunksCmd = Command.make(
  "chunks",
  { query: searchQueryArg, source: sourceOpt, machine: machineOpt, limit: limitOpt, maxFiles: maxFilesOpt, contextBefore: contextBeforeOpt, contextAfter: contextAfterOpt },
  ({ query, source, machine, limit, maxFiles, contextBefore, contextAfter }) => Effect.gen(function* () {
    const rawSource = source === "both" ? (isLocalMachine(machine) ? "local" : "ssh") : source
    const allChunks: unknown[] = []
    const chunks: Record<string, unknown> = { query, source, resolvedRawSource: source === "both" ? rawSource : undefined, machine, contextBefore, contextAfter }
    if ((source === "typesense" || source === "both") && !(source === "both" && rawSource === "local" && !hasLocalTypesenseCredential())) {
      const typesenseChunks = yield* Effect.promise(() => searchTypesenseChunks({ query, machine, limit }))
      chunks.typesense = typesenseChunks
      allChunks.push(...typesenseChunks.chunks)
    }
    if (rawSource === "local" || source === "local") {
      const local = searchLocal({ query, limit, machine, maxFiles })
      const localChunks = local.hits.map((hit) => hit.path ? inspectSession(hit.path, query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), contextBefore, contextAfter) : hit)
      chunks.local = { found: local.found, rawReturned: local.hits.length, emittedChunks: localChunks.length, searchedFiles: local.searchedFiles, chunks: localChunks }
      allChunks.push(...localChunks)
    }
    yield* writeEnvelope(respond("sessions chunks", { ...chunks, chunks: allChunks, hits: allChunks }, [
      { command: `sessions search ${JSON.stringify(query)} --source ${source} --machine ${machine} --extract --limit ${limit}`, description: "Search and extract task context from candidate sessions" },
    ]))
  })
).pipe(Command.withDescription("Show matching chunks/snippets with neighboring raw transcript context where available"))

function sessionsRoot(name: "sessions" | "session") {
  return Command.make(name, {}, () =>
    Effect.gen(function* () {
    yield* writeEnvelope(respond("sessions", {
      description: "Search captured agent Runs in Typesense and raw local/remote Pi session files",
      commands: {
        search: "joelclaw sessions search <query> [--source typesense|local|ssh|both] [--extract] [--machine dark-wizard] [--ssh-target joel@dark-wizard] [--limit 8]",
        extract: "joelclaw sessions extract <session-id-or-path> --query <topic> [--format json|markdown]",
        chunks: "joelclaw sessions chunks <query> [--source typesense|local|both] [--context-before 2] [--context-after 4]",
        inspect: "joelclaw sessions inspect <session-id-or-path> --around <regex> [--before 20] [--after 80]",
        signals: "joelclaw sessions signals [--kind friction|preference|decision|praise|any] [--source local|ssh|both] [--machine dark-wizard] [--since 14d] [--limit 20]",
        friction: "joelclaw sessions friction [--source local|ssh|both] [--machine dark-wizard] [--since 14d] [--limit 20]",
      },
    }, [
      {
        command: "sessions search <query> --source both --machine dark-wizard --extract",
        description: "Search dark-wizard sessions and extract bounded task context",
        params: { query: { required: true, description: "Search terms" } },
      },
      {
        command: "knowledge search \"typesense session indexing recovery runbook\"",
        description: "Find the troubleshooting runbook",
      },
    ]))
  })
).pipe(
  Command.withDescription("Search and extract agent session history across Typesense and raw transcript bridges"),
  Command.withSubcommands([searchCmd, extractCmd, chunksCmd, inspectCmd, signalsCmd, frictionCmd])
)
}

export const sessionsCmd = sessionsRoot("sessions")
export const sessionCmd = sessionsRoot("session")
