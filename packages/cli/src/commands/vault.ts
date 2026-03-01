import { constants as fsConstants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, normalize } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const VAULT_ROOT = normalize(process.env.VAULT_PATH ?? join(homedir(), "Vault"))
const READ_MAX_LINES = 500
const READ_MAX_MATCHES = 3
const DEFAULT_LIMIT = 10
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const DECISIONS_DIR = join(VAULT_ROOT, "docs", "decisions")
const ADR_INDEX_PATH = join(DECISIONS_DIR, "README.md")
const ADR_VALID_STATUSES = ["proposed", "accepted", "shipped", "superseded", "deprecated", "rejected"] as const
const ADR_VALID_STATUS_SET = new Set<string>(ADR_VALID_STATUSES)
const ADR_OPEN_STATUSES = ["accepted", "proposed"] as const
const ADR_PRIORITY_STATUS_DEFAULT = ADR_OPEN_STATUSES
const ADR_PRIORITY_BANDS = ["do-now", "next", "de-risk", "park"] as const
const ADR_PRIORITY_BAND_SET = new Set<string>(ADR_PRIORITY_BANDS)
const ADR_PRIORITY_BAND_ORDER: Record<(typeof ADR_PRIORITY_BANDS)[number], number> = {
  "do-now": 0,
  next: 1,
  "de-risk": 2,
  park: 3,
}
const ADR_PRIORITY_AXIS_MIN = 0
const ADR_PRIORITY_AXIS_MAX = 5
const ADR_PRIORITY_SCORE_MIN = 0
const ADR_PRIORITY_SCORE_MAX = 100
const ADR_PRIORITY_NEED_WEIGHT = 0.5
const ADR_PRIORITY_READINESS_WEIGHT = 0.3
const ADR_PRIORITY_CONFIDENCE_WEIGHT = 0.2
const ADR_PRIORITY_NOVELTY_DEFAULT = 3
const ADR_PRIORITY_NOVELTY_DELTA_PER_POINT = 5

type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type ResolvedMatch = {
  path: string
  score: number
  reason: "adr" | "project" | "path" | "fuzzy"
}

type AdrCatalogItem = {
  number: string
  slug: string
  filename: string
  path: string
  title: string
  status: string | null
  date: string | null
  supersededByRaw: string | null
  frontmatter: Record<string, string>
}

type AdrNumberCollision = {
  number: string
  files: string[]
}

type AdrPriorityBand = (typeof ADR_PRIORITY_BANDS)[number]

type AdrPriorityAssessment = {
  number: string
  title: string
  filename: string
  status: string | null
  date: string | null
  need: number | null
  readiness: number | null
  confidence: number | null
  novelty: number | null
  noveltyUsed: number
  declaredScore: number | null
  declaredBand: AdrPriorityBand | null
  expectedScore: number | null
  expectedBand: AdrPriorityBand | null
  scoreDrift: number | null
  bandDrift: boolean
  reviewed: string | null
  rationale: string | null
  requiredIssues: string[]
  consistencyIssues: string[]
}

const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

async function runProcess(cmd: string[], input?: string, env?: Record<string, string | undefined>): Promise<ProcessResult> {
  const proc = Bun.spawn({
    cmd,
    env: env ? { ...process.env, ...env } : process.env,
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (input && proc.stdin) {
    const writer = proc.stdin.getWriter()
    await writer.write(new TextEncoder().encode(input))
    await writer.close()
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return {
    exitCode,
    stdout,
    stderr,
  }
}

async function runShell(command: string, input?: string): Promise<ProcessResult> {
  return runProcess(["bash", "-lc", command], input)
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return normalize(join(homedir(), path.slice(2)))
  }
  if (path.startsWith("~")) {
    return normalize(join(homedir(), path.slice(1)))
  }
  if (isAbsolute(path)) {
    return normalize(path)
  }
  return normalize(join(VAULT_ROOT, path))
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

function isWithinVault(path: string): boolean {
  return path === VAULT_ROOT || path.startsWith(`${VAULT_ROOT}/`)
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
}

function scorePath(path: string, query: string): number {
  const lowerPath = path.toLowerCase()
  const base = basename(path).toLowerCase()
  const queryLower = query.toLowerCase()

  let score = 0
  if (base === `${queryLower}.md` || base === queryLower) score += 140
  if (base.includes(queryLower)) score += 80
  if (lowerPath.includes(queryLower)) score += 40

  for (const token of tokenize(query)) {
    if (base.includes(token)) score += 30
    else if (lowerPath.includes(token)) score += 10
  }

  return score
}

function parseAdrRef(ref: string): string | null {
  const match = ref.match(/\badr[-\s_]?0*(\d{1,4})\b/i)
  if (!match?.[1]) return null
  return `${Number.parseInt(match[1], 10)}`.padStart(4, "0")
}

function parseProjectRef(ref: string): string | null {
  const match = ref.match(/\bproject\s+0*(\d{1,4})\b/i)
  if (!match?.[1]) return null
  return `${Number.parseInt(match[1], 10)}`
}

function looksLikePath(ref: string): boolean {
  return ref.startsWith("~/") || ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../")
}

function truncateByLines(content: string, maxLines = READ_MAX_LINES): {
  text: string
  totalLines: number
  truncated: boolean
} {
  const lines = content.split(/\r?\n/)
  const truncated = lines.length > maxLines
  return {
    text: lines.slice(0, maxLines).join("\n"),
    totalLines: lines.length,
    truncated,
  }
}

async function resolveAdrMatches(paddedAdr: string): Promise<string[]> {
  const decisionsDir = join(VAULT_ROOT, "docs", "decisions")
  const command = `find ${shq(decisionsDir)} -maxdepth 1 -type f -name ${shq(`${paddedAdr}-*.md`)} | sort`
  const out = await runShell(command)
  if (out.exitCode !== 0 && out.stdout.trim().length === 0) return []
  return out.stdout
     .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalize(line))
}

async function resolveProjectMatches(projectNumber: string): Promise<string[]> {
  const projectsDir = join(VAULT_ROOT, "Projects")
  const raw = `${Number.parseInt(projectNumber, 10)}`
  const padded2 = raw.padStart(2, "0")
  const patterns = [`*/${raw}*-*/index.md`, `*/${padded2}*-*/index.md`]

  const all: string[] = []
  for (const pattern of patterns) {
    const command = `find ${shq(projectsDir)} -maxdepth 2 -type f -path ${shq(pattern)} | sort`
    const out = await runShell(command)
    if (out.stdout.trim().length === 0) continue
    all.push(
      ...out.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => normalize(line))
    )
  }

  return Array.from(new Set(all))
}

async function resolveFuzzyMatches(query: string): Promise<string[]> {
  const tokens = tokenize(query)
  const grepChain = tokens.length > 0
    ? tokens.map((token) => ` | grep -iF ${shq(token)}`).join("")
    : ` | grep -iF ${shq(query)}`

  const command = [
    `find ${shq(VAULT_ROOT)} -type f -name "*.md"`,
    `! -path "*/.obsidian/*" ! -path "*/.git/*"`,
    grepChain,
    ` | head -n 25`,
  ].join(" ")

  const out = await runShell(command)
  const candidates = out.stdout
     .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalize(line))

  return candidates
    .map((path) => ({ path, score: scorePath(path, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, READ_MAX_MATCHES)
    .map((entry) => entry.path)
}

async function resolveReadReference(ref: string): Promise<ResolvedMatch[]> {
  const trimmed = ref.trim()
  if (!trimmed) return []

  if (looksLikePath(trimmed)) {
    const path = expandPath(trimmed)
    if (isWithinVault(path) && await isReadableFile(path)) {
      return [{ path, score: 1000, reason: "path" }]
    }
    return []
  }

  const adr = parseAdrRef(trimmed)
  if (adr) {
    const matches = await resolveAdrMatches(adr)
    return matches.map((path, idx) => ({ path, score: 900 - idx, reason: "adr" }))
  }

  const project = parseProjectRef(trimmed)
  if (project) {
    const matches = await resolveProjectMatches(project)
    return matches.map((path, idx) => ({ path, score: 800 - idx, reason: "project" }))
  }

  const fuzzy = await resolveFuzzyMatches(trimmed)
  return fuzzy.map((path, idx) => ({ path, score: 700 - idx, reason: "fuzzy" }))
}

async function readFileForContext(path: string): Promise<{
  path: string
  content: string
  total_lines: number
  truncated: boolean
  read_error?: string
}> {
  try {
    const content = await readFile(path, "utf8")
    const truncated = truncateByLines(content)
    return {
      path,
      content: truncated.text,
      total_lines: truncated.totalLines,
      truncated: truncated.truncated,
    }
  } catch (error) {
    return {
      path,
      content: "",
      total_lines: 0,
      truncated: false,
      read_error: String(error),
    }
  }
}

type VaultSemanticHit = {
  document?: Record<string, unknown>
  highlights?: Array<{ field?: string; snippet?: string }>
  text_match_info?: { score?: number }
  hybrid_search_info?: { rank_fusion_score?: number }
}

async function searchVaultSemantic(
  query: string,
  limit: number,
  apiKey: string
): Promise<{ found: number; hits: VaultSemanticHit[] }> {
  const params = new URLSearchParams({
    q: query,
    query_by: "embedding,title,content",
    vector_query: "embedding:([], alpha: 0.7)",
    per_page: String(limit),
    highlight_full_fields: "title,content",
    exclude_fields: "embedding",
  })

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/vault_notes/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Typesense semantic search failed (${resp.status}): ${text}`)
  }

  const payload = await resp.json() as { found?: number; hits?: VaultSemanticHit[] }
  return { found: payload.found ?? 0, hits: payload.hits ?? [] }
}

function extractFrontmatterStatus(markdown: string): string | null {
  if (!markdown.startsWith("---\n")) return null
  const end = markdown.indexOf("\n---", 4)
  if (end === -1) return null
  const fm = markdown.slice(4, end)
  const match = fm.match(/^status:\s*(.+)$/im)
  return match?.[1]?.trim() ?? null
}

async function readStatus(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8")
    return extractFrontmatterStatus(content)
  } catch {
    return null
  }
}

function sanitizeSimpleValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function parseFrontmatterMap(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---\n")) return {}
  const end = markdown.indexOf("\n---", 4)
  if (end === -1) return {}

  const map: Record<string, string> = {}
  const lines = markdown.slice(4, end).split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf(":")
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim().toLowerCase()
    const raw = trimmed.slice(idx + 1).trim()
    if (!key || !raw) continue
    map[key] = sanitizeSimpleValue(raw)
  }
  return map
}

function parseAdrFilename(filename: string): { number: string; slug: string } | null {
  const match = filename.match(/^(\d{4})-(.+)\.md$/)
  if (!match?.[1] || !match?.[2]) return null
  return { number: match[1], slug: match[2] }
}

function cleanAdrTitle(raw: string, fallbackSlug: string): string {
  const compact = raw.trim().replace(/\s+/g, " ")
  if (!compact) return fallbackSlug.replace(/-/g, " ")

  return compact
    .replace(/^ADR-\d{4}:\s*/i, "")
    .replace(/^\d{4}\s+[—-]\s*/i, "")
    .replace(/^\d{1,4}\.\s*/, "")
    .trim()
}

function extractAdrTitle(markdown: string, fallbackSlug: string): string {
  const fm = parseFrontmatterMap(markdown)
  const fmTitle = fm.title?.trim()
  if (fmTitle) return cleanAdrTitle(fmTitle, fallbackSlug)

  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return cleanAdrTitle(heading, fallbackSlug)

  return fallbackSlug.replace(/-/g, " ")
}

function normalizeStatusValue(value: string | null): string | null {
  if (!value) return null
  return sanitizeSimpleValue(value).toLowerCase()
}

function extractSupersededByTargets(raw: string | null): string[] {
  if (!raw) return []

  const normalized = sanitizeSimpleValue(raw)
  if (!normalized || ["[]", "none", "null", "n/a", "na"].includes(normalized.toLowerCase())) {
    return []
  }

  const candidates: string[] = []
  for (const match of normalized.matchAll(/\(([^)]+)\)/g)) {
    if (match[1]) candidates.push(match[1])
  }

  const collapsed = normalized
    .replace(/\[[^\]]*\]\(([^)]+)\)/g, "$1")
    .replace(/[\[\]"]+/g, "")

  for (const part of collapsed.split(/[,;]+/g)) {
    const candidate = part.trim()
    if (!candidate) continue
    candidates.push(candidate)
  }

  return Array.from(new Set(candidates.map((candidate) => basename(candidate.trim()))))
}

function supersededTargetExists(target: string, filenames: Set<string>, numbers: Set<string>): boolean {
  const normalized = target.trim().toLowerCase()
  if (!normalized || normalized === ".md") return true

  if (/^adr-?\d{4}$/.test(normalized)) {
    const match = normalized.match(/(\d{4})/)
    return Boolean(match?.[1] && numbers.has(match[1]))
  }

  if (/^\d{4}$/.test(normalized)) return numbers.has(normalized)
  if (/^\d{4}\.md$/.test(normalized)) return numbers.has(normalized.slice(0, 4))

  if (/^\d{4}-.+\.md$/.test(normalized)) return filenames.has(normalized)
  if (/^\d{4}-.+$/.test(normalized)) return filenames.has(`${normalized}.md`)

  const embeddedNumber = normalized.match(/(\d{4})/)
  if (embeddedNumber?.[1]) return numbers.has(embeddedNumber[1])

  return false
}

function findAdrNumberCollisions(items: ReadonlyArray<{ number: string; filename: string }>): AdrNumberCollision[] {
  const grouped = new Map<string, string[]>()

  for (const item of items) {
    const files = grouped.get(item.number) ?? []
    files.push(item.filename)
    grouped.set(item.number, files)
  }

  return Array.from(grouped.entries())
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({ number, files: files.slice().sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.number.localeCompare(b.number))
}

function parseAdrReadmeRows(markdown: string): string[] {
  const rows: string[] = []
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\| \[\d{4}\]\(([^)]+)\) \|/)
    if (!match?.[1]) continue
    rows.push(match[1])
  }
  return rows
}

function parseStatusFilterList(raw: string): string[] {
  return raw
    .split(/[\s,]+/g)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
}

function parseBoundedNumber(value: string | undefined, min: number, max: number): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed < min || parsed > max) return null
  return parsed
}

function parsePriorityBand(value: string | null): AdrPriorityBand | null {
  if (!value) return null
  const normalized = sanitizeSimpleValue(value).toLowerCase()
  return ADR_PRIORITY_BAND_SET.has(normalized)
    ? normalized as AdrPriorityBand
    : null
}

function derivePriorityBand(score: number): AdrPriorityBand {
  if (score >= 80) return "do-now"
  if (score >= 60) return "next"
  if (score >= 40) return "de-risk"
  return "park"
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function computePriorityScore(input: {
  need: number
  readiness: number
  confidence: number
  novelty?: number | null
}): number {
  const weightedBase = 20 * (
    ADR_PRIORITY_NEED_WEIGHT * input.need
    + ADR_PRIORITY_READINESS_WEIGHT * input.readiness
    + ADR_PRIORITY_CONFIDENCE_WEIGHT * input.confidence
  )

  const noveltyUsed = input.novelty ?? ADR_PRIORITY_NOVELTY_DEFAULT
  const noveltyDelta = Math.round((noveltyUsed - ADR_PRIORITY_NOVELTY_DEFAULT) * ADR_PRIORITY_NOVELTY_DELTA_PER_POINT)

  return clampNumber(
    Math.round(weightedBase) + noveltyDelta,
    ADR_PRIORITY_SCORE_MIN,
    ADR_PRIORITY_SCORE_MAX,
  )
}

function parsePriorityAxis(frontmatter: Record<string, string>, field: string): {
  value: number | null
  issue?: string
} {
  const raw = frontmatter[field]
  if (!raw) return { value: null, issue: `missing ${field}` }

  const parsed = parseBoundedNumber(raw, ADR_PRIORITY_AXIS_MIN, ADR_PRIORITY_AXIS_MAX)
  if (parsed === null) {
    return {
      value: null,
      issue: `invalid ${field} (${raw}); expected ${ADR_PRIORITY_AXIS_MIN}-${ADR_PRIORITY_AXIS_MAX}`,
    }
  }

  return { value: parsed }
}

function parsePriorityNovelty(frontmatter: Record<string, string>): {
  value: number | null
  issue?: string
  source?: string
} {
  const keys = [
    "priority-novelty",
    "priority-interest",
    "priority-interestingness",
    "priority-cool-factor",
  ]

  for (const key of keys) {
    const raw = frontmatter[key]
    if (!raw) continue

    const parsed = parseBoundedNumber(raw, ADR_PRIORITY_AXIS_MIN, ADR_PRIORITY_AXIS_MAX)
    if (parsed === null) {
      return {
        value: null,
        issue: `invalid ${key} (${raw}); expected ${ADR_PRIORITY_AXIS_MIN}-${ADR_PRIORITY_AXIS_MAX}`,
        source: key,
      }
    }

    return { value: parsed, source: key }
  }

  return { value: null }
}

function assessAdrPriority(item: AdrCatalogItem): AdrPriorityAssessment {
  const frontmatter = item.frontmatter

  const need = parsePriorityAxis(frontmatter, "priority-need")
  const readiness = parsePriorityAxis(frontmatter, "priority-readiness")
  const confidence = parsePriorityAxis(frontmatter, "priority-confidence")
  const novelty = parsePriorityNovelty(frontmatter)

  const declaredScore = parseBoundedNumber(frontmatter["priority-score"], ADR_PRIORITY_SCORE_MIN, ADR_PRIORITY_SCORE_MAX)
  const declaredBand = parsePriorityBand(frontmatter["priority-band"] ?? null)
  const reviewed = frontmatter["priority-reviewed"] ?? null
  const rationale = frontmatter["priority-rationale"] ?? null

  const requiredIssues = [need.issue, readiness.issue, confidence.issue]
    .filter((issue): issue is string => Boolean(issue))

  if (!frontmatter["priority-score"]) requiredIssues.push("missing priority-score")
  else if (declaredScore === null) {
    requiredIssues.push(
      `invalid priority-score (${frontmatter["priority-score"]}); expected ${ADR_PRIORITY_SCORE_MIN}-${ADR_PRIORITY_SCORE_MAX}`,
    )
  }

  if (!frontmatter["priority-band"]) requiredIssues.push("missing priority-band")
  else if (!declaredBand) {
    requiredIssues.push(`invalid priority-band (${frontmatter["priority-band"]}); expected ${ADR_PRIORITY_BANDS.join("|")}`)
  }

  if (!reviewed) requiredIssues.push("missing priority-reviewed")
  if (!rationale) requiredIssues.push("missing priority-rationale")

  const consistencyIssues: string[] = []

  if (novelty.issue) consistencyIssues.push(novelty.issue)
  if (novelty.value === null && !novelty.issue) {
    consistencyIssues.push(`missing priority-novelty (assumed neutral ${ADR_PRIORITY_NOVELTY_DEFAULT})`)
  }

  const canCompute = need.value !== null && readiness.value !== null && confidence.value !== null

  let expectedScore: number | null = null
  let expectedBand: AdrPriorityBand | null = null
  let scoreDrift: number | null = null
  let bandDrift = false

  if (canCompute) {
    expectedScore = computePriorityScore({
      need: need.value,
      readiness: readiness.value,
      confidence: confidence.value,
      novelty: novelty.value,
    })
    expectedBand = derivePriorityBand(expectedScore)

    if (declaredScore !== null) {
      scoreDrift = declaredScore - expectedScore
      if (scoreDrift !== 0) {
        consistencyIssues.push(`priority-score drift: declared=${declaredScore}, expected=${expectedScore}`)
      }
    }

    if (declaredBand && declaredBand !== expectedBand) {
      bandDrift = true
      consistencyIssues.push(`priority-band drift: declared=${declaredBand}, expected=${expectedBand}`)
    }
  }

  return {
    number: item.number,
    title: item.title,
    filename: item.filename,
    status: item.status,
    date: item.date,
    need: need.value,
    readiness: readiness.value,
    confidence: confidence.value,
    novelty: novelty.value,
    noveltyUsed: novelty.value ?? ADR_PRIORITY_NOVELTY_DEFAULT,
    declaredScore,
    declaredBand,
    expectedScore,
    expectedBand,
    scoreDrift,
    bandDrift,
    reviewed,
    rationale,
    requiredIssues,
    consistencyIssues,
  }
}

function comparePriorityAssessments(a: AdrPriorityAssessment, b: AdrPriorityAssessment): number {
  const aBandRank = a.expectedBand ? ADR_PRIORITY_BAND_ORDER[a.expectedBand] : Number.MAX_SAFE_INTEGER
  const bBandRank = b.expectedBand ? ADR_PRIORITY_BAND_ORDER[b.expectedBand] : Number.MAX_SAFE_INTEGER
  if (aBandRank !== bBandRank) return aBandRank - bBandRank

  const aScore = a.expectedScore ?? -1
  const bScore = b.expectedScore ?? -1
  if (aScore !== bScore) return bScore - aScore

  const aNeed = a.need ?? -1
  const bNeed = b.need ?? -1
  if (aNeed !== bNeed) return bNeed - aNeed

  return a.number.localeCompare(b.number) || a.filename.localeCompare(b.filename)
}

async function listAdrPaths(): Promise<string[]> {
  const out = await runShell(`find ${shq(DECISIONS_DIR)} -maxdepth 1 -type f -name "[0-9][0-9][0-9][0-9]-*.md" | sort`)
  if (out.exitCode !== 0 && out.stdout.trim().length === 0) return []

  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalize(line))
}

async function loadAdrCatalogItem(path: string): Promise<AdrCatalogItem | null> {
  const filename = basename(path)
  const parsed = parseAdrFilename(filename)
  if (!parsed) return null

  const markdown = await readFile(path, "utf8")
  const frontmatter = parseFrontmatterMap(markdown)
  const status = normalizeStatusValue(frontmatter.status ?? extractFrontmatterStatus(markdown))

  return {
    number: parsed.number,
    slug: parsed.slug,
    filename,
    path,
    title: extractAdrTitle(markdown, parsed.slug),
    status,
    date: frontmatter.date ?? null,
    supersededByRaw: frontmatter["superseded-by"] ?? null,
    frontmatter,
  }
}

async function loadAdrCatalog(): Promise<AdrCatalogItem[]> {
  const paths = await listAdrPaths()
  const loaded = await Promise.all(paths.map(async (path) => {
    try {
      return await loadAdrCatalogItem(path)
    } catch {
      return null
    }
  }))

  return loaded
    .filter((item): item is AdrCatalogItem => item !== null)
    .sort((a, b) => a.number.localeCompare(b.number) || a.filename.localeCompare(b.filename))
}

const readCmd = Command.make(
  "read",
  {
    ref: Args.text({ name: "ref" }),
  },
  ({ ref }) =>
    Effect.gen(function* () {
      const matches = yield* Effect.tryPromise(() => resolveReadReference(ref))

      if (matches.length === 0) {
        yield* Console.log(respondError(
          "vault read",
          `No vault file matched reference: ${ref}`,
          "NO_MATCH",
          "Try ADR-####, project <num>, an explicit ~/Vault path, or a tighter fuzzy phrase",
          [
            {
              command: "joelclaw vault search <query>",
              description: "Search vault content by text",
              params: {
                query: { description: "Text query", value: ref, required: true },
              },
            },
            { command: "joelclaw vault ls", description: "Show PARA section summary" },
          ]
        ))
        return
      }

      const files = yield* Effect.tryPromise(() =>
        Promise.all(matches.map((m) => readFileForContext(m.path)))
      )

      yield* Console.log(respond("vault read", {
        ref,
        vault_root: VAULT_ROOT,
        resolved: files,
        resolution: matches.map((match) => ({ path: match.path, reason: match.reason, score: match.score })),
      }, [
        {
          command: "joelclaw vault read <ref>",
          description: "Read another vault reference",
          params: {
            ref: { description: "ADR, project ref, path, or fuzzy query", required: true },
          },
        },
        {
          command: "joelclaw vault search <query>",
          description: "Search for related content",
          params: {
            query: { description: "Vault text query", value: ref, required: true },
          },
        },
        {
          command: "joelclaw vault tree",
          description: "Quickly orient in vault structure",
        },
      ]))
    })
)

const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    semantic: Options.boolean("semantic").pipe(Options.withDefault(false)),
    limit: Options.integer("limit").pipe(Options.withDefault(DEFAULT_LIMIT)),
  },
  ({ query, semantic, limit }) =>
    Effect.gen(function* () {
      const safeLimit = Math.max(1, Math.min(limit, 100))

      if (semantic) {
        try {
          const apiKey = resolveTypesenseApiKey()
          const semanticResult = yield* Effect.tryPromise(() => searchVaultSemantic(query, safeLimit, apiKey))
          const hits = semanticResult.hits.slice(0, safeLimit).map((hit) => {
            const payload = hit.document ?? {}
            const highlight = (hit.highlights ?? []).find((entry) => entry?.snippet)
            const context = typeof highlight?.snippet === "string"
              ? highlight.snippet
              : typeof payload.content === "string"
                ? payload.content.slice(0, 220)
                : typeof payload.title === "string"
                  ? payload.title
                  : null
            return {
              score: hit.text_match_info?.score ?? hit.hybrid_search_info?.rank_fusion_score ?? 0,
              path: typeof payload.path === "string" ? payload.path : null,
              line: null,
              context,
              payload,
            }
          })

          yield* Console.log(respond("vault search", {
            query,
            mode: "semantic",
            limit: safeLimit,
            backend: "typesense",
            collection: "vault_notes",
            found: semanticResult.found,
            hits,
          }, [
            {
              command: "joelclaw vault search <query> [--semantic] [--limit <limit>]",
              description: "Run another semantic search",
              params: {
                query: { description: "Semantic query", value: query, required: true },
                limit: { description: "Max hits", value: safeLimit, default: DEFAULT_LIMIT },
              },
            },
            {
              command: "joelclaw vault search <query> [--limit <limit>]",
              description: "Fallback to ripgrep text search",
              params: {
                query: { description: "Text query", value: query, required: true },
                limit: { description: "Max matches", value: safeLimit, default: DEFAULT_LIMIT },
              },
            },
          ]))
          return
        } catch (error) {
          if (isTypesenseApiKeyError(error)) {
            yield* Console.log(respondError(
              "vault search",
              error.message,
              error.code,
              error.fix,
              [
                {
                  command: "joelclaw vault search <query>",
                  description: "Use ripgrep text search instead",
                  params: {
                    query: { description: "Text query", value: query, required: true },
                  },
                },
              ]
            ))
            return
          }

          const message = error instanceof Error ? error.message : String(error)
          const unreachable = message.includes("ECONNREFUSED") || message.includes("Connection refused")
          yield* Console.log(respondError(
            "vault search",
            message,
            unreachable ? "TYPESENSE_UNREACHABLE" : "SEMANTIC_SEARCH_FAILED",
            unreachable
              ? "Start Typesense port-forward: kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"
              : "Check Typesense health and vault_notes indexing",
            [
              {
                command: "joelclaw vault search <query>",
                description: "Use ripgrep text search instead",
                params: {
                  query: { description: "Text query", value: query, required: true },
                },
              },
            ]
          ))
          return
        }
      }

      const rg = yield* Effect.tryPromise(() =>
        runProcess([
          "rg",
          "--json",
          "--line-number",
          "--smart-case",
          "--glob",
          "!**/.obsidian/**",
          "--glob",
          "!**/.git/**",
          query,
          VAULT_ROOT,
        ])
      )

      if (rg.exitCode !== 0 && rg.exitCode !== 1) {
        yield* Console.log(respondError(
          "vault search",
          rg.stderr.trim() || "ripgrep failed",
          "RG_FAILED",
          "Install ripgrep or verify vault path permissions",
          [
            {
              command: "joelclaw vault tree",
              description: "Verify vault path and structure",
            },
          ]
        ))
        return
      }

      const matches: Array<{ path: string; line: number; context: string }> = []
      for (const line of rg.stdout.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const evt = JSON.parse(trimmed) as any
          if (evt?.type !== "match") continue
          matches.push({
            path: evt?.data?.path?.text ?? "unknown",
            line: evt?.data?.line_number ?? 0,
            context: (evt?.data?.lines?.text ?? "").trim(),
          })
        } catch {
          continue
        }
      }

      const limited = matches.slice(0, safeLimit)

      yield* Console.log(respond("vault search", {
        query,
        mode: "text",
        limit: safeLimit,
        total_matches: matches.length,
        matches: limited,
      }, [
        {
          command: "joelclaw vault search <query> [--limit <limit>]",
          description: "Run another text search",
          params: {
            query: { description: "Vault text query", value: query, required: true },
            limit: { description: "Max matches", value: safeLimit, default: DEFAULT_LIMIT },
          },
        },
        {
          command: "joelclaw vault search <query> --semantic [--limit <limit>]",
          description: "Try semantic search in Typesense",
          params: {
            query: { description: "Semantic query", value: query, required: true },
            limit: { description: "Max hits", value: safeLimit, default: DEFAULT_LIMIT },
          },
        },
      ]))
    })
)

const lsCmd = Command.make(
  "ls",
  {
    section: Args.text({ name: "section" }).pipe(Args.withDefault("")),
  },
  ({ section }) =>
    Effect.gen(function* () {
      const normalized = section.trim().toLowerCase()

      if (!normalized) {
        const [projects, decisions, inbox, resources] = yield* Effect.tryPromise(() => Promise.all([
          runShell(`find ${shq(join(VAULT_ROOT, "Projects"))} -maxdepth 2 -type f -name index.md | wc -l`),
          runShell(`find ${shq(join(VAULT_ROOT, "docs", "decisions"))} -maxdepth 1 -type f -name "*.md" | wc -l`),
          runShell(`find ${shq(join(VAULT_ROOT, "inbox"))} -maxdepth 1 -mindepth 1 | wc -l`),
          runShell(`find ${shq(join(VAULT_ROOT, "Resources"))} -maxdepth 1 -mindepth 1 -type d | wc -l`),
        ]))

        const toCount = (stdout: string) => Number.parseInt(stdout.trim(), 10) || 0
        yield* Console.log(respond("vault ls", {
          vault_root: VAULT_ROOT,
          sections: {
            projects: toCount(projects.stdout),
            decisions: toCount(decisions.stdout),
            inbox: toCount(inbox.stdout),
            resources: toCount(resources.stdout),
          },
        }, [
          { command: "joelclaw vault ls projects", description: "List project indexes and status" },
          { command: "joelclaw vault ls decisions", description: "List decision docs and status" },
          { command: "joelclaw vault ls inbox", description: "List inbox items" },
          { command: "joelclaw vault ls resources", description: "List resource folders" },
        ]))
        return
      }

      if (normalized === "projects") {
        const out = yield* Effect.tryPromise(() =>
          runShell(`find ${shq(join(VAULT_ROOT, "Projects"))} -maxdepth 2 -type f -name index.md | sort`)
        )

        const files = out.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => normalize(line))

        const rows = yield* Effect.tryPromise(() =>
          Promise.all(files.map(async (path) => ({
            path,
            status: await readStatus(path),
          })))
        )

        yield* Console.log(respond("vault ls", {
          section: "projects",
          count: rows.length,
          items: rows,
        }, [
          {
            command: "joelclaw vault read <ref>",
            description: "Read a project index",
            params: {
              ref: { description: "Project ref like 'project 09' or exact path", required: true },
            },
          },
        ]))
        return
      }

      if (normalized === "decisions") {
        const out = yield* Effect.tryPromise(() =>
          runShell(`find ${shq(join(VAULT_ROOT, "docs", "decisions"))} -maxdepth 1 -type f -name "*.md" | sort`)
        )

        const files = out.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => normalize(line))

        const rows = yield* Effect.tryPromise(() =>
          Promise.all(files.map(async (path) => ({
            path,
            status: await readStatus(path),
          })))
        )

        yield* Console.log(respond("vault ls", {
          section: "decisions",
          count: rows.length,
          items: rows,
        }, [
          {
            command: "joelclaw vault read <ref>",
            description: "Read an ADR by reference",
            params: {
              ref: { description: "ADR reference (e.g. ADR-0077)", value: "ADR-0001", required: true },
            },
          },
          { command: "joelclaw vault adr list", description: "List ADR metadata with status/date/title" },
        ]))
        return
      }

      if (normalized === "inbox") {
        const out = yield* Effect.tryPromise(() =>
          runShell(`find ${shq(join(VAULT_ROOT, "inbox"))} -maxdepth 1 -mindepth 1 | sort`)
        )

        const items = out.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => normalize(line))

        yield* Console.log(respond("vault ls", {
          section: "inbox",
          count: items.length,
          items,
        }, [
          {
            command: "joelclaw vault read <ref>",
            description: "Read an inbox item by path",
            params: {
              ref: { description: "Inbox file path", required: true },
            },
          },
        ]))
        return
      }

      if (normalized === "resources") {
        const out = yield* Effect.tryPromise(() =>
          runShell(`find ${shq(join(VAULT_ROOT, "Resources"))} -maxdepth 1 -mindepth 1 -type d | sort`)
        )

        const items = out.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => normalize(line))

        yield* Console.log(respond("vault ls", {
          section: "resources",
          count: items.length,
          items,
        }, [
          {
            command: "joelclaw vault tree",
            description: "Inspect overall vault structure",
          },
        ]))
        return
      }

      yield* Console.log(respondError(
        "vault ls",
        `Unknown section: ${section}`,
        "INVALID_SECTION",
        "Use one of: projects, decisions, inbox, resources",
        [
          {
            command: "joelclaw vault ls",
            description: "Show valid vault sections",
          },
        ]
      ))
    })
)

const adrListCmd = Command.make(
  "list",
  {
    status: Options.text("status").pipe(Options.withDefault("")),
    limit: Options.integer("limit").pipe(Options.withDefault(200)),
  },
  ({ status, limit }) =>
    Effect.gen(function* () {
      const normalizedStatus = normalizeStatusValue(status)
      if (normalizedStatus && !ADR_VALID_STATUS_SET.has(normalizedStatus)) {
        yield* Console.log(respondError(
          "vault adr list",
          `Invalid ADR status filter: ${status}`,
          "INVALID_ADR_STATUS",
          `Use one of: ${ADR_VALID_STATUSES.join(", ")}`,
          [
            { command: "joelclaw vault adr list", description: "List ADRs without status filter" },
            { command: "joelclaw vault adr audit", description: "Inspect ADR health and collisions" },
          ]
        ))
        return
      }

      const safeLimit = Math.max(1, Math.min(limit, 500))
      const catalog = yield* Effect.tryPromise(() => loadAdrCatalog())
      const filtered = normalizedStatus
        ? catalog.filter((item) => item.status === normalizedStatus)
        : catalog

      const collisions = findAdrNumberCollisions(catalog)

      yield* Console.log(respond("vault adr list", {
        total: catalog.length,
        filtered: filtered.length,
        status_filter: normalizedStatus,
        limit: safeLimit,
        collisions: collisions.length,
        items: filtered.slice(0, safeLimit).map((item) => ({
          number: item.number,
          title: item.title,
          status: item.status,
          date: item.date,
          filename: item.filename,
        })),
      }, [
        {
          command: "joelclaw vault read <ref>",
          description: "Read an ADR body",
          params: {
            ref: { description: "ADR reference (e.g. ADR-0168)", required: true },
          },
        },
        { command: "joelclaw vault adr collisions", description: "List duplicate ADR numbers" },
        { command: "joelclaw vault adr audit", description: "Run full ADR metadata audit" },
      ]))
    })
)

const adrCollisionsCmd = Command.make("collisions", {}, () =>
  Effect.gen(function* () {
    const catalog = yield* Effect.tryPromise(() => loadAdrCatalog())
    const collisions = findAdrNumberCollisions(catalog)

    yield* Console.log(respond("vault adr collisions", {
      total: catalog.length,
      collision_count: collisions.length,
      collisions,
    }, [
      { command: "joelclaw vault adr audit", description: "Run full ADR audit checks" },
      {
        command: "joelclaw vault adr list [--status <status>] [--limit <limit>]",
        description: "List ADR metadata",
        params: {
          status: { description: "Optional status filter", enum: [...ADR_VALID_STATUSES] },
          limit: { description: "Maximum rows", value: 200, default: 200 },
        },
      },
    ]))
  })
)

const adrAuditCmd = Command.make("audit", {}, () =>
  Effect.gen(function* () {
    const catalog = yield* Effect.tryPromise(() => loadAdrCatalog())

    const missingStatus = catalog
      .filter((item) => item.status === null)
      .map((item) => item.filename)

    const nonCanonical = catalog
      .filter((item) => item.status !== null && !ADR_VALID_STATUS_SET.has(item.status))
      .map((item) => ({ filename: item.filename, status: item.status }))

    const statusCounts = catalog.reduce<Record<string, number>>((acc, item) => {
      const key = item.status ?? "missing"
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})

    const collisions = findAdrNumberCollisions(catalog)
    const filenameSet = new Set(catalog.map((item) => item.filename))
    const numberSet = new Set(catalog.map((item) => item.number))

    const missingSupersededByTargets = catalog
      .flatMap((item) =>
        extractSupersededByTargets(item.supersededByRaw).map((target) => ({ from: item.filename, target }))
      )
      .filter((entry) => !supersededTargetExists(entry.target, filenameSet, numberSet))

    const hasIndex = yield* Effect.tryPromise(() => isReadableFile(ADR_INDEX_PATH))
    const indexRows = hasIndex
      ? parseAdrReadmeRows(yield* Effect.tryPromise(() => readFile(ADR_INDEX_PATH, "utf8")))
      : []

    const indexRowSet = new Set(indexRows)
    const missingFromIndex = catalog.map((item) => item.filename).filter((name) => !indexRowSet.has(name))
    const extraInIndex = indexRows.filter((name) => !filenameSet.has(name))

    const ok =
      missingStatus.length === 0
      && nonCanonical.length === 0
      && collisions.length === 0
      && missingSupersededByTargets.length === 0
      && hasIndex
      && missingFromIndex.length === 0
      && extraInIndex.length === 0

    yield* Console.log(respond("vault adr audit", {
      ok,
      decisions_dir: DECISIONS_DIR,
      index_path: ADR_INDEX_PATH,
      total: catalog.length,
      canonical_statuses: ADR_VALID_STATUSES,
      status_counts: statusCounts,
      missing_status: missingStatus,
      non_canonical_status: nonCanonical,
      collisions,
      superseded_by_missing_targets: missingSupersededByTargets,
      index: {
        exists: hasIndex,
        rows: indexRows.length,
        missing_from_index: missingFromIndex,
        extra_in_index: extraInIndex,
      },
    }, [
      { command: "joelclaw vault adr collisions", description: "Inspect duplicate ADR numbers" },
      { command: "joelclaw vault adr list", description: "Inspect all ADR metadata rows" },
      {
        command: "joelclaw vault read <ref>",
        description: "Open an ADR that failed audit checks",
        params: {
          ref: { description: "ADR reference or path", required: true },
        },
      },
    ], ok))
  })
)

const adrRankCmd = Command.make(
  "rank",
  {
    status: Options.text("status").pipe(Options.withDefault(ADR_PRIORITY_STATUS_DEFAULT.join(","))),
    limit: Options.integer("limit").pipe(Options.withDefault(100)),
    strict: Options.boolean("strict").pipe(Options.withDefault(false)),
  },
  ({ status, limit, strict }) =>
    Effect.gen(function* () {
      const requestedStatuses = parseStatusFilterList(status)
      const effectiveStatuses = requestedStatuses.length > 0
        ? requestedStatuses
        : [...ADR_PRIORITY_STATUS_DEFAULT]

      const invalidStatuses = effectiveStatuses.filter((value) => !ADR_VALID_STATUS_SET.has(value))
      if (invalidStatuses.length > 0) {
        yield* Console.log(respondError(
          "vault adr rank",
          `Invalid ADR status filter(s): ${invalidStatuses.join(", ")}`,
          "INVALID_ADR_STATUS",
          `Use one of: ${ADR_VALID_STATUSES.join(", ")}`,
          [
            {
              command: "joelclaw vault adr rank --status accepted,proposed",
              description: "Rank open ADRs with the NRC+Novelty rubric",
            },
            { command: "joelclaw vault adr list", description: "List ADRs without rubric ranking" },
          ]
        ))
        return
      }

      const safeLimit = Math.max(1, Math.min(limit, 500))
      const statusSet = new Set(effectiveStatuses)
      const catalog = yield* Effect.tryPromise(() => loadAdrCatalog())
      const filtered = catalog.filter((item) => item.status !== null && statusSet.has(item.status))

      const assessments = filtered
        .map((item) => assessAdrPriority(item))
        .sort(comparePriorityAssessments)

      const scored = assessments.filter((item) => item.expectedScore !== null)
      const unscored = assessments.filter((item) => item.expectedScore === null)
      const requiredIssueCount = assessments.reduce((sum, item) => sum + item.requiredIssues.length, 0)
      const consistencyIssueCount = assessments.reduce((sum, item) => sum + item.consistencyIssues.length, 0)
      const noveltyMissingCount = assessments.filter((item) => item.novelty === null).length

      const compliant = assessments.filter((item) => item.requiredIssues.length === 0 && item.consistencyIssues.length === 0)
      const output = (strict ? compliant : assessments)
        .slice(0, safeLimit)
        .map((item) => ({
          number: item.number,
          title: item.title,
          status: item.status,
          date: item.date,
          filename: item.filename,
          rubric: {
            need: item.need,
            readiness: item.readiness,
            confidence: item.confidence,
            novelty: item.novelty,
            novelty_used: item.noveltyUsed,
            score: item.expectedScore,
            band: item.expectedBand,
            reviewed: item.reviewed,
            rationale: item.rationale,
          },
          declared: {
            score: item.declaredScore,
            band: item.declaredBand,
          },
          drift: {
            score: item.scoreDrift,
            band: item.bandDrift,
          },
          issues: {
            required: item.requiredIssues,
            consistency: item.consistencyIssues,
          },
        }))

      yield* Console.log(respond("vault adr rank", {
        total: catalog.length,
        filtered: filtered.length,
        limit: safeLimit,
        strict,
        status_filter: effectiveStatuses,
        summary: {
          scored: scored.length,
          unscored: unscored.length,
          compliant: compliant.length,
          required_issue_count: requiredIssueCount,
          consistency_issue_count: consistencyIssueCount,
          novelty_missing_count: noveltyMissingCount,
        },
        rubric: {
          axes: {
            need: { field: "priority-need", range: "0-5", weight: ADR_PRIORITY_NEED_WEIGHT },
            readiness: { field: "priority-readiness", range: "0-5", weight: ADR_PRIORITY_READINESS_WEIGHT },
            confidence: { field: "priority-confidence", range: "0-5", weight: ADR_PRIORITY_CONFIDENCE_WEIGHT },
            novelty: {
              field: "priority-novelty (aliases: priority-interest|priority-interestingness|priority-cool-factor)",
              range: "0-5",
              default: ADR_PRIORITY_NOVELTY_DEFAULT,
              delta_per_point: ADR_PRIORITY_NOVELTY_DELTA_PER_POINT,
            },
          },
          formula: "score = clamp(round(20*(0.5*Need + 0.3*Readiness + 0.2*Confidence)) + round((Novelty-3)*5), 0, 100)",
          band_thresholds: {
            "do-now": "80-100",
            next: "60-79",
            "de-risk": "40-59",
            park: "0-39",
          },
        },
        items: output,
        unscored: unscored.slice(0, safeLimit).map((item) => ({
          number: item.number,
          title: item.title,
          filename: item.filename,
          status: item.status,
          required: item.requiredIssues,
        })),
      }, [
        {
          command: "joelclaw vault adr rank --status accepted,proposed --limit 50",
          description: "Run open-ADR ranking with rubric diagnostics",
        },
        {
          command: "joelclaw vault adr rank --status accepted,proposed --strict",
          description: "Show only fully compliant ADR rubric rows",
        },
        { command: "joelclaw vault adr audit", description: "Run structural ADR health audit" },
      ], requiredIssueCount === 0))
    })
)

const adrCmd = Command.make("adr", {}, () =>
  Console.log(respond("vault adr", {
    description: "ADR-focused command tree for inventory, collisions, ranking, and index integrity",
    decisions_dir: DECISIONS_DIR,
    index_path: ADR_INDEX_PATH,
    subcommands: {
      list: "joelclaw vault adr list [--status <status>] [--limit <limit>]",
      collisions: "joelclaw vault adr collisions",
      audit: "joelclaw vault adr audit",
      rank: "joelclaw vault adr rank [--status <status,status>] [--limit <limit>] [--strict]",
    },
  }, [
    { command: "joelclaw vault adr list", description: "List ADR metadata" },
    { command: "joelclaw vault adr collisions", description: "Show duplicate ADR numbers" },
    { command: "joelclaw vault adr audit", description: "Run full ADR health audit" },
    { command: "joelclaw vault adr rank --status accepted,proposed", description: "Rank open ADRs by NRC+novelty rubric" },
  ]))
).pipe(
  Command.withSubcommands([adrListCmd, adrCollisionsCmd, adrAuditCmd, adrRankCmd])
)

const treeCmd = Command.make("tree", {}, () =>
  Effect.gen(function* () {
    const out = yield* Effect.tryPromise(() =>
      runShell(`find ${shq(VAULT_ROOT)} -maxdepth 2 -type d ! -name ".obsidian" ! -name ".git" ! -path "*/.obsidian/*" ! -path "*/.git/*" | sort`)
    )

    const dirs = out.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => normalize(line))
      .map((path) => {
        const rel = path === VAULT_ROOT ? "." : path.slice(VAULT_ROOT.length + 1)
        const depth = rel === "." ? 0 : rel.split("/").length
        return { path: rel, depth }
      })

    yield* Console.log(respond("vault tree", {
      vault_root: VAULT_ROOT,
      max_depth: 2,
      directories: dirs,
    }, [
      { command: "joelclaw vault ls", description: "Show PARA section summary" },
      {
        command: "joelclaw vault search <query>",
        description: "Search inside vault files",
        params: {
          query: { description: "Text query", required: true },
        },
      },
      { command: "joelclaw vault adr audit", description: "Run ADR inventory audit" },
    ]))
  })
)

export const vaultCmd = Command.make("vault", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(respond("vault", {
      description: "Vault access commands",
      vault_root: VAULT_ROOT,
      commands: {
        read: "joelclaw vault read <ref>",
        search: "joelclaw vault search <query> [--semantic] [--limit <limit>]",
        ls: "joelclaw vault ls [section]",
        tree: "joelclaw vault tree",
        adr: "joelclaw vault adr {list|collisions|audit|rank}",
      },
    }, [
      {
        command: "joelclaw vault read <ref>",
        description: "Resolve and read ADR/project/path/fuzzy refs",
        params: {
          ref: { description: "Reference like ADR-0077, project 09, ~/Vault/...", required: true },
        },
      },
      {
        command: "joelclaw vault search <query>",
        description: "Text search vault markdown files",
        params: {
          query: { description: "Search query", required: true },
        },
      },
      { command: "joelclaw vault ls", description: "List vault sections" },
      { command: "joelclaw vault tree", description: "Show vault directory tree" },
      { command: "joelclaw vault adr audit", description: "Run ADR metadata/index audit" },
      { command: "joelclaw vault adr rank --status accepted,proposed", description: "Rank open ADRs with rubric drift checks" },
    ]))
  })
).pipe(
  Command.withSubcommands([readCmd, searchCmd, lsCmd, treeCmd, adrCmd])
)

export const __vaultTestUtils = {
  ADR_VALID_STATUSES,
  parseAdrFilename,
  normalizeStatusValue,
  findAdrNumberCollisions,
  parseAdrReadmeRows,
  parseStatusFilterList,
  parsePriorityBand,
  derivePriorityBand,
  computePriorityScore,
}
