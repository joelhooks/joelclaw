import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __sqliteRecallTestUtils } from "../capabilities/adapters/typesense-recall"
import { buildCriticalDb, CriticalDbUnavailableError, readFreshness, searchCriticalDb } from "./critical-search"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = join(tmpdir(), `critical-search-${crypto.randomUUID()}`)
  roots.push(root)
  const observations = join(root, "observations")
  const brain = join(root, "brain")
  const vault = join(root, "vault")
  const skills = join(root, "skills")
  for (const path of [observations, brain, join(vault, "docs", "decisions"), join(skills, "session-search")]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(observations, "sqlite-recovery.svx"), `---
type: observation
schemaVersion: 1
title: SQLite recovery receipt
slug: sqlite-recovery
privacy: private
runId: run-123
sessionId: session-456
started: 2026-07-20T00:00:00Z
---
# SQLite recovery

Critical search opens without rebuilding an index.
`)
  writeFileSync(join(brain, "availability.svx"), `---
title: Availability shape
type: decision
privacy: private
---
# Availability shape

Use ordered fallback across flagg and both NAS boxes.
`)
  writeFileSync(join(vault, "docs", "decisions", "0200-critical-search.md"), "# Critical search\n\nSQLite FTS5 is the durable critical index.\n")
  writeFileSync(join(skills, "session-search", "SKILL.md"), "---\ndescription: Search sessions safely.\n---\n# Session search\n")
  const archive = join(root, "memory.jsonl")
  writeFileSync(archive, `${JSON.stringify({
    id: "memory-1",
    title: "Archived recovery memory",
    observation: "February memory must expose archive source age.",
    timestamp: Math.floor(Date.parse("2026-02-18T15:42:00Z") / 1_000),
    updated_at: "2026-07-17T10:01:29Z",
    session_id: "session-memory",
  })}\n${JSON.stringify({
    id: "memory-2",
    title: "Archive high water",
    observation: "Latest retained memory event.",
    timestamp: Math.floor(Date.parse("2026-05-31T03:30:53Z") / 1_000),
    updated_at: "2026-07-17T10:01:29Z",
    session_id: "session-memory",
  })}\n`)
  return { root, observations, brain, vault, skills, archive, db: join(root, "critical.db") }
}

describe("critical search database", () => {
  test("build is repeatable and preserves observer Run-ID source labels", async () => {
    const paths = fixture()
    const options = {
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
      now: new Date("2026-07-20T01:00:00Z"),
    }
    const first = await buildCriticalDb(options)
    const second = await buildCriticalDb(options)
    expect(second.documentCount).toBe(first.documentCount)

    const result = searchCriticalDb({ query: "opens rebuilding index", dbPath: paths.db, now: new Date("2026-07-20T01:05:00Z") })
    expect(result.hits[0]?.runId).toBe("run-123")
    expect(result.hits[0]?.content).toContain("Run-ID: run-123")
    expect(result.freshness.ageSeconds).toBe(300)
    expect(result.freshness.documentCount).toBe(first.documentCount)
  })

  test("searches knowledge and vault documents with collection filters", async () => {
    const paths = fixture()
    await buildCriticalDb({
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    })
    const result = searchCriticalDb({
      query: "SQLite durable critical index",
      collections: ["system_knowledge", "vault_notes"],
      dbPath: paths.db,
    })
    expect(result.found).toBeGreaterThan(0)
    expect(result.hits.every((hit) => ["system_knowledge", "vault_notes"].includes(hit.collection))).toBe(true)
  })

  test("recall adapter payload identifies SQLite and freshness", async () => {
    const paths = fixture()
    await buildCriticalDb({
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    })
    const previous = process.env.JOELCLAW_CRITICAL_DB
    process.env.JOELCLAW_CRITICAL_DB = paths.db
    try {
      const result = __sqliteRecallTestUtils.sqliteRecall({
        query: "opens rebuilding index",
        limit: 5,
        minScore: 0,
        raw: false,
        includeHold: false,
        includeDiscard: false,
        budget: "auto",
        category: "",
      })
      expect(result.payload?.backend).toBe("sqlite-fts5")
      expect(result.payload?.freshness).toBeDefined()
      expect(result.payload?.queryContract).toEqual(expect.objectContaining({
        tokenMatching: "OR token-drop approximation",
        rewrite: "disabled on the critical availability path",
      }))
      const hit = (result.payload?.hits as Array<Record<string, unknown>>)[0]
      expect(hit?.observerRunId).toBe("run-123")
      expect(hit?.runBacklink).toBeUndefined()
      expect(hit?.observerRunReference).toEqual({ kind: "source-label", value: "run-123", resolvableInRunsDev: false })
    } finally {
      if (previous === undefined) delete process.env.JOELCLAW_CRITICAL_DB
      else process.env.JOELCLAW_CRITICAL_DB = previous
    }
  })

  test("reports archive freshness on memory hits instead of unrelated Brain freshness", async () => {
    const paths = fixture()
    await buildCriticalDb({
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
      now: new Date("2026-07-20T01:00:00Z"),
    })
    const result = searchCriticalDb({
      query: "February memory archive",
      dbPath: paths.db,
      now: new Date("2026-07-20T01:00:00Z"),
    })
    const memory = result.hits.find((hit) => hit.collection === "memory_observations")
    expect(memory?.sourceFreshness.sourceKey).toBe("archive:memory_observations")
    expect(memory?.sourceFreshness.highWaterAt).toBe("2026-05-31T03:30:53.000Z")
    expect(memory?.sourceFreshness.ageSeconds).toBeGreaterThan(4_000_000)
    expect(result.freshness.status).toBe("stale")
  })

  test("refuses missing sources and preserves the healthy database", async () => {
    const paths = fixture()
    const valid = {
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    }
    await buildCriticalDb(valid)
    const before = readFileSync(paths.db)
    const missing = join(paths.root, "missing")
    await expect(buildCriticalDb({
      ...valid,
      observationsDir: missing,
      brainRoots: [missing],
      vaultDir: missing,
      skillsDir: missing,
      memoryArchivePath: missing,
    })).rejects.toThrow("refusing to replace critical.db with degraded sources")
    expect(readFileSync(paths.db)).toEqual(before)
  })

  test("reports local parse failures and refuses publication", async () => {
    const paths = fixture()
    writeFileSync(join(paths.observations, "broken.svx"), "---\ntitle: [unterminated\n---\n# Broken\n")
    await expect(buildCriticalDb({
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    })).rejects.toThrow("files:observations is error")
  })

  test("refuses a required source regression below the safe count", async () => {
    const paths = fixture()
    const extras = Array.from({ length: 9 }, (_, index) => join(paths.observations, `extra-${index}.svx`))
    for (const [index, path] of extras.entries()) {
      writeFileSync(path, `---\ntype: observation\nslug: extra-${index}\ntitle: Extra ${index}\n---\n# Extra\n\nSearchable observation ${index}.\n`)
    }
    const options = {
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    }
    await buildCriticalDb(options)
    for (const path of extras.slice(0, 4)) unlinkSync(path)
    await expect(buildCriticalDb(options)).rejects.toThrow("files:observations regressed")
  })

  test("refuses malformed archives and honors only an explicit degraded override", async () => {
    const paths = fixture()
    writeFileSync(paths.archive, "{not-json}\n")
    const options = {
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    }
    await expect(buildCriticalDb(options)).rejects.toThrow("archive:memory_observations is error")
    const overridden = await buildCriticalDb({ ...options, allowDegradedSources: true })
    expect(overridden.sources["archive:memory_observations"]?.status).toBe("error")
    expect(readFreshness(paths.db).status).toBe("degraded")
  })

  test("serializes concurrent builders with an exclusive lock", async () => {
    const paths = fixture()
    const options = {
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    }
    const outcomes = await Promise.allSettled([buildCriticalDb(options), buildCriticalDb(options)])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    const rejection = outcomes.find((outcome) => outcome.status === "rejected")
    expect(rejection?.status === "rejected" ? String(rejection.reason) : "").toContain("builder lock is held")
  })

  test("keeps token-drop recall semantics for broad multi-word queries", async () => {
    const paths = fixture()
    await buildCriticalDb({
      dbPath: paths.db,
      observationsDir: paths.observations,
      brainRoots: [paths.brain],
      vaultDir: paths.vault,
      skillsDir: paths.skills,
      memoryArchivePath: paths.archive,
      allowNonFlagg: true,
    })
    const result = searchCriticalDb({ query: "SQLite nonexistent-token", dbPath: paths.db })
    expect(result.found).toBeGreaterThan(0)
    expect(result.hits[0]?.score).toBeGreaterThanOrEqual(0)
  })

  test("reports unavailable instead of creating a database in readers", () => {
    const missing = join(tmpdir(), `missing-${crypto.randomUUID()}.db`)
    expect(() => readFreshness(missing)).toThrow(CriticalDbUnavailableError)
    expect(() => searchCriticalDb({ query: "anything", dbPath: missing })).toThrow(CriticalDbUnavailableError)
  })
})
