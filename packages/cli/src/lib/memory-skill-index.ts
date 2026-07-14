import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

export type MemorySkillIndexEntry = {
  title: string
  description: string
  pointer: string
  sensitive: boolean
  source: "observation" | "brain"
  updated_at: string | null
}

export type MemorySkillIndex = {
  repo: string
  heading: {
    active_arc: string | null
    frontier: string | null
    since_last_session: string
  }
  day_index: string | null
  entries: MemorySkillIndexEntry[]
  budget: number
  ranking: "recency"
  interest_decay: { status: "reserved"; todo: string }
}

type Page = {
  path: string
  title: string
  description: string
  body: string
  frontmatter: Record<string, unknown>
  sensitive: boolean
  source: "observation" | "brain"
  updatedAt: number
  score: number
}

const DEFAULT_OBSERVATIONS_DIR = join(process.env.HOME ?? "", "Code/joelhooks/dark-wizard/.brain/observations")
const DEFAULT_BRAIN_ROOT = join(process.env.HOME ?? "", "Code/joelhooks/dark-wizard/.brain")

function parsePage(path: string, source: Page["source"]): Page | null {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null
  let frontmatter: Record<string, unknown>
  try {
    frontmatter = (Bun.YAML.parse(match[1]) ?? {}) as Record<string, unknown>
  } catch {
    return null
  }
  const body = match[2].trim()
  const title = stringValue(frontmatter.title) ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path, ".svx")
  const description = firstDescription(body, title)
  const dateValue = stringValue(frontmatter.ended) ?? stringValue(frontmatter.updated_at) ?? stringValue(frontmatter.updatedAt) ?? stringValue(frontmatter.created_at)
  const updatedAt = dateValue ? Date.parse(dateValue) || statSync(path).mtimeMs : statSync(path).mtimeMs
  return {
    path: resolve(path), title, description, body, frontmatter,
    sensitive: frontmatter.privacy === "sensitive",
    source, updatedAt, score: 0,
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (value instanceof Date) return value.toISOString()
  return null
}

function firstDescription(body: string, title: string): string {
  const text = body
    .replace(/^#\s+.*$/gm, "")
    .replace(/^##\s+.*$/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\[[^\]]+\]\([^\)]+\)/g, "$&")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part && part !== title)
  return (text ?? title).slice(0, 240)
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(path))
    else if (entry.isFile() && entry.name.endsWith(".svx")) result.push(path)
  }
  return result
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  return typeof value === "string" ? [value] : []
}

function repoMatch(page: Page, repo: string): number {
  const repoPath = resolve(repo)
  const repoName = basename(repoPath).toLowerCase()
  const declared = values(page.frontmatter.repos).map((value) => value.toLowerCase())
  const haystack = `${page.path}\n${page.title}\n${page.body}`.toLowerCase()
  let score = 0
  if (page.source === "brain" && page.path.startsWith(`${repoPath}/.brain/`)) score += 100
  if (declared.some((value) => value === repoPath.toLowerCase() || value === repoName || repoPath.toLowerCase().includes(value))) score += 80
  if (haystack.includes(repoName)) score += 25
  if (haystack.includes(repoPath.toLowerCase())) score += 40
  return score
}

function observationDate(page: Page): number {
  const value = stringValue(page.frontmatter.ended) ?? stringValue(page.frontmatter.started)
  return value ? Date.parse(value) || page.updatedAt : page.updatedAt
}

function trimLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240)
}

export function buildMemorySkillIndex(options: {
  repo: string
  budget?: number
  observationsDir?: string
  brainRoot?: string
}): MemorySkillIndex {
  const repo = resolve(options.repo)
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`Repository path does not exist: ${repo}`)
  const budget = Math.max(1, options.budget ?? 10)
  const observationsDir = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR
  const brainRoot = options.brainRoot ?? DEFAULT_BRAIN_ROOT
  const allObservationPages = filesUnder(observationsDir)
    .map((path) => parsePage(path, "observation"))
    .filter((page): page is Page => page !== null)
  const observationPages = allObservationPages
    .filter((page) => page.frontmatter.type === "observation" && page.frontmatter.schemaVersion === 1)
    // Reflector-archived originals stay in the substrate but go quiet here; their rollups rank instead.
    .filter((page) => !page.path.includes(`${observationsDir}/archive/`))
  const localBrainPages = filesUnder(join(repo, ".brain"))
    .map((path) => parsePage(path, "brain"))
    .filter((page): page is Page => page !== null)
  const globalBrainPages = filesUnder(brainRoot)
    .filter((path) => !path.startsWith(`${resolve(repo)}/.brain/`))
    .map((path) => parsePage(path, "brain"))
    .filter((page): page is Page => page !== null)

  const pages = [...observationPages, ...localBrainPages, ...globalBrainPages]
    .map((page) => ({ ...page, score: repoMatch(page, repo) }))
    .filter((page) => page.score > 0)
    .sort((a, b) => (b.score - a.score) || (observationDate(b) - observationDate(a)))

  const scopedObservations = observationPages
    .map((page) => ({ ...page, score: repoMatch(page, repo) }))
    .filter((page) => page.score > 0)
    .sort((a, b) => observationDate(b) - observationDate(a))
  // Rollups rank as entries but never narrate the arc — the arc is the newest real session, not the dream that condensed old ones.
  const newest = scopedObservations.find((page) => page.frontmatter.kind !== "rollup" && page.frontmatter.kind !== "dream-receipt") ?? scopedObservations[0]
  const activeArc = newest ? trimLine(newest.title) : null
  const frontier = newest ? (values(newest.frontmatter.frontier)[0] ?? extractSectionLine(newest.body, "Open questions / next actions")) : null
  const sinceLast = newest
    ? `${scopedObservations.length} scoped observation${scopedObservations.length === 1 ? "" : "s"}; latest ${new Date(observationDate(newest)).toISOString()}`
    : "No scoped observations found"
  const dayIndexPage = allObservationPages
    .filter((page) => page.frontmatter.type === "observation-index" && /\d{4}-\d{2}-\d{2}-index$/.test(basename(page.path, ".svx")))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  const entries = pages.slice(0, budget).map((page) => ({
    title: trimLine(page.title),
    description: page.sensitive ? "Sensitive memory. Open the page locally when this work makes it relevant." : trimLine(page.description),
    pointer: page.path,
    sensitive: page.sensitive,
    source: page.source,
    updated_at: Number.isFinite(page.updatedAt) ? new Date(page.updatedAt).toISOString() : null,
  }))
  return {
    repo,
    heading: { active_arc: activeArc, frontier: frontier ? trimLine(frontier) : null, since_last_session: sinceLast },
    day_index: dayIndexPage?.path ?? null,
    entries,
    budget,
    ranking: "recency",
    interest_decay: { status: "reserved", todo: "Add consumption telemetry before applying interest decay to ranking." },
  }
}

function extractSectionLine(body: string, heading: string): string | null {
  const match = body.match(new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |$)`, "im"))
  return match?.[1]?.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).find(Boolean) ?? null
}

export function formatMemorySkillIndexText(index: MemorySkillIndex): string {
  const lines = [
    `# Briefing: ${basename(index.repo)}`,
    `Active arc: ${index.heading.active_arc ?? "none"}`,
    `Frontier: ${index.heading.frontier ?? "none"}`,
    `Since last session: ${index.heading.since_last_session}`,
    "",
    "Memory index:",
  ]
  for (const [position, entry] of index.entries.entries()) {
    lines.push(`${position + 1}. ${entry.title} — ${entry.description}${entry.sensitive ? " [sensitive]" : ""}`)
    lines.push(`   ${entry.pointer}`)
  }
  return lines.join("\n")
}