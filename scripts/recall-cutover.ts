#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parse as parseToml } from "toml"
import {
  FLOWING_RELEASE_MANIFEST_FILENAME,
  PINNED_MEMORY_COMMIT,
  PINNED_READ_ARTIFACT_SHA256,
  verifyReleaseArtifact,
} from "../packages/cli/src/recall/release-manifest"
import {
  createComposedRecallRequest,
  parseComposedRecallEnvelope,
} from "../packages/recall/src/index"

const FLOWING_ADAPTER = "flowing-memory-recall"
const ROLLBACK_ADAPTER = "typesense-recall"
const SECRET_NAME = "flowing-runtime-url"

type Mode = "cutover" | "rollback"

type VerifiedRelease = {
  readonly artifactPath: string
  readonly digest: string
}

export type RecallCutoverInput = {
  readonly mode: Mode
  readonly dryRun: boolean
  readonly configPath?: string
  readonly binaryPath?: string
  readonly candidateBinaryPath?: string
  readonly candidateBinarySha256?: string
  readonly releaseRoot?: string
  readonly receiptPath?: string
  readonly rollbackRoot?: string
  readonly verifiedRelease?: VerifiedRelease
  readonly now?: Date
}

export type RecallCutoverResult = {
  readonly schemaVersion: 1
  readonly action: Mode
  readonly dryRun: boolean
  readonly previousAdapter: string
  readonly nextAdapter: string
  readonly previousBinaryDigest: string
  readonly installedBinaryDigest: string
  readonly releaseDigest?: string
  readonly memoryCommit?: string
  readonly configBeforeDigest: string
  readonly configAfterDigest: string
  readonly wroteConfig: boolean
  readonly wroteReceipt: boolean
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function assertValidToml(text: string): void {
  try {
    parseToml(text)
  } catch {
    throw new Error("config TOML is malformed")
  }
}

type TomlTable = {
  readonly header: string
  readonly start: number
  readonly end: number
  readonly array: boolean
}

function tomlLines(text: string): { lines: string[]; newline: string; hadFinalNewline: boolean } {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  return {
    lines: text.length === 0 ? [] : text.split(/\r?\n/u),
    newline,
    hadFinalNewline: text.endsWith("\n"),
  }
}

function findTomlTables(lines: readonly string[]): TomlTable[] {
  const starts: Array<{ header: string; start: number; array: boolean }> = []
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("[")) continue
    const table = trimmed.match(/^\[([A-Za-z0-9_.-]+)\](?:\s*#.*)?$/u)
    const arrayTable = trimmed.match(/^\[\[([A-Za-z0-9_.-]+)\]\](?:\s*#.*)?$/u)
    if (!table && !arrayTable) throw new Error("config TOML has a malformed table header")
    const header = table?.[1] ?? arrayTable?.[1]
    if (header) starts.push({ header, start: index, array: Boolean(arrayTable) })
  }
  const tables = starts.map((table, index) => ({
    ...table,
    end: starts[index + 1]?.start ?? lines.length,
  }))
  const seen = new Set<string>()
  for (const table of tables) {
    if (table.array) continue
    if (seen.has(table.header)) throw new Error("config TOML has a duplicate table")
    seen.add(table.header)
  }
  return tables
}

function replaceTomlTableKeys(
  text: string,
  header: string,
  values: Readonly<Record<string, string | boolean>>,
): string {
  const layout = tomlLines(text)
  const tables = findTomlTables(layout.lines)
  const table = tables.find((entry) => !entry.array && entry.header === header)
  const renderedValues = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "boolean" ? String(value) : tomlString(value),
    ]),
  )

  if (!table) {
    const prefix =
      text.length === 0 ? "" : text.endsWith("\n") ? layout.newline : layout.newline.repeat(2)
    const body = Object.entries(renderedValues).map(([key, value]) => `${key} = ${value}`)
    return `${text}${prefix}[${header}]${layout.newline}${body.join(layout.newline)}${layout.newline}`
  }

  const lines = [...layout.lines]
  const found = new Set<string>()
  for (let index = table.start + 1; index < table.end; index += 1) {
    const line = lines[index] ?? ""
    for (const [key, value] of Object.entries(renderedValues)) {
      if (!new RegExp(`^\\s*${key}\\s*=`, "u").test(line)) continue
      if (found.has(key)) throw new Error("config TOML has a duplicate recall key")
      const match = line.match(
        new RegExp(
          `^(\\s*${key}\\s*=\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^#]*?)(\\s*(?:#.*)?)$`,
          "u",
        ),
      )
      if (!match) throw new Error("config TOML has a malformed recall value")
      lines[index] = `${match[1]}${value}${match[2]}`
      found.add(key)
    }
  }
  const missing = Object.entries(renderedValues)
    .filter(([key]) => !found.has(key))
    .map(([key, value]) => `${key} = ${value}`)
  lines.splice(table.end, 0, ...missing)
  const rendered = lines.join(layout.newline)
  return layout.hadFinalNewline && !rendered.endsWith(layout.newline)
    ? `${rendered}${layout.newline}`
    : rendered
}

function currentRecallAdapter(text: string): string {
  assertValidToml(text)
  const layout = tomlLines(text)
  const table = findTomlTables(layout.lines).find(
    (entry) => !entry.array && entry.header === "capabilities.recall",
  )
  if (!table) return ROLLBACK_ADAPTER
  let adapter: string | undefined
  for (let index = table.start + 1; index < table.end; index += 1) {
    const line = layout.lines[index] ?? ""
    if (!/^\s*adapter\s*=/u.test(line)) continue
    if (adapter) throw new Error("config TOML has a duplicate recall adapter")
    const match = line.match(/^\s*adapter\s*=\s*["']([^"']+)["'](?:\s*#.*)?$/u)
    if (!match?.[1]) throw new Error("config TOML has a malformed recall adapter")
    adapter = match[1].trim()
  }
  return adapter ?? ROLLBACK_ADAPTER
}

export function updateRecallConfig(input: {
  readonly current: string
  readonly adapter: string
  readonly readExecutable?: string
}): string {
  assertValidToml(input.current)
  let updated = replaceTomlTableKeys(input.current, "capabilities.recall", {
    enabled: true,
    adapter: input.adapter,
  })
  if (input.readExecutable) {
    updated = replaceTomlTableKeys(updated, "capabilities.recall.adapters.flowing-memory-recall", {
      read_executable: input.readExecutable,
      credential_secret_name: SECRET_NAME,
      credential_format: "raw",
    })
  }
  return updated
}

function atomicWrite(path: string, body: string | Buffer, mode: number): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temp = join(parent, `.${basename(path)}.${process.pid}.tmp`)
  const fd = openSync(temp, "wx", mode)
  try {
    writeFileSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  chmodSync(path, mode)
}

function atomicPrivateWrite(path: string, body: string): void {
  const parent = dirname(path)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentStat = statSync(parent)
  const currentUid = process.getuid?.()
  if (
    (parentStat.mode & 0o022) !== 0 ||
    (currentUid !== undefined && parentStat.uid !== currentUid)
  ) {
    throw new Error("private output parent must be owner-owned and not writable by group or other")
  }
  atomicWrite(path, body, 0o600)
}

function verifyCandidateBinary(path: string, expectedSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("candidate CLI needs a full lowercase --candidate-sha256")
  }
  const before = sha256(readFileSync(path))
  if (before !== expectedSha256) {
    throw new Error("candidate CLI does not match --candidate-sha256")
  }

  const probeHome = mkdtempSync(join(tmpdir(), "recall-candidate-probe-"))
  const request = createComposedRecallRequest({
    query: "candidate private stdin probe",
    scope: { project: "joelhooks.joelclaw", workstream: "cutover-probe" },
    access: {
      principalRef: "service:recall-cutover-probe",
      purpose: "candidate-verification",
      allowedPrivacy: ["public"],
    },
    decidedAt: "2026-08-23T00:00:00.000Z",
    limits: { curated: 1, observations: 1, reflections: 1 },
  })
  try {
    const probe = spawnSync(path, ["recall", "--request-file", "-"], {
      encoding: "utf8",
      timeout: 10_000,
      input: JSON.stringify(request),
      env: {
        HOME: probeHome,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        JOELCLAW_CRITICAL_DB: join(probeHome, "missing-critical.db"),
        JOELCLAW_RECALL_OTEL: "0",
      },
    })
    let envelope: unknown
    try {
      envelope = JSON.parse(probe.stdout)
      const parsed = parseComposedRecallEnvelope(envelope)
      const adapter = (envelope as { result?: { adapter?: unknown } }).result?.adapter
      if (
        probe.status !== 3 ||
        parsed.ok ||
        parsed.unavailable.length === 0 ||
        adapter !== FLOWING_ADAPTER
      ) {
        throw new Error("candidate probe contract mismatch")
      }
    } catch {
      throw new Error("candidate CLI failed the private composed recall probe")
    }
  } finally {
    rmSync(probeHome, { recursive: true, force: true })
  }

  const after = sha256(readFileSync(path))
  if (after !== before) throw new Error("candidate CLI changed during verification")
  return after
}

type CutoverJournal = {
  readonly previousBinaryDigest: string
  readonly state: "prepared" | "active" | "rolled-back"
}

function readCutoverReceipt(path: string): CutoverJournal {
  let parsed: { previousBinaryDigest?: unknown; state?: unknown }
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed
  } catch {
    throw new Error("cutover journal is malformed")
  }
  if (
    typeof parsed.previousBinaryDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.previousBinaryDigest)
  ) {
    throw new Error("cutover receipt has no valid previous binary digest")
  }
  if (parsed.state !== "prepared" && parsed.state !== "active" && parsed.state !== "rolled-back") {
    throw new Error("cutover receipt has no valid state")
  }
  return { previousBinaryDigest: parsed.previousBinaryDigest, state: parsed.state }
}

function discoverVerifiedRelease(releaseRoot: string): VerifiedRelease {
  const resolvedRoot = realpathSync(releaseRoot)
  const matches: VerifiedRelease[] = []
  for (const releaseName of readdirSync(resolvedRoot).sort()) {
    const releaseDir = join(resolvedRoot, releaseName)
    const manifestPath = join(releaseDir, FLOWING_RELEASE_MANIFEST_FILENAME)
    if (!existsSync(manifestPath)) continue
    let manifest: { artifacts?: Array<{ path?: unknown; kind?: unknown }> }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch {
      continue
    }
    for (const artifact of manifest.artifacts ?? []) {
      if (artifact.kind !== "standalone" || typeof artifact.path !== "string") continue
      const artifactPath = realpathSync(join(releaseDir, artifact.path))
      const verified = verifyReleaseArtifact({
        resolvedRoot,
        resolvedArtifact: artifactPath,
      })
      if (verified.ok) matches.push({ artifactPath, digest: verified.binding.sha256 })
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one pinned standalone flowing recall release; found ${matches.length}`,
    )
  }
  return matches[0]!
}

export function runRecallCutover(input: RecallCutoverInput): RecallCutoverResult {
  const home = homedir()
  const configPath = input.configPath ?? join(home, ".joelclaw", "config.toml")
  const binaryPath = input.binaryPath ?? join(home, ".bun", "bin", "joelclaw")
  const receiptPath =
    input.receiptPath ?? join(home, ".joelclaw", "receipts", "recall-cutover", "latest.json")
  const rollbackRoot = input.rollbackRoot ?? join(home, ".joelclaw", "rollback")
  const existingJournal = existsSync(receiptPath) ? readCutoverReceipt(receiptPath) : undefined
  if (
    input.mode === "cutover" &&
    existingJournal &&
    (existingJournal.state === "prepared" || existingJournal.state === "active")
  ) {
    throw new Error(
      "an active recall cutover journal already exists; rollback before cutting over again",
    )
  }
  if (input.mode === "rollback" && (!existingJournal || existingJournal.state === "rolled-back")) {
    throw new Error("no active recall cutover journal is available for rollback")
  }
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  const previousAdapter = currentRecallAdapter(current)
  const binaryBefore = readFileSync(binaryPath)
  const previousBinaryDigest = sha256(binaryBefore)

  const release =
    input.mode === "cutover"
      ? (input.verifiedRelease ??
        discoverVerifiedRelease(
          input.releaseRoot ?? join(home, ".joelclaw", "flowing-memory", "releases"),
        ))
      : undefined
  if (release && release.digest !== PINNED_READ_ARTIFACT_SHA256) {
    throw new Error("verified release digest does not match the consumer pin")
  }

  let binaryAfter = binaryBefore
  let backupPath: string | undefined
  if (input.mode === "cutover") {
    if (!input.candidateBinaryPath) {
      throw new Error("cutover requires --candidate-binary")
    }
    const candidateDigest = verifyCandidateBinary(
      input.candidateBinaryPath,
      input.candidateBinarySha256 ?? "",
    )
    binaryAfter = readFileSync(input.candidateBinaryPath)
    if (sha256(binaryAfter) !== candidateDigest) {
      throw new Error("candidate CLI changed after verification")
    }
    backupPath = join(rollbackRoot, `joelclaw-${previousBinaryDigest}`)
  } else {
    if (!existingJournal)
      throw new Error("no active recall cutover journal is available for rollback")
    backupPath = join(rollbackRoot, `joelclaw-${existingJournal.previousBinaryDigest}`)
    binaryAfter = readFileSync(backupPath)
    if (sha256(binaryAfter) !== existingJournal.previousBinaryDigest) {
      throw new Error("rollback binary does not match the recorded previous digest")
    }
  }

  const nextAdapter = input.mode === "cutover" ? FLOWING_ADAPTER : ROLLBACK_ADAPTER
  const next = updateRecallConfig({
    current,
    adapter: nextAdapter,
    ...(release ? { readExecutable: release.artifactPath } : {}),
  })
  const installedBinaryDigest = sha256(binaryAfter)
  const result: RecallCutoverResult = {
    schemaVersion: 1,
    action: input.mode,
    dryRun: input.dryRun,
    previousAdapter,
    nextAdapter,
    previousBinaryDigest,
    installedBinaryDigest,
    ...(release ? { releaseDigest: release.digest, memoryCommit: PINNED_MEMORY_COMMIT } : {}),
    configBeforeDigest: sha256(current),
    configAfterDigest: sha256(next),
    wroteConfig: !input.dryRun,
    wroteReceipt: !input.dryRun,
  }

  if (!input.dryRun) {
    if (input.mode === "cutover") {
      if (!backupPath) throw new Error("rollback path was not resolved")
      if (existsSync(backupPath)) {
        if (sha256(readFileSync(backupPath)) !== previousBinaryDigest) {
          throw new Error("existing rollback binary does not match the current production binary")
        }
      } else {
        atomicWrite(backupPath, binaryBefore, 0o700)
      }
      // The prepared journal is durable before any production switch. A failed
      // final config write still leaves rollback with the previous digest.
      atomicPrivateWrite(
        receiptPath,
        `${JSON.stringify(
          {
            ...result,
            state: "prepared",
            recordedAt: (input.now ?? new Date()).toISOString(),
          },
          null,
          2,
        )}\n`,
      )
      // Pin the old adapter before installing a binary whose source default is
      // flowing. If installation stops here, production remains on rollback.
      atomicPrivateWrite(
        configPath,
        updateRecallConfig({
          current,
          adapter: ROLLBACK_ADAPTER,
          ...(release ? { readExecutable: release.artifactPath } : {}),
        }),
      )
    } else {
      // Flip the adapter first. Both binaries understand typesense-recall.
      atomicPrivateWrite(configPath, next)
    }

    atomicWrite(binaryPath, binaryAfter, 0o700)
    if (sha256(readFileSync(binaryPath)) !== installedBinaryDigest) {
      throw new Error("installed CLI digest did not match the verified candidate")
    }
    if (input.mode === "cutover") atomicPrivateWrite(configPath, next)

    atomicPrivateWrite(
      receiptPath,
      `${JSON.stringify(
        {
          ...result,
          state: input.mode === "cutover" ? "active" : "rolled-back",
          recordedAt: (input.now ?? new Date()).toISOString(),
        },
        null,
        2,
      )}\n`,
    )
  }
  return result
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args[0]
  if (mode !== "cutover" && mode !== "rollback") {
    console.error(
      "usage: bun scripts/recall-cutover.ts <cutover|rollback> <--dry-run|--apply> [--candidate-binary <path>]",
    )
    process.exitCode = 1
    return
  }
  const dryRun = args.includes("--dry-run")
  const apply = args.includes("--apply")
  if (dryRun === apply) {
    console.error("choose exactly one of --dry-run or --apply")
    process.exitCode = 1
    return
  }

  try {
    const result = runRecallCutover({
      mode,
      dryRun,
      ...(flagValue(args, "--config") ? { configPath: flagValue(args, "--config") } : {}),
      ...(flagValue(args, "--binary") ? { binaryPath: flagValue(args, "--binary") } : {}),
      ...(flagValue(args, "--candidate-binary")
        ? { candidateBinaryPath: flagValue(args, "--candidate-binary") }
        : {}),
      ...(flagValue(args, "--candidate-sha256")
        ? { candidateBinarySha256: flagValue(args, "--candidate-sha256") }
        : {}),
      ...(flagValue(args, "--release-root")
        ? { releaseRoot: flagValue(args, "--release-root") }
        : {}),
      ...(flagValue(args, "--receipt") ? { receiptPath: flagValue(args, "--receipt") } : {}),
      ...(flagValue(args, "--rollback-root")
        ? { rollbackRoot: flagValue(args, "--rollback-root") }
        : {}),
    })
    // Content-free receipt. No config, executable, binary, or endpoint path is printed.
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "recall cutover failed")
    process.exitCode = 1
  }
}

if (import.meta.main) main()
