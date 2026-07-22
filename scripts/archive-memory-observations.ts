#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { resolveTypesenseApiKey } from "../packages/cli/src/typesense-auth"

const COLLECTION = "memory_observations"
const TYPESENSE_URL = (process.env.TYPESENSE_URL || "http://localhost:8108").replace(/\/$/u, "")
const NAS_HDD_ROOT = process.env.SELF_HEALING_NAS_HDD_ROOT?.trim() || "/Volumes/three-body"
const DEFAULT_ARCHIVE_ROOT = join(NAS_HDD_ROOT, "backups", "typesense", "retired-memory-observations")

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function option(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function utcStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")
}

function dropCommand(): string {
  return `key="$(secrets lease typesense_api_key)" && curl -fS -X DELETE '${TYPESENSE_URL}/collections/${COLLECTION}' -H "X-TYPESENSE-API-KEY: $key"`
}

function headers(apiKey: string): Record<string, string> {
  return { "X-TYPESENSE-API-KEY": apiKey }
}

async function collectionCount(apiKey: string): Promise<number> {
  const response = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}`, { headers: headers(apiKey) })
  if (!response.ok) {
    throw new Error(`Collection lookup failed (${response.status}): ${await response.text()}`)
  }
  const schema = await response.json() as { num_documents?: number }
  if (!Number.isInteger(schema.num_documents) || Number(schema.num_documents) < 0) {
    throw new Error(`Collection ${COLLECTION} returned an invalid document count`)
  }
  return Number(schema.num_documents)
}

async function exportCollection(apiKey: string, outputPath: string, expectedCount: number): Promise<{ bytes: number; documentCount: number; sha256: string }> {
  const response = await fetch(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/export`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(60 * 60 * 1_000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Collection export failed (${response.status}): ${await response.text()}`)
  }

  const hash = createHash("sha256")
  let newlineCount = 0
  let lastByte: number | undefined
  let bytes = 0
  const source = Readable.fromWeb(response.body as never)
  source.on("data", (chunk: Buffer) => {
    hash.update(chunk)
    bytes += chunk.length
    for (const byte of chunk) if (byte === 0x0a) newlineCount += 1
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1]
  })
  await pipeline(source, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }))

  const documentCount = newlineCount + (bytes > 0 && lastByte !== 0x0a ? 1 : 0)
  if (documentCount !== expectedCount) {
    throw new Error(`Export count mismatch: schema=${expectedCount}, exported=${documentCount}`)
  }
  return { bytes, documentCount, sha256: hash.digest("hex") }
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    console.log("Usage: bun scripts/archive-memory-observations.ts [--execute] [--archive-root <path>]")
    console.log("Dry-run is the default. --execute writes the JSONL snapshot and receipt; it never drops the collection.")
    return
  }

  const execute = hasFlag("--execute")
  const nasRoot = resolve(NAS_HDD_ROOT)
  const archiveRoot = resolve(option("--archive-root")?.trim() || DEFAULT_ARCHIVE_ROOT)
  const archiveRelativeToNas = relative(nasRoot, archiveRoot)
  if (!archiveRelativeToNas || archiveRelativeToNas.startsWith("..") || isAbsolute(archiveRelativeToNas)) {
    throw new Error(`Archive root must be a directory under the NAS root (${nasRoot}): ${archiveRoot}`)
  }
  const apiKey = resolveTypesenseApiKey()
  const documentCount = await collectionCount(apiKey)
  const stamp = utcStamp()
  const snapshotPath = join(archiveRoot, `${COLLECTION}-${stamp}.jsonl`)
  const receiptPath = `${snapshotPath}.receipt.json`
  const plan = {
    ok: true,
    mode: execute ? "execute" : "dry-run",
    collection: COLLECTION,
    sourceUrl: TYPESENSE_URL,
    documentCount,
    archiveRoot,
    snapshotPath,
    receiptPath,
    nasRootAvailable: existsSync(NAS_HDD_ROOT),
    executeCommand: "bun scripts/archive-memory-observations.ts --execute",
    dropCommand: dropCommand(),
    note: "The archive tool never drops the collection. Run the printed curl only after verifying the receipt.",
  }

  if (!execute) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  if (!existsSync(NAS_HDD_ROOT)) {
    throw new Error(`NAS root is unavailable: ${NAS_HDD_ROOT}`)
  }

  await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
  const temporarySnapshot = `${snapshotPath}.partial-${process.pid}`
  const temporaryReceipt = `${receiptPath}.partial-${process.pid}`
  try {
    const exported = await exportCollection(apiKey, temporarySnapshot, documentCount)
    const file = await stat(temporarySnapshot)
    if (file.size !== exported.bytes || file.size === 0) {
      throw new Error(`Snapshot size verification failed: streamed=${exported.bytes}, file=${file.size}`)
    }
    await rename(temporarySnapshot, snapshotPath)

    const receipt = {
      ...plan,
      archivedAt: new Date().toISOString(),
      bytes: exported.bytes,
      sha256: exported.sha256,
      verified: exported.documentCount === documentCount && file.size === exported.bytes,
    }
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryReceipt, receiptPath)
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    for (const path of [temporarySnapshot, temporaryReceipt]) {
      await unlink(path).catch(() => undefined)
    }
    throw error
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
