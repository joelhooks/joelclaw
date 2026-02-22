#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const LEGACY_CLONE_MARKER = "Code/system-bus-worker"

const ALLOWED_PREFIXES = [
  "docs/decisions/",
  "apps/web/content/adrs/",
] as const

const ALLOWED_EXACT = new Set([
  "packages/cli/src/commands/inngest.ts",
  "packages/system-bus/src/serve.ts",
  "packages/system-bus/start.sh",
  "scripts/validate-no-legacy-worker-clone.ts",
])

type Violation = {
  file: string
  lines: number[]
}

function decodeText(value: string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

function listTrackedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.exitCode !== 0) {
    const err = decodeText(proc.stderr).trim()
    throw new Error(err || `git ls-files failed with exit ${proc.exitCode}`)
  }

  return decodeText(proc.stdout)
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function isAllowedPath(file: string): boolean {
  if (ALLOWED_EXACT.has(file)) return true
  return ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))
}

function findMarkerLines(content: string, marker: string): number[] {
  const lines = content.split(/\r?\n/)
  const hits: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.includes(marker)) hits.push(i + 1)
  }
  return hits
}

function scan(): Violation[] {
  const violations: Violation[] = []

  for (const file of listTrackedFiles()) {
    if (isAllowedPath(file)) continue

    const absolutePath = join(repoRoot, file)
    let content = ""
    try {
      content = readFileSync(absolutePath, "utf8")
    } catch {
      continue
    }

    if (!content.includes(LEGACY_CLONE_MARKER)) continue

    const lines = findMarkerLines(content, LEGACY_CLONE_MARKER)
    if (lines.length > 0) {
      violations.push({ file, lines })
    }
  }

  return violations
}

const violations = scan()

if (violations.length > 0) {
  console.error("Legacy worker-clone reference guard failed.")
  console.error(`Found '${LEGACY_CLONE_MARKER}' outside allowed historical/runtime guard paths:`)
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.lines.join(",")}`)
  }
  console.error("\nAllowed paths:")
  for (const prefix of ALLOWED_PREFIXES) {
    console.error(`- ${prefix}*`)
  }
  for (const file of [...ALLOWED_EXACT].sort()) {
    console.error(`- ${file}`)
  }
  process.exit(1)
}

console.log("Legacy worker-clone reference guard passed")
console.log(`Marker: ${LEGACY_CLONE_MARKER}`)
console.log(`Allowed prefixes: ${ALLOWED_PREFIXES.join(", ")}`)
