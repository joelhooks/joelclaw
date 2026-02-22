#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

type RawOutputKind = "Console.log" | "console.log" | "process.stdout.write"

type RawOutputCall = {
  readonly kind: RawOutputKind
  readonly line: number
}

type CommandContractReport = {
  readonly file: string
  readonly usesRespond: boolean
  readonly usesRespondError: boolean
  readonly rawOutputCalls: readonly RawOutputCall[]
}

type CliContractBaseline = {
  readonly version: 1
  readonly scope: "packages/cli/src/commands/*.ts"
  readonly commandFiles: readonly string[]
  readonly envelopeCommandFiles: readonly string[]
  readonly rawOutputCommandFiles: readonly string[]
  readonly rawOutputByFile: Record<string, { count: number; kinds: readonly RawOutputKind[] }>
  readonly unclassifiedCommandFiles: readonly string[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const commandsDir = join(repoRoot, "packages/cli/src/commands")
const baselinePath = join(repoRoot, "docs/agent-contracts/phase1-baseline.json")

const writeMode = process.argv.includes("--write")

function sortedUnique<T extends string>(items: readonly T[]): T[] {
  return Array.from(new Set(items)).sort() as T[]
}

function analyzeCommandFile(filePath: string, relativePath: string): CommandContractReport {
  const sourceText = readFileSync(filePath, "utf8")
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  let usesRespond = false
  let usesRespondError = false
  const rawOutputCalls: RawOutputCall[] = []

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile)

      if (exprText === "respond") usesRespond = true
      if (exprText === "respondError") usesRespondError = true

      if (exprText === "Console.log" || exprText === "console.log") {
        const firstArg = node.arguments[0]
        const wrapsEnvelope =
          firstArg != null
          && ts.isCallExpression(firstArg)
          && ["respond", "respondError"].includes(firstArg.expression.getText(sourceFile))

        if (!wrapsEnvelope) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          rawOutputCalls.push({
            kind: exprText as RawOutputKind,
            line: line + 1,
          })
        }
      }

      if (exprText === "process.stdout.write") {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        rawOutputCalls.push({
          kind: "process.stdout.write",
          line: line + 1,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return {
    file: relativePath,
    usesRespond,
    usesRespondError,
    rawOutputCalls,
  }
}

function buildBaseline(reports: readonly CommandContractReport[]): CliContractBaseline {
  const commandFiles = reports.map((report) => report.file).sort()
  const envelopeCommandFiles = reports
    .filter((report) => report.usesRespond || report.usesRespondError)
    .map((report) => report.file)
    .sort()
  const rawOutputCommandFiles = reports
    .filter((report) => report.rawOutputCalls.length > 0)
    .map((report) => report.file)
    .sort()

  const rawOutputByFile = Object.fromEntries(
    reports
      .filter((report) => report.rawOutputCalls.length > 0)
      .map((report) => [
        report.file,
        {
          count: report.rawOutputCalls.length,
          kinds: sortedUnique(report.rawOutputCalls.map((call) => call.kind)),
        },
      ])
  )

  const unclassifiedCommandFiles = reports
    .filter((report) => !report.usesRespond && !report.usesRespondError && report.rawOutputCalls.length === 0)
    .map((report) => report.file)
    .sort()

  return {
    version: 1,
    scope: "packages/cli/src/commands/*.ts",
    commandFiles,
    envelopeCommandFiles,
    rawOutputCommandFiles,
    rawOutputByFile,
    unclassifiedCommandFiles,
  }
}

function diffList(label: string, expected: readonly string[], actual: readonly string[]): string[] {
  const missing = expected.filter((item) => !actual.includes(item))
  const extra = actual.filter((item) => !expected.includes(item))
  const diffs: string[] = []
  if (missing.length > 0) diffs.push(`${label} missing: ${missing.join(", ")}`)
  if (extra.length > 0) diffs.push(`${label} extra: ${extra.join(", ")}`)
  return diffs
}

function diffRawOutputByFile(
  expected: CliContractBaseline["rawOutputByFile"],
  actual: CliContractBaseline["rawOutputByFile"]
): string[] {
  const diffs: string[] = []
  const files = sortedUnique([...Object.keys(expected), ...Object.keys(actual)])

  for (const file of files) {
    const expectedEntry = expected[file]
    const actualEntry = actual[file]
    if (!expectedEntry || !actualEntry) {
      diffs.push(`rawOutputByFile mismatch for ${file}`)
      continue
    }

    if (expectedEntry.count !== actualEntry.count) {
      diffs.push(`rawOutputByFile count mismatch for ${file}: expected ${expectedEntry.count}, got ${actualEntry.count}`)
    }

    const kindDiffs = diffList(
      `rawOutputByFile kinds for ${file}`,
      expectedEntry.kinds,
      actualEntry.kinds,
    )
    diffs.push(...kindDiffs)
  }

  return diffs
}

function readBaseline(): CliContractBaseline {
  const raw = readFileSync(baselinePath, "utf8")
  return JSON.parse(raw) as CliContractBaseline
}

const commandFiles = readdirSync(commandsDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .sort()

const reports = commandFiles.map((file) =>
  analyzeCommandFile(join(commandsDir, file), `packages/cli/src/commands/${file}`)
)

const generated = buildBaseline(reports)

if (writeMode) {
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, `${JSON.stringify(generated, null, 2)}\n`, "utf8")
  console.log(`Wrote CLI contract baseline: ${baselinePath}`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.error(`Missing baseline file: ${baselinePath}`)
  console.error("Run: bun scripts/validate-cli-contracts.ts --write")
  process.exit(1)
}

const baseline = readBaseline()
const diffs: string[] = []

diffs.push(...diffList("commandFiles", baseline.commandFiles, generated.commandFiles))
diffs.push(...diffList("envelopeCommandFiles", baseline.envelopeCommandFiles, generated.envelopeCommandFiles))
diffs.push(...diffList("rawOutputCommandFiles", baseline.rawOutputCommandFiles, generated.rawOutputCommandFiles))
diffs.push(...diffList("unclassifiedCommandFiles", baseline.unclassifiedCommandFiles, generated.unclassifiedCommandFiles))
diffs.push(...diffRawOutputByFile(baseline.rawOutputByFile, generated.rawOutputByFile))

if (diffs.length > 0) {
  console.error("CLI contract drift detected:")
  for (const diff of diffs) {
    console.error(`- ${diff}`)
  }
  console.error("\nIf this drift is intentional, refresh baseline:")
  console.error("  bun scripts/validate-cli-contracts.ts --write")
  process.exit(1)
}

console.log("CLI contract baseline check passed")
console.log(`Commands scanned: ${generated.commandFiles.length}`)
console.log(`Envelope command files: ${generated.envelopeCommandFiles.length}`)
console.log(`Raw-output command files: ${generated.rawOutputCommandFiles.length}`)
