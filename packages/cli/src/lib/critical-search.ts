import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  CRITICAL_DB_REQUIRED_SOURCES,
  evaluateCriticalDbFreshness,
} from "@joelclaw/memory"

export const DEFAULT_CRITICAL_DB_PATH = join(homedir(), ".joelclaw", "search", "critical.db")
export const DEFAULT_SESSIONS_DB_PATH = join(homedir(), ".joelclaw", "search", "sessions.db")
export const CRITICAL_SCHEMA_VERSION = "2"
const SOURCE_REGRESSION_RATIO = 0.8

const CRITICAL_COLLECTIONS = [
  "observations",
  "memory_observations",
  "brain_pages",
  "system_knowledge",
  "vault_notes",
] as const

export type CriticalCollection = (typeof CRITICAL_COLLECTIONS)[number]

export type CriticalDocument = {
  id: string
  collection: CriticalCollection
  type: string
  title: string
  content: string
  source: string
  sourceKey?: string
  path?: string
  producerRunId?: string
  sessionId?: string
  privacy?: string
  createdAt?: number
  sourceUpdatedAt?: number
  payload?: Record<string, unknown>
}

export type ObservationCandidateRun = {
  runId: string
  startedAt: number
  endedAt: number
  chunkCount: number
}

export type ObserverSessionReference = {
  kind: "capture-conversation"
  value: string
  resolvableInSessionsDb: boolean
  candidateRuns: ObservationCandidateRun[]
  window: { from: number; to: number } | null
}

export type CriticalSearchHit = CriticalDocument & {
  rank: number
  score: number
  snippet: string
  observerSessionReference?: ObserverSessionReference
  sourceFreshness: {
    sourceKey: string
    highWaterAt: string | null
    ageSeconds: number | null
    status: string
    documentAgeSeconds: number | null
  }
}

export type CriticalFreshness = {
  builtAt: string
  ageSeconds: number
  newestSourceAt: string | null
  sourceAgeSeconds: number | null
  documentCount: number
  status: "ok" | "degraded" | "stale"
  sources: Record<string, BuildSourceReport & { ageSeconds: number | null; freshness: string }>
  coverageGaps: string[]
}

export type CriticalSearchSource = {
  name: string
  kind: "local" | "replica"
  endpoint: string
  checkedAt: string
  syncCheckAgeSeconds: number | null
  replicaLagSeconds: number | null
}

export type CriticalSearchResult = {
  dbPath: string
  hits: CriticalSearchHit[]
  found: number
  freshness: CriticalFreshness
  durationMs: number
  servedBy?: CriticalSearchSource
}

export type CriticalReplica = {
  name: string
  url: string
  maxStalenessSeconds?: number
  token?: string
}

export type CriticalProjectionSearchInput = {
  query: string
  limit?: number
  collections?: CriticalCollection[]
  type?: string
  dbPath?: string
  now?: Date
  replicas?: CriticalReplica[]
  skipLocal?: boolean
  timeoutMs?: number
  sessionsDbPath?: string
}

export class CriticalDbUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CriticalDbUnavailableError"
  }
}

export type BuildOptions = {
  dbPath?: string
  typesenseUrl?: string
  typesenseApiKey?: string
  observationsDir?: string
  brainRoots?: string[]
  vaultDir?: string
  skillsDir?: string
  memoryArchivePath?: string
  allowNonFlagg?: boolean
  allowDegradedSources?: boolean
  now?: Date
}

export type BuildSourceReport = {
  count: number
  status: "ok" | "skipped" | "unavailable" | "empty" | "error"
  detail?: string
  highWaterAt?: string
}

export type CriticalBuildResult = {
  dbPath: string
  builtAt: string
  documentCount: number
  sources: Record<string, BuildSourceReport>
  bytes: number
  durationMs: number
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function asNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function asEpochSeconds(value: unknown): number | undefined {
  const numeric = asNumber(value)
  if (numeric !== undefined) return numeric > 10_000_000_000 ? Math.floor(numeric / 1_000) : Math.floor(numeric)
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : undefined
}

function asEpochMilliseconds(value: unknown): number | undefined {
  const numeric = asNumber(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? Math.floor(numeric * 1_000) : Math.floor(numeric)
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function openSessionsDbReadOnly(dbPath: string): Database | undefined {
  if (!existsSync(dbPath)) return undefined
  const uri = `${pathToFileURL(resolve(dbPath)).href}?mode=ro`
  const db = new Database(uri, { readonly: true, strict: true })
  db.exec("PRAGMA query_only = ON")
  return db
}

function resolveObservationReferenceWithDb(input: {
  db: Database
  captureConversationId: string
  windowFrom?: unknown
  windowTo?: unknown
}): ObserverSessionReference {
  const value = input.captureConversationId.trim()
  const exact = input.db.query("SELECT 1 AS found FROM runs WHERE conversation_id = ? LIMIT 1").get(value) as { found?: number } | null
  const from = asEpochMilliseconds(input.windowFrom)
  const to = asEpochMilliseconds(input.windowTo)
  const window = from !== undefined && to !== undefined && from < to ? { from, to } : null
  const candidateRuns = !exact || !window
    ? []
    : input.db.query(`
        SELECT DISTINCT r.run_id, r.started_at, r.ended_at, r.chunk_count
        FROM runs r
        JOIN chunks c ON c.run_id = r.run_id
        WHERE r.conversation_id = ? AND c.started_at > ? AND c.started_at <= ?
        ORDER BY r.started_at, r.run_id
      `).all(value, window.from, window.to).map((row) => {
        const candidate = row as { run_id: string; started_at: number; ended_at: number; chunk_count: number }
        return {
          runId: candidate.run_id,
          startedAt: candidate.started_at,
          endedAt: candidate.ended_at,
          chunkCount: candidate.chunk_count,
        }
      })
  return {
    kind: "capture-conversation",
    value,
    resolvableInSessionsDb: Boolean(exact),
    candidateRuns,
    window,
  }
}

export function resolveObservationReference(input: {
  captureConversationId: string
  windowFrom?: unknown
  windowTo?: unknown
  sessionsDbPath?: string
}): ObserverSessionReference {
  const value = input.captureConversationId.trim()
  const from = asEpochMilliseconds(input.windowFrom)
  const to = asEpochMilliseconds(input.windowTo)
  const fallback: ObserverSessionReference = {
    kind: "capture-conversation",
    value,
    resolvableInSessionsDb: false,
    candidateRuns: [],
    window: from !== undefined && to !== undefined && from < to ? { from, to } : null,
  }
  let db: Database | undefined
  try {
    db = openSessionsDbReadOnly(input.sessionsDbPath ?? process.env.JOELCLAW_SESSIONS_DB ?? DEFAULT_SESSIONS_DB_PATH)
    return db ? resolveObservationReferenceWithDb({ db, ...input, captureConversationId: value }) : fallback
  } catch {
    return fallback
  } finally {
    db?.close()
  }
}

function isSyntheticObservationIdentity(value: string): boolean {
  return /^(?:telemetry(?::|-)|reflector-|external-context-|session-noted:|dedup:|otel:)/u.test(value)
}

function observationConversationValue(document: CriticalDocument): string | undefined {
  if (document.collection !== "observations") return undefined
  const explicitKind = asString(document.payload?.identityKind)
  if (explicitKind === "capture-run" || explicitKind === "work-state-pass") return undefined
  const explicit = asString(document.payload?.captureConversationId)
  if (explicitKind === "capture-conversation") return explicit
  const hasEpoch = asEpochMilliseconds(document.payload?.windowFrom ?? document.payload?.started) !== undefined
    && asEpochMilliseconds(document.payload?.windowTo ?? document.payload?.ended) !== undefined
  return hasEpoch && document.sessionId && !isSyntheticObservationIdentity(document.sessionId)
    ? document.sessionId
    : undefined
}

function attachObservationReferences(hits: CriticalSearchHit[], sessionsDbPath?: string): CriticalSearchHit[] {
  let db: Database | undefined
  try {
    db = openSessionsDbReadOnly(sessionsDbPath ?? process.env.JOELCLAW_SESSIONS_DB ?? DEFAULT_SESSIONS_DB_PATH)
  } catch {
    db = undefined
  }
  try {
    return hits.map((hit) => {
      const value = observationConversationValue(hit)
      if (!value) return hit
      const windowFrom = hit.payload?.windowFrom ?? hit.payload?.started
      const windowTo = hit.payload?.windowTo ?? hit.payload?.ended
      const observerSessionReference = db
        ? resolveObservationReferenceWithDb({ db, captureConversationId: value, windowFrom, windowTo })
        : resolveObservationReference({ captureConversationId: value, windowFrom, windowTo, sessionsDbPath })
      return { ...hit, observerSessionReference }
    })
  } finally {
    db?.close()
  }
}

function highWaterAt(documents: CriticalDocument[]): string | undefined {
  const seconds = documents.reduce((latest, document) => Math.max(latest, document.sourceUpdatedAt ?? document.createdAt ?? 0), 0)
  return seconds > 0 ? new Date(seconds * 1_000).toISOString() : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((item): item is string => Boolean(item)) : []
}

function compactText(parts: Array<string | undefined>, maxChars = 100_000): string {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join("\n").replace(/\u0000/gu, "").trim()
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

function fileUpdatedAt(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1_000)
  } catch {
    return 0
  }
}

function walkFiles(root: string, extensions: ReadonlySet<string>): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agent_sources") continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(path)
    }
  }
  return files.sort()
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string; parseError: boolean } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u)
  if (!match) return { frontmatter: {}, body: content, parseError: false }
  try {
    return { frontmatter: Bun.YAML.parse(match[1] ?? "") as Record<string, unknown>, body: match[2] ?? "", parseError: false }
  } catch {
    return { frontmatter: {}, body: match[2] ?? content, parseError: true }
  }
}

function titleFromBody(body: string, fallback: string): string {
  return body.match(/^#\s+(.+)$/mu)?.[1]?.trim() || fallback
}

function localObservationDocuments(root: string): DocumentLoad {
  const documents: CriticalDocument[] = []
  let malformed = 0
  const errors: string[] = []
  for (const path of walkFiles(root, new Set([".svx"]))) {
    const raw = readFileSync(path, "utf8")
    const { frontmatter, body, parseError } = parseFrontmatter(raw)
    if (parseError) {
      malformed++
      errors.push(path)
      continue
    }
    if (frontmatter.type !== "observation") continue
    const id = asString(frontmatter.slug) ?? basename(path, ".svx")
    const producerRunId = asString(frontmatter.producerRunId)
      ?? asString(frontmatter.producer_run_id)
      ?? asString(frontmatter.runId)
      ?? asString(frontmatter.run_id)
    const sessionId = asString(frontmatter.captureConversationId)
      ?? asString(frontmatter.capture_conversation_id)
      ?? asString(frontmatter.sessionId)
      ?? asString(frontmatter.session_id)
    const started = asString(frontmatter.started)
    documents.push({
      id,
      collection: "observations",
      type: "observation-page",
      title: asString(frontmatter.title) ?? titleFromBody(body, id),
      content: compactText([body, producerRunId ? `Producer Run-ID: ${producerRunId}` : undefined]),
      source: path,
      path,
      producerRunId,
      sessionId,
      privacy: asString(frontmatter.privacy) ?? "private",
      createdAt: started ? Math.floor(Date.parse(started) / 1_000) : fileUpdatedAt(path),
      sourceUpdatedAt: fileUpdatedAt(path),
      payload: frontmatter,
    })
  }
  return { documents, malformed, errors }
}

function localBrainDocuments(roots: string[]): CriticalDocument[] {
  const seen = new Set<string>()
  const documents: CriticalDocument[] = []
  for (const root of roots.map((path) => resolve(path))) {
    if (seen.has(root) || !existsSync(root)) continue
    seen.add(root)
    for (const path of walkFiles(root, new Set([".svx"]))) {
      if (path.includes(`${join(".brain", "observations")}${process.platform === "win32" ? "\\" : "/"}`)) continue
      const raw = readFileSync(path, "utf8")
      const { frontmatter, body, parseError } = parseFrontmatter(raw)
      if (parseError) throw new Error(`frontmatter parse failed: ${path}`)
      const rel = relative(root, path)
      const id = `${basename(dirname(root)) || "brain"}:${rel}`
      documents.push({
        id,
        collection: "brain_pages",
        type: asString(frontmatter.type) ?? "brain-page",
        title: asString(frontmatter.title) ?? titleFromBody(body, basename(path, ".svx")),
        content: compactText([body]),
        source: path,
        path,
        privacy: asString(frontmatter.privacy) ?? "private",
        sourceUpdatedAt: fileUpdatedAt(path),
        payload: frontmatter,
      })
    }
  }
  return documents
}

function localVaultDocuments(root: string): CriticalDocument[] {
  return walkFiles(root, new Set([".md", ".svx", ".txt"])).map((path) => {
    const raw = readFileSync(path, "utf8")
    const { frontmatter, body, parseError } = parseFrontmatter(raw)
    if (parseError) throw new Error(`frontmatter parse failed: ${path}`)
    const rel = relative(root, path)
    return {
      id: rel,
      collection: "vault_notes" as const,
      type: asString(frontmatter.type) ?? "vault-note",
      title: asString(frontmatter.title) ?? titleFromBody(body, basename(path, extname(path))),
      content: compactText([body]),
      source: `vault:${rel}`,
      path: rel,
      privacy: asString(frontmatter.privacy) ?? "private",
      sourceUpdatedAt: fileUpdatedAt(path),
      payload: frontmatter,
    }
  })
}

function localKnowledgeDocuments(vaultDir: string, skillsDir: string): CriticalDocument[] {
  const adrRoot = join(vaultDir, "docs", "decisions")
  const adrs = walkFiles(adrRoot, new Set([".md", ".svx"])).map((path) => {
    const raw = readFileSync(path, "utf8")
    const { frontmatter, body, parseError } = parseFrontmatter(raw)
    if (parseError) throw new Error(`frontmatter parse failed: ${path}`)
    const rel = relative(vaultDir, path)
    return {
      id: `adr:${basename(path, extname(path))}`,
      collection: "system_knowledge" as const,
      type: "adr",
      title: asString(frontmatter.title) ?? titleFromBody(body, basename(path, extname(path))),
      content: compactText([body]),
      source: `vault:${rel}`,
      path: rel,
      privacy: "private",
      sourceUpdatedAt: fileUpdatedAt(path),
      payload: frontmatter,
    }
  })
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return []
        const path = join(skillsDir, entry.name, "SKILL.md")
        if (!existsSync(path)) return []
        const raw = readFileSync(path, "utf8")
        const { frontmatter, body, parseError } = parseFrontmatter(raw)
        if (parseError) throw new Error(`frontmatter parse failed: ${path}`)
        return [{
          id: `skill:${entry.name}`,
          collection: "system_knowledge" as const,
          type: "skill",
          title: entry.name,
          content: compactText([asString(frontmatter.description), body]),
          source: path,
          path,
          privacy: "private",
          sourceUpdatedAt: fileUpdatedAt(path),
          payload: frontmatter,
        }]
      })
    : []
  return [...adrs, ...skills]
}

function documentFromTypesense(collection: CriticalCollection, raw: Record<string, unknown>): CriticalDocument | null {
  const id = asString(raw.id)
  if (!id) return null
  const title = asString(raw.title) ?? asString(raw.label) ?? asString(raw.observation)?.slice(0, 120) ?? id
  const content = compactText([
    asString(raw.content),
    asString(raw.body),
    asString(raw.observation),
    asString(raw.gist),
    ...stringList(raw.observations),
    ...stringList(raw.decisions),
    ...stringList(raw.open_questions),
  ])
  if (!content) return null
  const created = asEpochSeconds(raw.created_at) ?? asEpochSeconds(raw.timestamp) ?? asEpochSeconds(raw.started_at)
  const updated = asEpochSeconds(raw.updated_at) ?? created
  return {
    id,
    collection,
    type: asString(raw.type) ?? asString(raw.kind) ?? asString(raw.observation_type) ?? collection,
    title,
    content,
    source: asString(raw.source) ?? asString(raw.url) ?? `${collection}:${id}`,
    path: asString(raw.path),
    producerRunId: asString(raw.producer_run_id) ?? asString(raw.producerRunId) ?? asString(raw.run_id) ?? asString(raw.runId),
    sessionId: asString(raw.capture_conversation_id) ?? asString(raw.captureConversationId) ?? asString(raw.session_id) ?? asString(raw.sessionId),
    privacy: asString(raw.privacy) ?? "private",
    createdAt: created,
    sourceUpdatedAt: updated,
    payload: raw,
  }
}

type DocumentLoad = { documents: CriticalDocument[]; malformed: number; errors?: string[] }

async function exportTypesenseCollection(input: {
  collection: CriticalCollection
  url: string
  apiKey: string
}): Promise<DocumentLoad> {
  const response = await fetch(`${input.url.replace(/\/$/u, "")}/collections/${input.collection}/documents/export`, {
    headers: { "X-TYPESENSE-API-KEY": input.apiKey },
    signal: AbortSignal.timeout(120_000),
  })
  if (response.status === 404) return { documents: [], malformed: 0 }
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`.slice(0, 300))
  const documents: CriticalDocument[] = []
  let malformed = 0
  for (const line of (await response.text()).split("\n").filter(Boolean)) {
    try {
      const document = documentFromTypesense(input.collection, JSON.parse(line) as Record<string, unknown>)
      if (document) documents.push(document)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { documents, malformed }
}

function latestMemoryArchive(): string | undefined {
  const root = "/Volumes/three-body/backups/typesense/retired-memory-observations"
  if (!existsSync(root)) return undefined
  return readdirSync(root)
    .filter((name) => /^memory_observations-.*\.jsonl$/u.test(name))
    .sort()
    .at(-1)
    ?.replace(/^/u, `${root}/`)
}

function loadMemoryArchive(path: string): DocumentLoad {
  const documents: CriticalDocument[] = []
  let malformed = 0
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const document = documentFromTypesense("memory_observations", JSON.parse(line) as Record<string, unknown>)
      if (document) documents.push({ ...document, sourceUpdatedAt: document.createdAt })
      else malformed++
    } catch {
      malformed++
    }
  }
  return { documents, malformed }
}

function createSchema(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE documents (
      rowid INTEGER PRIMARY KEY,
      stable_id TEXT NOT NULL UNIQUE,
      collection TEXT NOT NULL,
      document_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_key TEXT NOT NULL,
      path TEXT,
      run_id TEXT,
      session_id TEXT,
      privacy TEXT NOT NULL,
      created_at INTEGER,
      source_updated_at INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX documents_collection_idx ON documents(collection);
    CREATE INDEX documents_run_id_idx ON documents(run_id) WHERE run_id IS NOT NULL;
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      title, content, source, path,
      content='documents', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `)
}

function insertDocuments(db: Database, documents: CriticalDocument[]): number {
  const insert = db.prepare(`
    INSERT INTO documents (
      stable_id, collection, document_id, type, title, content, source, source_key, path,
      run_id, session_id, privacy, created_at, source_updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stable_id) DO UPDATE SET
      type=excluded.type, title=excluded.title, content=excluded.content,
      source=excluded.source, source_key=excluded.source_key, path=excluded.path, run_id=excluded.run_id,
      session_id=excluded.session_id, privacy=excluded.privacy,
      created_at=excluded.created_at, source_updated_at=excluded.source_updated_at,
      payload_json=excluded.payload_json
  `)
  const transaction = db.transaction((batch: CriticalDocument[]) => {
    for (const document of batch) {
      insert.run(
        `${document.collection}:${document.id}`,
        document.collection,
        document.id,
        document.type,
        document.title,
        document.content,
        document.source,
        document.sourceKey ?? `collection:${document.collection}`,
        document.path ?? null,
        document.producerRunId ?? null,
        document.sessionId ?? null,
        document.privacy ?? "private",
        document.createdAt ?? null,
        document.sourceUpdatedAt ?? null,
        JSON.stringify(document.payload ?? {}),
      )
    }
  })
  transaction(documents)
  return documents.length
}

function existingSourceReports(dbPath: string): Record<string, BuildSourceReport> | null {
  if (!existsSync(dbPath)) return null
  try {
    const db = new Database(dbPath, { readonly: true, strict: true })
    try {
      return JSON.parse(readMetadata(db).get("sources_json") ?? "{}") as Record<string, BuildSourceReport>
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function validateRequiredSources(
  sources: Record<string, BuildSourceReport>,
  previous: Record<string, BuildSourceReport> | null,
): string[] {
  const failures: string[] = []
  for (const source of CRITICAL_DB_REQUIRED_SOURCES) {
    const current = sources[source]
    if (!current || current.status !== "ok" || current.count === 0) {
      failures.push(`${source} is ${current?.status ?? "missing"} (${current?.count ?? 0} documents)${current?.detail ? `: ${current.detail}` : ""}`)
      continue
    }
    const priorCount = previous?.[source]?.count ?? 0
    if (priorCount >= 5 && current.count < Math.floor(priorCount * SOURCE_REGRESSION_RATIO)) {
      failures.push(`${source} regressed from ${priorCount} to ${current.count}; minimum safe count is ${Math.floor(priorCount * SOURCE_REGRESSION_RATIO)}`)
    }
  }
  return failures
}

export async function buildCriticalDb(options: BuildOptions = {}): Promise<CriticalBuildResult> {
  const started = performance.now()
  const currentHost = hostname().toLowerCase()
  const shortHost = currentHost.split(".")[0]
  if (!options.allowNonFlagg && shortHost !== "flagg") {
    throw new Error(`critical.db is single-writer on flagg; refusing write on ${currentHost}`)
  }
  const now = options.now ?? new Date()
  const dbPath = resolve(options.dbPath ?? process.env.JOELCLAW_CRITICAL_DB ?? DEFAULT_CRITICAL_DB_PATH)
  const temporaryPath = `${dbPath}.building-${process.pid}`
  const lockPath = `${dbPath}.build-lock`
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 })
  try {
    await mkdir(lockPath)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN"
    if (code === "EEXIST") throw new Error(`critical.db builder lock is held: ${lockPath}`)
    throw error
  }

  try {
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: currentHost, startedAt: now.toISOString() }), { mode: 0o600 })
    await rm(temporaryPath, { force: true })
    const sources: Record<string, BuildSourceReport> = {}
    const documents = new Map<string, CriticalDocument>()
    const add = (
      source: string,
      docs: CriticalDocument[],
      status: BuildSourceReport["status"],
      detail?: string,
    ) => {
      for (const document of docs) {
        const withSource = { ...document, sourceKey: source }
        documents.set(`${withSource.collection}:${withSource.id}`, withSource)
      }
      const water = highWaterAt(docs)
      sources[source] = { count: docs.length, status, ...(detail ? { detail } : {}), ...(water ? { highWaterAt: water } : {}) }
    }
    const loadFiles = (source: string, requiredPaths: string[], load: () => CriticalDocument[] | DocumentLoad) => {
      const missing = requiredPaths.filter((path) => !existsSync(path))
      if (missing.length > 0) {
        add(source, [], "unavailable", `missing: ${missing.join(", ")}`)
        return
      }
      try {
        const loaded = load()
        const docs = Array.isArray(loaded) ? loaded : loaded.documents
        const malformed = Array.isArray(loaded) ? 0 : loaded.malformed
        const status = malformed > 0 ? "error" : docs.length > 0 ? "ok" : "empty"
        const detail = malformed > 0
          ? `${malformed} malformed source files${!Array.isArray(loaded) && loaded.errors?.length ? `: ${loaded.errors.join(", ")}` : ""}`
          : docs.length > 0
            ? undefined
            : "source exists but produced no searchable documents"
        add(source, docs, status, detail)
      } catch (error) {
        add(source, [], "error", error instanceof Error ? error.message : String(error))
      }
    }

    const apiKey = options.typesenseApiKey?.trim()
    if (apiKey) {
      for (const collection of CRITICAL_COLLECTIONS) {
        const source = `typesense:${collection}`
        try {
          const loaded = await exportTypesenseCollection({
            collection,
            url: options.typesenseUrl ?? process.env.TYPESENSE_URL ?? "http://localhost:8108",
            apiKey,
          })
          const status = loaded.malformed > 0 ? "error" : loaded.documents.length > 0 ? "ok" : "empty"
          add(source, loaded.documents, status, loaded.malformed > 0 ? `${loaded.malformed} malformed export rows` : undefined)
        } catch (error) {
          add(source, [], "unavailable", error instanceof Error ? error.message : String(error))
        }
      }
    } else {
      for (const collection of CRITICAL_COLLECTIONS) add(`typesense:${collection}`, [], "skipped", "no API key")
    }

    const observationsDir = options.observationsDir ?? join(homedir(), "Code", "joelhooks", "dark-wizard", ".brain", "observations")
    const brainRoots = options.brainRoots ?? [join(process.cwd(), ".brain"), join(homedir(), ".brain")]
    const vaultDir = options.vaultDir ?? process.env.VAULT_DIR ?? join(homedir(), "Vault")
    const skillsDir = options.skillsDir ?? process.env.JOELCLAW_SKILLS_DIR ?? join(process.cwd(), "skills")
    loadFiles("files:observations", [observationsDir], () => localObservationDocuments(observationsDir))
    loadFiles("files:brain", brainRoots, () => localBrainDocuments(brainRoots))
    loadFiles("files:vault", [vaultDir], () => localVaultDocuments(vaultDir))
    loadFiles("files:knowledge", [join(vaultDir, "docs", "decisions"), skillsDir], () => localKnowledgeDocuments(vaultDir, skillsDir))

    const archivePath = options.memoryArchivePath ?? latestMemoryArchive()
    if (!archivePath || !existsSync(archivePath)) {
      add("archive:memory_observations", [], "unavailable", "no archive found")
    } else {
      try {
        const loaded = loadMemoryArchive(archivePath)
        const status = loaded.malformed > 0 ? "error" : loaded.documents.length > 0 ? "ok" : "empty"
        add(
          "archive:memory_observations",
          loaded.documents,
          status,
          loaded.malformed > 0 ? `${archivePath}; ${loaded.malformed} malformed rows` : archivePath,
        )
      } catch (error) {
        add("archive:memory_observations", [], "error", error instanceof Error ? error.message : String(error))
      }
    }

    const sourceFailures = validateRequiredSources(sources, existingSourceReports(dbPath))
    if (sourceFailures.length > 0 && !options.allowDegradedSources) {
      throw new Error(`refusing to replace critical.db with degraded sources:\n- ${sourceFailures.join("\n- ")}\nUse --allow-degraded-sources only for an explicit recovery override.`)
    }

    const archiveWater = sources["archive:memory_observations"]?.highWaterAt
    const knowledgeTypes = new Set([...documents.values()].filter((document) => document.collection === "system_knowledge").map((document) => document.type))
    const coverageGaps = [
      ...(archiveWater ? [`memory_observations archive high-water is ${archiveWater}; newer memory may be absent`] : ["memory_observations archive has no high-water timestamp"]),
      ...(["turn_note", "failed_target"].filter((type) => !knowledgeTypes.has(type)).length > 0
        ? [`system_knowledge is missing dynamic types: ${["turn_note", "failed_target"].filter((type) => !knowledgeTypes.has(type)).join(", ")}`]
        : []),
      "observation producer Runs are namespaced as producerRunId; capture conversations resolve through sessions.db",
      ...(sourceFailures.length > 0 ? sourceFailures.map((failure) => `override: ${failure}`) : []),
    ]

    const db = new Database(temporaryPath, { create: true, strict: true })
    try {
      createSchema(db)
      insertDocuments(db, [...documents.values()])
      db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')")
      const builtAt = now.toISOString()
      const metadata = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      metadata.run("schema_version", CRITICAL_SCHEMA_VERSION)
      metadata.run("built_at", builtAt)
      metadata.run("writer_host", currentHost)
      metadata.run("sources_json", JSON.stringify(sources))
      metadata.run("coverage_gaps_json", JSON.stringify(coverageGaps))
      metadata.run("document_count", String(documents.size))
      metadata.run("degraded_override", String(sourceFailures.length > 0))
      db.exec("PRAGMA optimize")
      const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null
      if (integrity?.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity?.integrity_check ?? "unknown"}`)
    } finally {
      db.close()
    }
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, dbPath)
    return {
      dbPath,
      builtAt: now.toISOString(),
      documentCount: documents.size,
      sources,
      bytes: statSync(dbPath).size,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    }
  } finally {
    await rm(temporaryPath, { force: true })
    await rm(lockPath, { recursive: true, force: true })
  }
}

function ftsQuery(input: string): string {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_./:-]+/gu) ?? []
  return terms.slice(0, 16).map((term) => `"${term.replace(/"/gu, '""')}"`).join(" OR ")
}

function readMetadata(db: Database): Map<string, string> {
  const rows = db.query("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>
  return new Map(rows.map((row) => [row.key, row.value]))
}

export function searchCriticalDb(input: {
  query: string
  limit?: number
  collections?: CriticalCollection[]
  type?: string
  dbPath?: string
  now?: Date
}): CriticalSearchResult {
  const started = performance.now()
  const dbPath = resolve(input.dbPath ?? process.env.JOELCLAW_CRITICAL_DB ?? DEFAULT_CRITICAL_DB_PATH)
  if (!existsSync(dbPath)) throw new CriticalDbUnavailableError(`critical.db not found: ${dbPath}`)
  const query = ftsQuery(input.query)
  if (!query) return { dbPath, hits: [], found: 0, freshness: readFreshness(dbPath, input.now), durationMs: 0 }
  let db: Database
  try {
    db = new Database(dbPath, { readonly: true, strict: true })
  } catch (error) {
    throw new CriticalDbUnavailableError(`critical.db open failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const freshness = freshnessFromMetadata(db, input.now)
    const clauses: string[] = ["documents_fts MATCH ?"]
    const params: Array<string | number> = [query]
    if (input.collections?.length) {
      clauses.push(`d.collection IN (${input.collections.map(() => "?").join(",")})`)
      params.push(...input.collections)
    }
    if (input.type) {
      clauses.push("d.type = ?")
      params.push(input.type)
    }
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100)
    const rows = db.query(`
      SELECT d.document_id, d.collection, d.type, d.title, d.content, d.source,
        d.source_key, d.path, d.run_id, d.session_id, d.privacy, d.created_at,
        d.source_updated_at, d.payload_json, bm25(documents_fts, 6.0, 2.0, 1.0, 1.0) AS rank,
        snippet(documents_fts, 1, '<mark>', '</mark>', ' … ', 32) AS snippet
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC, COALESCE(d.source_updated_at, d.created_at, 0) DESC
      LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>
    const rawHits: CriticalSearchHit[] = rows.map((row) => {
      const rank = asNumber(row.rank) ?? 0
      const sourceKey = String(row.source_key)
      const sourceFreshness = freshness.sources[sourceKey]
      const documentTimestamp = asNumber(row.source_updated_at) ?? asNumber(row.created_at)
      return {
        id: String(row.document_id),
        collection: String(row.collection) as CriticalCollection,
        type: String(row.type),
        title: String(row.title),
        content: String(row.content),
        source: String(row.source),
        sourceKey,
        path: asString(row.path),
        producerRunId: asString(row.run_id),
        sessionId: asString(row.session_id),
        privacy: asString(row.privacy),
        createdAt: asNumber(row.created_at),
        sourceUpdatedAt: asNumber(row.source_updated_at),
        payload: JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>,
        rank,
        score: Math.max(0, -rank),
        snippet: String(row.snippet || row.content).slice(0, 1_500),
        sourceFreshness: {
          sourceKey,
          highWaterAt: sourceFreshness?.highWaterAt ?? null,
          ageSeconds: sourceFreshness?.ageSeconds ?? null,
          status: sourceFreshness?.freshness ?? sourceFreshness?.status ?? "unknown",
          documentAgeSeconds: documentTimestamp
            ? Math.max(0, Math.floor((input.now?.getTime() ?? Date.now()) / 1_000 - documentTimestamp))
            : null,
        },
      }
    })
    const hits = attachObservationReferences(rawHits, input.sessionsDbPath)
    const countRow = db.query(`
      SELECT count(*) AS count
      FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE ${clauses.join(" AND ")}
    `).get(...params) as { count?: number } | null
    return {
      dbPath,
      hits,
      found: Number(countRow?.count ?? hits.length),
      freshness,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    }
  } catch (error) {
    if (error instanceof CriticalDbUnavailableError) throw error
    throw new CriticalDbUnavailableError(`critical.db read failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db.close()
  }
}

function freshnessFromMetadata(db: Database, now = new Date()): CriticalFreshness {
  const metadata = readMetadata(db)
  if (metadata.get("schema_version") !== CRITICAL_SCHEMA_VERSION) {
    throw new CriticalDbUnavailableError(`critical.db schema mismatch: ${metadata.get("schema_version") ?? "missing"}`)
  }
  const builtAt = metadata.get("built_at") ?? new Date(0).toISOString()
  const newest = db.query("SELECT max(source_updated_at) AS value FROM documents").get() as { value?: number } | null
  const newestSeconds = asNumber(newest?.value)
  const nowSeconds = Math.floor(now.getTime() / 1_000)
  const rawSources = JSON.parse(metadata.get("sources_json") ?? "{}") as Record<string, BuildSourceReport>
  const evaluated = evaluateCriticalDbFreshness({
    sources: rawSources,
    degradedOverride: metadata.get("degraded_override") === "true",
    nowMs: now.getTime(),
    ageResolutionMs: 1_000,
    zeroTimestampIsMissing: true,
  })
  const sources = Object.fromEntries(Object.entries(evaluated.sources).map(([key, source]) => {
    const { ageMs, ...report } = source
    return [key, { ...report, ageSeconds: ageMs === null ? null : ageMs / 1_000 }]
  })) as CriticalFreshness["sources"]
  const status = evaluated.status
  return {
    builtAt,
    ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(builtAt)) / 1_000)),
    newestSourceAt: newestSeconds ? new Date(newestSeconds * 1_000).toISOString() : null,
    sourceAgeSeconds: newestSeconds ? Math.max(0, nowSeconds - newestSeconds) : null,
    documentCount: Number(metadata.get("document_count") ?? 0),
    status,
    sources,
    coverageGaps: JSON.parse(metadata.get("coverage_gaps_json") ?? "[]") as string[],
  }
}

export function readFreshness(dbPath = process.env.JOELCLAW_CRITICAL_DB ?? DEFAULT_CRITICAL_DB_PATH, now = new Date()): CriticalFreshness {
  if (!existsSync(dbPath)) throw new CriticalDbUnavailableError(`critical.db not found: ${dbPath}`)
  let db: Database
  try {
    db = new Database(dbPath, { readonly: true, strict: true })
  } catch (error) {
    throw new CriticalDbUnavailableError(`critical.db open failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return freshnessFromMetadata(db, now)
  } catch (error) {
    if (error instanceof CriticalDbUnavailableError) throw error
    throw new CriticalDbUnavailableError(`critical.db metadata failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db.close()
  }
}

function configuredReplicas(): CriticalReplica[] {
  const fromEnv = process.env.JOELCLAW_CRITICAL_SEARCH_REPLICAS?.trim()
  if (fromEnv) {
    const token = process.env.JOELCLAW_CRITICAL_SEARCH_TOKEN?.trim()
    return fromEnv.split(",").map((entry, index) => {
      const [name, ...urlParts] = entry.trim().split("=")
      const url = urlParts.length > 0 ? urlParts.join("=") : name
      return {
        name: urlParts.length > 0 ? name : `nas-${index + 1}`,
        url: url.replace(/\/$/u, ""),
        ...(token ? { token } : {}),
      }
    }).filter((replica) => replica.url.length > 0)
  }

  const configPath = process.env.JOELCLAW_CRITICAL_SEARCH_CONFIG
    ?? join(homedir(), ".config", "joelclaw", "critical-search-replicas.json")
  if (!existsSync(configPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { replicas?: CriticalReplica[]; tokenFile?: string }
    const token = parsed.tokenFile ? readFileSync(resolve(parsed.tokenFile), "utf8").trim() : undefined
    return (parsed.replicas ?? []).filter((replica) => replica.name?.trim() && replica.url?.trim()).map((replica) => ({
      ...replica,
      name: replica.name.trim(),
      url: replica.url.trim().replace(/\/$/u, ""),
      ...(replica.token?.trim() ? { token: replica.token.trim() } : token ? { token } : {}),
    }))
  } catch (error) {
    throw new CriticalDbUnavailableError(
      `critical-search replica config is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function isCriticalSearchResult(value: unknown): value is CriticalSearchResult {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<CriticalSearchResult>
  return Array.isArray(candidate.hits)
    && typeof candidate.found === "number"
    && typeof candidate.durationMs === "number"
    && Boolean(candidate.freshness && typeof candidate.freshness === "object")
}

async function searchReplica(
  replica: CriticalReplica,
  input: CriticalProjectionSearchInput,
  timeoutMs: number,
): Promise<CriticalSearchResult> {
  if (!replica.token?.trim()) throw new Error("replica authentication token is missing")
  // connection: close — the replica shim closes sockets per response; reused
  // keep-alive connections die with "socket closed unexpectedly".
  const headers = { authorization: `Bearer ${replica.token.trim()}`, connection: "close" }
  const healthResponse = await fetch(`${replica.url}/health`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!healthResponse.ok) throw new Error(`health HTTP ${healthResponse.status}`)
  const health = await healthResponse.json() as {
    ok?: boolean
    checkedAt?: string
    syncCheckAgeSeconds?: number | null
    replicaLagSeconds?: number | null
  }
  if (!health.ok) throw new Error("health reported unavailable")
  const maxStalenessSeconds = replica.maxStalenessSeconds
    ?? Number(process.env.JOELCLAW_CRITICAL_SEARCH_MAX_STALENESS_SECONDS ?? 300)
  if (!Number.isFinite(health.syncCheckAgeSeconds)) throw new Error("sync check age is missing or invalid")
  if ((health.syncCheckAgeSeconds as number) > maxStalenessSeconds) {
    throw new Error(`sync check is ${health.syncCheckAgeSeconds}s old; budget is ${maxStalenessSeconds}s`)
  }
  if (health.replicaLagSeconds !== null && health.replicaLagSeconds !== undefined
    && health.replicaLagSeconds > maxStalenessSeconds) {
    throw new Error(`replica lag is ${health.replicaLagSeconds}s; budget is ${maxStalenessSeconds}s`)
  }

  const response = await fetch(`${replica.url}/search`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      limit: input.limit,
      collections: input.collections,
      type: input.type,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`search HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const result = await response.json()
  if (!isCriticalSearchResult(result)) throw new Error("search returned an invalid response")
  return {
    ...result,
    servedBy: {
      name: replica.name,
      kind: "replica",
      endpoint: replica.url,
      checkedAt: health.checkedAt ?? new Date().toISOString(),
      syncCheckAgeSeconds: health.syncCheckAgeSeconds ?? null,
      replicaLagSeconds: health.replicaLagSeconds ?? null,
    },
  }
}

/** Ordered critical search: flagg-local SQLite, then NAS replicas in configured order. */
export async function searchCriticalProjection(input: CriticalProjectionSearchInput): Promise<CriticalSearchResult> {
  const failures: string[] = []
  const skipLocal = input.skipLocal ?? process.env.JOELCLAW_CRITICAL_SEARCH_SKIP_LOCAL === "1"
  if (!skipLocal) {
    try {
      const result = searchCriticalDb(input)
      return {
        ...result,
        servedBy: {
          name: "flagg",
          kind: "local",
          endpoint: result.dbPath,
          checkedAt: new Date().toISOString(),
          syncCheckAgeSeconds: 0,
          replicaLagSeconds: 0,
        },
      }
    } catch (error) {
      failures.push(`flagg: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const replicas = input.replicas ?? configuredReplicas()
  const timeoutMs = input.timeoutMs ?? Number(process.env.JOELCLAW_CRITICAL_SEARCH_TIMEOUT_MS ?? 1_500)
  for (const replica of replicas) {
    try {
      const result = await searchReplica(replica, input, timeoutMs)
      return { ...result, hits: attachObservationReferences(result.hits, input.sessionsDbPath) }
    } catch (error) {
      failures.push(`${replica.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new CriticalDbUnavailableError(`all critical-search sources failed${failures.length ? `:\n- ${failures.join("\n- ")}` : ": no replicas configured"}`)
}
