#!/usr/bin/env bun

import { resolve } from "node:path"
import {
  selectCriticalMemoryArchive,
  verifyCriticalMemoryArchive,
} from "../packages/cli/src/lib/critical-memory-archive"
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
    console.log("Usage: bun scripts/build-critical-search-db.ts [--db <path>] [--memory-archive <jsonl>] [--memory-archive-sha256 <hex>] [--skip-typesense] [--allow-degraded-sources]")
    console.log("Builds an atomic SQLite FTS5 critical projection. Only flagg may write the production database.")
    return
  }

  const dbPath = resolve(option("--db")?.trim() || process.env.JOELCLAW_CRITICAL_DB || DEFAULT_CRITICAL_DB_PATH)
  const archive = await verifyCriticalMemoryArchive(
    selectCriticalMemoryArchive({
      cliPath: option("--memory-archive"),
      cliSha256: option("--memory-archive-sha256"),
    }),
  )

  const skipTypesense =
    hasFlag("--skip-typesense") ||
    ["1", "true", "yes"].includes(
      (process.env.JOELCLAW_CRITICAL_DB_SKIP_TYPESENSE ?? "").trim().toLowerCase(),
    )
  let apiKey: string | undefined
  let keyStatus = "skipped"
  if (!skipTypesense) {
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
    memoryArchivePath: archive.path,
    memoryArchiveSha256: archive.actualSha256,
    allowDegradedSources: hasFlag("--allow-degraded-sources"),
  })

  console.log(JSON.stringify({
    ok: true,
    ...result,
    typesenseCredential: keyStatus,
    memoryArchive: {
      filename: archive.filename,
      bytes: archive.bytes,
      sha256: archive.actualSha256,
      verification: archive.verification,
      source: archive.source,
    },
    note: "The builder uses read-only Typesense exports, a verified memory archive, an exclusive lock, required-source gates, and atomic replacement after SQLite integrity_check passes.",
  }, null, 2))
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
