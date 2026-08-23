import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseMinimalToml } from "../packages/cli/src/capabilities/config"
import { resolveFlowingRecallPortConfig } from "../packages/cli/src/recall/flowing-port"
import { PINNED_READ_ARTIFACT_SHA256 } from "../packages/cli/src/recall/release-manifest"
import { testRelease } from "../packages/cli/src/recall/test-fixtures"
import { runRecallCutover, updateRecallConfig } from "./recall-cutover"

function candidateSource(): string {
  return `#!${process.execPath}
if (process.env.CUTOVER_TEST_SECRET) process.exit(9)
const request = JSON.parse(await Bun.stdin.text())
const lane = (name, source, code) => ({
  _tag: "RecallLaneUnavailableV1",
  lane: name,
  source,
  code,
  message: "candidate probe unavailable",
})
const unavailable = [
  lane("flowing-reflections", "flowing-memory-read-v1", "not-configured"),
  lane("flowing-observations", "flowing-memory-read-v1", "not-configured"),
  lane("curated-pages", "critical-db-curated", "store-unavailable"),
]
console.log(JSON.stringify({
  ok: false,
  command: "joelclaw recall",
  result: {
    adapter: "flowing-memory-recall",
    composed: {
      _tag: "ComposedRecallResultV1",
      schemaVersion: 1,
      request,
      resolvedScope: request.scope,
      resolvedAccess: request.access,
      lanes: {
        flowingReflections: unavailable[0],
        flowingObservations: unavailable[1],
        curatedPages: unavailable[2],
      },
      unavailable,
    },
  },
  next_actions: [],
}))
process.exit(3)
`
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-cutover-"))
  const configPath = join(root, "config.toml")
  const binaryPath = join(root, "joelclaw")
  const receiptPath = join(root, "receipt.json")
  const rollbackRoot = join(root, "rollback")
  const artifactPath = join(root, "flowing-memory-read")
  const candidateBinaryPath = join(root, "candidate-joelclaw")
  writeFileSync(binaryPath, "installed binary fixture")
  writeFileSync(candidateBinaryPath, candidateSource())
  chmodSync(candidateBinaryPath, 0o700)
  const candidateBinarySha256 = createHash("sha256")
    .update(readFileSync(candidateBinaryPath))
    .digest("hex")
  writeFileSync(artifactPath, "release fixture")
  writeFileSync(
    configPath,
    [
      "# preserve top comment",
      "[capabilities.otel] # preserve section comment",
      'adapter = "clickhouse-otel"',
      "",
      "[capabilities.recall]",
      "# preserve recall comment",
      'adapter = "typesense-recall" # preserve inline comment',
      "custom_timeout_ms = 4321",
      "",
      "[[unrelated.items]]",
      'name = "preserve-array-table"',
      "",
    ].join("\n"),
  )
  return {
    root,
    configPath,
    binaryPath,
    receiptPath,
    rollbackRoot,
    artifactPath,
    candidateBinaryPath,
    candidateBinarySha256,
  }
}

const verifiedRelease = (artifactPath: string) => ({
  artifactPath,
  digest: PINNED_READ_ARTIFACT_SHA256,
})

describe("recall cutover config", () => {
  test("updates only recall keys while preserving comments and unrelated TOML", () => {
    const paths = fixture()
    const before = readFileSync(paths.configPath, "utf8")
    const updated = updateRecallConfig({
      current: before,
      adapter: "flowing-memory-recall",
      readExecutable: "/private/release/read",
    })
    expect(updated).toContain("# preserve top comment")
    expect(updated).toContain("[capabilities.otel] # preserve section comment")
    expect(updated).toContain("# preserve recall comment")
    expect(updated).toContain("custom_timeout_ms = 4321")
    expect(updated).toContain('[[unrelated.items]]\nname = "preserve-array-table"')
    expect(updated).toContain('adapter = "flowing-memory-recall" # preserve inline comment')
    expect(updated).toContain('read_executable = "/private/release/read"')
    expect(updated).toContain('credential_format = "raw"')
    const parsed = parseMinimalToml(updated) as {
      capabilities?: { recall?: { enabled?: unknown; custom_timeout_ms?: unknown } }
    }
    expect(parsed.capabilities?.recall?.enabled).toBe(true)
    expect(parsed.capabilities?.recall?.custom_timeout_ms).toBe(4321)
  })

  test("refuses malformed or duplicate TOML instead of reformatting it", () => {
    expect(() =>
      updateRecallConfig({
        current: '[capabilities.recall\nadapter = "typesense-recall"\n',
        adapter: "flowing-memory-recall",
      }),
    ).toThrow("config TOML is malformed")
    expect(() =>
      updateRecallConfig({
        current:
          '[capabilities.recall]\nadapter = "typesense-recall"\n[capabilities.recall]\nadapter = "flowing-memory-recall"\n',
        adapter: "flowing-memory-recall",
      }),
    ).toThrow("config TOML is malformed")
    expect(() =>
      updateRecallConfig({
        current: '[unrelated]\nvalue = ["unterminated"\n',
        adapter: "flowing-memory-recall",
      }),
    ).toThrow("config TOML is malformed")
  })

  test("generated flowing settings satisfy the production port", () => {
    const release = testRelease()
    const updated = updateRecallConfig({
      current: "",
      adapter: "flowing-memory-recall",
      readExecutable: release.executable,
    })
    const parsed = parseMinimalToml(updated) as {
      capabilities?: { recall?: { adapters?: Record<string, Record<string, unknown>> } }
    }
    const settings = parsed.capabilities?.recall?.adapters?.["flowing-memory-recall"]
    const resolved = resolveFlowingRecallPortConfig({
      settings,
      trustedReleaseRoot: release.root,
      expectedArtifactSha256: release.sha256,
    })
    expect(resolved.ok).toBe(true)
  })

  test("dry run verifies private stdin, flowing adapter, and exit 3 without writes", () => {
    const paths = fixture()
    const before = readFileSync(paths.configPath, "utf8")
    const result = runRecallCutover({
      mode: "cutover",
      dryRun: true,
      ...paths,
      verifiedRelease: verifiedRelease(paths.artifactPath),
    })
    expect(result.previousAdapter).toBe("typesense-recall")
    expect(result.nextAdapter).toBe("flowing-memory-recall")
    expect(result.installedBinaryDigest).not.toBe(result.previousBinaryDigest)
    expect(result.wroteConfig).toBe(false)
    expect(readFileSync(paths.configPath, "utf8")).toBe(before)
  })

  test("allows a 0600 config under an owner-owned non-writable 0755 parent", () => {
    const paths = fixture()
    const parent = join(paths.root, "owner-parent")
    const configPath = join(parent, "config.toml")
    mkdirSync(parent)
    writeFileSync(configPath, "")
    chmodSync(parent, 0o755)
    runRecallCutover({
      mode: "cutover",
      dryRun: false,
      ...paths,
      configPath,
      verifiedRelease: verifiedRelease(paths.artifactPath),
    })
    expect(statSync(parent).mode & 0o777).toBe(0o755)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  test("refuses a group-writable output parent without chmodding it", () => {
    const paths = fixture()
    const parent = join(paths.root, "group-writable-parent")
    const configPath = join(parent, "config.toml")
    mkdirSync(parent)
    writeFileSync(configPath, "")
    chmodSync(parent, 0o775)
    expect(() =>
      runRecallCutover({
        mode: "cutover",
        dryRun: false,
        ...paths,
        configPath,
        verifiedRelease: verifiedRelease(paths.artifactPath),
      }),
    ).toThrow("not writable by group or other")
    expect(statSync(parent).mode & 0o777).toBe(0o775)
  })

  test("candidate probe receives no ambient secret and rejects a help-only fake", () => {
    const paths = fixture()
    process.env.CUTOVER_TEST_SECRET = "must-not-reach-candidate"
    try {
      expect(() =>
        runRecallCutover({
          mode: "cutover",
          dryRun: true,
          ...paths,
          verifiedRelease: verifiedRelease(paths.artifactPath),
        }),
      ).not.toThrow()
    } finally {
      delete process.env.CUTOVER_TEST_SECRET
    }

    writeFileSync(paths.candidateBinaryPath, "#!/bin/sh\nprintf '%s\\n' '--request-file'\n")
    chmodSync(paths.candidateBinaryPath, 0o700)
    const digest = createHash("sha256")
      .update(readFileSync(paths.candidateBinaryPath))
      .digest("hex")
    expect(() =>
      runRecallCutover({
        mode: "cutover",
        dryRun: true,
        ...paths,
        candidateBinarySha256: digest,
        verifiedRelease: verifiedRelease(paths.artifactPath),
      }),
    ).toThrow("private composed recall probe")
  })

  test("an active journal blocks repeated cutover until rollback", () => {
    const paths = fixture()
    runRecallCutover({
      mode: "cutover",
      dryRun: false,
      ...paths,
      verifiedRelease: verifiedRelease(paths.artifactPath),
    })
    expect(() =>
      runRecallCutover({
        mode: "cutover",
        dryRun: true,
        ...paths,
        verifiedRelease: verifiedRelease(paths.artifactPath),
      }),
    ).toThrow("active recall cutover journal")
  })

  test("cutover and rollback preserve config and restore the exact binary", () => {
    const paths = fixture()
    const candidate = readFileSync(paths.candidateBinaryPath, "utf8")
    runRecallCutover({
      mode: "cutover",
      dryRun: false,
      ...paths,
      verifiedRelease: verifiedRelease(paths.artifactPath),
      now: new Date("2026-08-23T00:00:00.000Z"),
    })
    const cutoverConfig = readFileSync(paths.configPath, "utf8")
    expect(cutoverConfig).toContain('adapter = "flowing-memory-recall"')
    expect(cutoverConfig).toContain("custom_timeout_ms = 4321")
    expect(statSync(paths.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(paths.receiptPath).mode & 0o777).toBe(0o600)
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8"))
    expect(receipt.state).toBe("active")
    expect(readFileSync(paths.binaryPath, "utf8")).toBe(candidate)

    runRecallCutover({
      mode: "rollback",
      dryRun: false,
      ...paths,
      now: new Date("2026-08-23T01:00:00.000Z"),
    })
    const rolledBack = readFileSync(paths.configPath, "utf8")
    expect(rolledBack).toContain('adapter = "typesense-recall"')
    expect(rolledBack).toContain(`read_executable = "${paths.artifactPath}"`)
    expect(rolledBack).toContain("custom_timeout_ms = 4321")
    expect(rolledBack).toContain("[[unrelated.items]]")
    expect(readFileSync(paths.binaryPath, "utf8")).toBe("installed binary fixture")
    expect(JSON.parse(readFileSync(paths.receiptPath, "utf8")).state).toBe("rolled-back")
  })
})
