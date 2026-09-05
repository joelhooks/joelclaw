import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CRITICAL_MEMORY_ARCHIVE_FILENAME,
  CRITICAL_MEMORY_ARCHIVE_SHA256,
  frozenCriticalMemoryArchivePath,
  selectCriticalMemoryArchive,
  verifyCriticalMemoryArchive,
} from "./critical-memory-archive"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe("critical memory archive selection", () => {
  test("pins the HOME-based frozen default", () => {
    const home = join(tmpdir(), "fixture-home")
    expect(selectCriticalMemoryArchive({ env: {}, home })).toEqual({
      path: frozenCriticalMemoryArchivePath(home),
      expectedSha256: CRITICAL_MEMORY_ARCHIVE_SHA256,
      source: "frozen-default",
    })
    expect(frozenCriticalMemoryArchivePath(home)).toEndWith(CRITICAL_MEMORY_ARCHIVE_FILENAME)
  })

  test("preserves explicit CLI and environment overrides", () => {
    expect(
      selectCriticalMemoryArchive({
        cliPath: "./fixture-cli.jsonl",
        cliSha256: "a".repeat(64),
        env: { JOELCLAW_CRITICAL_MEMORY_ARCHIVE: "./fixture-env.jsonl" },
      }),
    ).toMatchObject({
      path: join(process.cwd(), "fixture-cli.jsonl"),
      expectedSha256: "a".repeat(64),
      source: "cli",
    })
    expect(
      selectCriticalMemoryArchive({
        env: { MEMORY_OBSERVATIONS_ARCHIVE: "./fixture-env.jsonl" },
      }),
    ).toMatchObject({
      path: join(process.cwd(), "fixture-env.jsonl"),
      source: "environment",
    })
  })

  test("verifies a pinned archive and rejects checksum drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "critical-memory-archive-"))
    roots.push(root)
    const path = join(root, "fixture.jsonl")
    const contents = `${JSON.stringify({ id: "synthetic" })}\n`
    writeFileSync(path, contents)
    const sha256 = createHash("sha256").update(contents).digest("hex")

    await expect(
      verifyCriticalMemoryArchive({ path, expectedSha256: sha256, source: "cli" }),
    ).resolves.toMatchObject({
      actualSha256: sha256,
      bytes: Buffer.byteLength(contents),
      verification: "pinned",
    })
    await expect(
      verifyCriticalMemoryArchive({
        path,
        expectedSha256: "0".repeat(64),
        source: "cli",
      }),
    ).rejects.toThrow("checksum mismatch")
  })
})
