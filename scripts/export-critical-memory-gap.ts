#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { createInterface } from "node:readline"
import { resolveTypesenseApiKey } from "../packages/cli/src/typesense-auth"

const COLLECTION = "memory_observations"
const DEFAULT_FROM = "2026-06-01T00:00:00.000Z"
const TYPESENSE_URL = (process.env.TYPESENSE_URL || "http://localhost:8108").replace(/\/$/u, "")
const NAS_ROOT = process.env.SELF_HEALING_NAS_HDD_ROOT?.trim() || "/Volumes/three-body"
const DEFAULT_ARCHIVE_ROOT = join(NAS_ROOT, "backups", "typesense", "retired-memory-observations")
const PAGE_SIZE = 100
const MAX_PAGES = 250

type MemoryDocument = Record<string, unknown> & { id: string; timestamp: number }
type BaseArchive = { path: string; count: number; ids: Set<string>; highWater: number }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function utcStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")
}

function archiveRoot(): string {
  const root = resolve(option("--archive-root")?.trim() || DEFAULT_ARCHIVE_ROOT)
  const nas = resolve(NAS_ROOT)
  const insideNas = relative(nas, root)
  if (!insideNas || insideNas.startsWith("..") || isAbsolute(insideNas)) {
    throw new Error(`Archive root must be under ${nas}: ${root}`)
  }
  return root
}

async function latestBase(root: string): Promise<string> {
  if (!existsSync(root)) throw new Error(`Archive root is unavailable: ${root}`)
  const latest = (await readdir(root))
    .filter((name) => /^memory_observations-.*\.jsonl$/u.test(name))
    .sort()
    .at(-1)
  if (!latest) throw new Error(`No base memory_observations archive exists in ${root}`)
  return join(root, latest)
}

async function inspectBase(path: string): Promise<BaseArchive> {
  const ids = new Set<string>()
  let count = 0
  let highWater = 0
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    const document = JSON.parse(line) as Partial<MemoryDocument>
    if (typeof document.id !== "string" || typeof document.timestamp !== "number") {
      throw new Error(`Malformed base archive row ${count + 1} in ${path}`)
    }
    ids.add(document.id)
    highWater = Math.max(highWater, document.timestamp)
    count += 1
  }
  return { path, count, ids, highWater }
}

async function fetchGap(input: {
  apiKey: string
  afterTimestamp: number
}): Promise<{ found: number; documents: MemoryDocument[] }> {
  const documents: MemoryDocument[] = []
  let found = 0
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search`)
    url.searchParams.set("q", "*")
    url.searchParams.set("query_by", "observation")
    url.searchParams.set("filter_by", `timestamp:>${input.afterTimestamp}`)
    url.searchParams.set("sort_by", "timestamp:asc")
    url.searchParams.set("exclude_fields", "embedding")
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetch(url, {
      headers: { "X-TYPESENSE-API-KEY": input.apiKey },
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404) {
      throw new Error(
        `${COLLECTION} does not exist at ${TYPESENSE_URL}. It was archived and dropped on 2026-07-17; no June-onward gap can be exported from this server.`,
      )
    }
    if (!response.ok) {
      throw new Error(`Gap search failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
    }
    const payload = await response.json() as {
      found?: number
      hits?: Array<{ document?: Partial<MemoryDocument> }>
    }
    if (!Number.isInteger(payload.found) || !Array.isArray(payload.hits)) {
      throw new Error("Typesense returned an invalid memory gap search response")
    }
    found = Number(payload.found)
    for (const hit of payload.hits) {
      const document = hit.document
      if (!document || typeof document.id !== "string" || typeof document.timestamp !== "number") {
        throw new Error("Typesense returned a malformed memory observation")
      }
      documents.push(document as MemoryDocument)
    }
    if (documents.length >= found || payload.hits.length === 0) break
  }
  if (documents.length !== found) {
    throw new Error(`Gap search exceeded ${MAX_PAGES} pages: found=${found}, fetched=${documents.length}`)
  }
  return { found, documents }
}

async function appendSnapshot(input: {
  base: BaseArchive
  documents: MemoryDocument[]
  outputPath: string
}): Promise<{ appended: number; duplicates: number; count: number; sha256: string; bytes: number }> {
  const partial = `${input.outputPath}.partial-${process.pid}`
  await copyFile(input.base.path, partial)
  let appended = 0
  let duplicates = 0
  try {
    const handle = await open(partial, "a+")
    try {
      const file = await handle.stat()
      if (file.size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, file.size - 1)
        if (last[0] !== 0x0a) await handle.write("\n")
      }
      for (const document of input.documents) {
        if (input.base.ids.has(document.id)) {
          duplicates += 1
          continue
        }
        await handle.write(`${JSON.stringify(document)}\n`)
        input.base.ids.add(document.id)
        appended += 1
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, input.outputPath)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }

  const hash = createHash("sha256")
  const stream = createReadStream(input.outputPath)
  for await (const chunk of stream) hash.update(chunk)
  const file = await stat(input.outputPath)
  return {
    appended,
    duplicates,
    count: input.base.count + appended,
    sha256: hash.digest("hex"),
    bytes: file.size,
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    console.log("Usage: bun scripts/export-critical-memory-gap.ts [--execute] [--from <ISO>] [--archive-root <path>]")
    console.log("Searches memory_observations read-only and writes a new cumulative archive. Existing snapshots are never changed.")
    return
  }

  const root = archiveRoot()
  const from = option("--from")?.trim() || DEFAULT_FROM
  const fromMs = Date.parse(from)
  if (!Number.isFinite(fromMs)) throw new Error(`Invalid --from timestamp: ${from}`)
  const base = await inspectBase(await latestBase(root))
  const afterTimestamp = Math.max(Math.floor(fromMs / 1_000) - 1, base.highWater)
  const gap = await fetchGap({ apiKey: resolveTypesenseApiKey(), afterTimestamp })
  const novel = gap.documents.filter((document) => !base.ids.has(document.id))
  const plan = {
    ok: true,
    mode: hasFlag("--execute") ? "execute" : "dry-run",
    collection: COLLECTION,
    sourceUrl: TYPESENSE_URL,
    requestedFrom: from,
    searchedAfterTimestamp: afterTimestamp,
    basePath: base.path,
    baseCount: base.count,
    baseHighWaterAt: new Date(base.highWater * 1_000).toISOString(),
    matchedCount: gap.found,
    novelCount: novel.length,
    duplicateCount: gap.found - novel.length,
    archivePolicy: "new cumulative snapshot; existing history remains immutable",
  }
  if (!hasFlag("--execute")) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  if (novel.length === 0) {
    console.log(JSON.stringify({ ...plan, wrote: false, reason: "no novel gap documents" }, null, 2))
    return
  }

  await mkdir(root, { recursive: true, mode: 0o700 })
  const outputPath = join(root, `${COLLECTION}-${utcStamp()}.jsonl`)
  if (basename(outputPath) <= basename(base.path)) {
    throw new Error(`Output snapshot would not sort after its base: ${outputPath}`)
  }
  const result = await appendSnapshot({ base, documents: gap.documents, outputPath })
  const receipt = {
    ...plan,
    wrote: true,
    outputPath,
    ...result,
    highWaterAt: new Date(Math.max(base.highWater, ...novel.map((document) => document.timestamp)) * 1_000).toISOString(),
    exportedAt: new Date().toISOString(),
  }
  const receiptPath = `${outputPath}.receipt.json`
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2))
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
