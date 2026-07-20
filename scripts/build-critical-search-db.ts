#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { buildCriticalDb, DEFAULT_CRITICAL_DB_PATH } from "../packages/cli/src/lib/critical-search"
import { resolveTypesenseApiKey } from "../packages/cli/src/typesense-auth"

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    console.log("Usage: bun scripts/build-critical-search-db.ts [--db <path>] [--memory-archive <jsonl>] [--skip-typesense] [--allow-degraded-sources]")
    console.log("Builds an atomic SQLite FTS5 critical projection. Only flagg may write the production database.")
    return
  }

  const dbPath = resolve(option("--db")?.trim() || process.env.JOELCLAW_CRITICAL_DB || DEFAULT_CRITICAL_DB_PATH)
  const archive = option("--memory-archive")?.trim()
  if (archive && !existsSync(archive)) throw new Error(`Memory archive not found: ${archive}`)

  let apiKey: string | undefined
  let keyStatus = "skipped"
  if (!hasFlag("--skip-typesense")) {
    try {
      apiKey = resolveTypesenseApiKey()
      keyStatus = "leased"
    } catch (error) {
      keyStatus = `unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const result = await buildCriticalDb({
    dbPath,
    typesenseApiKey: apiKey,
    memoryArchivePath: archive,
    allowDegradedSources: hasFlag("--allow-degraded-sources"),
  })

  console.log(JSON.stringify({
    ok: true,
    ...result,
    typesenseCredential: keyStatus,
    note: "The builder uses read-only Typesense exports, an exclusive lock, required-source gates, and atomic replacement after SQLite integrity_check passes.",
  }, null, 2))
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
