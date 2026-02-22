#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

type InferCallsite = {
  file: string
  line: number
  hasLangfuseTraceImport: boolean
  hasFunctionTraceCall: boolean
  nearbyTraceLine?: number
}

const NEARBY_WINDOW_LINES = 160

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const scanRoot = join(repoRoot, "packages/system-bus/src")

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath))
      continue
    }

    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".test.ts")) continue
    files.push(fullPath)
  }

  return files
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function isStepAiInferCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== "infer") return false

  const aiExpr = node.expression.expression
  if (!ts.isPropertyAccessExpression(aiExpr)) return false
  if (aiExpr.name.text !== "ai") return false

  return ts.isIdentifier(aiExpr.expression) && aiExpr.expression.text === "step"
}

function findEnclosingFunction(node: ts.Node): ts.FunctionLikeDeclarationBase | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isArrowFunction(current)
      || ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isMethodDeclaration(current)) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function collectTraceImportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue

    const moduleName = ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : ""

    if (!moduleName.includes("lib/langfuse")) continue

    const namedBindings = stmt.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName !== "traceLlmGeneration") continue
      names.add(element.name.text)
    }
  }

  return names
}

function collectInferCallsites(filePath: string): InferCallsite[] {
  const sourceText = readFileSync(filePath, "utf8")
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const traceImportNames = collectTraceImportNames(sourceFile)
  const hasLangfuseTraceImport = traceImportNames.size > 0

  const inferNodes: ts.CallExpression[] = []

  const visitForInfer = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isStepAiInferCall(node)) {
      inferNodes.push(node)
    }
    ts.forEachChild(node, visitForInfer)
  }

  visitForInfer(sourceFile)

  if (inferNodes.length === 0) return []

  const traceLineCache = new Map<number, number[]>()

  const isTraceCall = (node: ts.CallExpression): boolean => {
    if (ts.isIdentifier(node.expression)) {
      return traceImportNames.has(node.expression.text)
    }
    return false
  }

  const getTraceLinesInFunction = (fn: ts.FunctionLikeDeclarationBase): number[] => {
    const key = fn.pos
    const cached = traceLineCache.get(key)
    if (cached) return cached

    const lines: number[] = []
    const visitFn = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isTraceCall(node)) {
        lines.push(getLine(sourceFile, node))
      }
      ts.forEachChild(node, visitFn)
    }

    if (fn.body) visitFn(fn.body)
    traceLineCache.set(key, lines)
    return lines
  }

  return inferNodes.map((inferNode) => {
    const line = getLine(sourceFile, inferNode)
    const fn = findEnclosingFunction(inferNode)
    const traceLines = fn ? getTraceLinesInFunction(fn) : []

    let nearbyTraceLine: number | undefined
    let bestDistance = Number.POSITIVE_INFINITY

    for (const traceLine of traceLines) {
      const distance = Math.abs(traceLine - line)
      if (distance <= NEARBY_WINDOW_LINES && distance < bestDistance) {
        nearbyTraceLine = traceLine
        bestDistance = distance
      }
    }

    return {
      file: relative(repoRoot, filePath),
      line,
      hasLangfuseTraceImport,
      hasFunctionTraceCall: traceLines.length > 0,
      nearbyTraceLine,
    }
  })
}

const files = listTypeScriptFiles(scanRoot)
const inferCallsites = files.flatMap((file) => collectInferCallsites(file))

if (inferCallsites.length === 0) {
  console.log("No step.ai.infer callsites found under packages/system-bus/src")
  process.exit(0)
}

const violations: string[] = []

for (const callsite of inferCallsites) {
  const location = `${callsite.file}:${callsite.line}`

  if (!callsite.hasLangfuseTraceImport) {
    violations.push(`${location} missing import for traceLlmGeneration from lib/langfuse`)
    continue
  }

  if (!callsite.hasFunctionTraceCall) {
    violations.push(`${location} has no traceLlmGeneration call in the enclosing function`)
    continue
  }

  if (callsite.nearbyTraceLine == null) {
    violations.push(`${location} has no nearby traceLlmGeneration call within ±${NEARBY_WINDOW_LINES} lines`)
  }
}

if (violations.length > 0) {
  console.error("LLM observability guard failed for step.ai.infer callsites:")
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

console.log("LLM observability guard passed")
console.log(`Infer callsites scanned: ${inferCallsites.length}`)
for (const callsite of inferCallsites) {
  console.log(`- ${callsite.file}:${callsite.line} -> trace at line ${callsite.nearbyTraceLine}`)
}
