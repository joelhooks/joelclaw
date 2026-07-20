import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __sqliteRecallTestUtils } from "../capabilities/adapters/typesense-recall"
import {
  buildCriticalDb,
  CriticalDbUnavailableError,
  readFreshness,
  resolveObservationReference,
  searchCriticalDb,
  searchCriticalProjection,
} from "./critical-search"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("failed to allocate test port"))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

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
identityKind: capture-conversation
captureConversationId: session-456
producerRunId: producer-123
sessionId: session-456
windowFrom: 1784505600000
windowTo: 1784509200000
started: 2026-07-20T00:00:00Z
---
# SQLite recovery

Critical search opens without rebuilding an index.
`)
  writeFileSync(join(observations, "legacy-epoch.svx"), `---
type: observation
schemaVersion: 1
title: Legacy epoch bridge
slug: legacy-epoch
privacy: private
sessionId: session-456
started: 2026-07-20T00:00:00Z
ended: 2026-07-20T01:00:00Z
---
# Legacy epoch bridge

Old pages keep their bare sessionId.
`)
  writeFileSync(join(observations, "unresolved-epoch.svx"), `---
type: observation
schemaVersion: 1
title: Unresolved epoch bridge
slug: unresolved-epoch
privacy: private
identityKind: capture-conversation
captureConversationId: missing-conversation
sessionId: missing-conversation
windowFrom: 1784505600000
windowTo: 1784509200000
started: 2026-07-20T00:00:00Z
ended: 2026-07-20T01:00:00Z
---
# Unresolved epoch bridge

This reference must report false after the exact lookup.
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
  const sessionsDb = join(root, "sessions.db")
  const sessions = new Database(sessionsDb, { create: true, strict: true })
  sessions.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, conversation_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, chunk_count INTEGER NOT NULL) STRICT;
    CREATE TABLE chunks (chunk_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, chunk_idx INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, started_at INTEGER NOT NULL, token_count INTEGER NOT NULL) STRICT;
  `)
  sessions.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?)").run("capture-a", "session-456", 1784505600100, 1784509199000, 1)
  sessions.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?)").run("capture-b", "session-456", 1784505600200, 1784509199000, 1)
  sessions.query("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)").run("chunk-a", "capture-a", 0, "assistant", "Critical search opens", 1784505600200, 3)
  sessions.query("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)").run("chunk-b", "capture-b", 0, "user", "without rebuilding", 1784505600300, 3)
  sessions.close()
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
  return { root, observations, brain, vault, skills, archive, sessionsDb, db: join(root, "critical.db") }
}

describe("critical search database", () => {
  test("build is repeatable and namespaces producer Runs", async () => {
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
    expect(result.hits[0]?.producerRunId).toBe("producer-123")
    expect(result.hits[0]?.content).toContain("Producer Run-ID: producer-123")
    expect(result.freshness.ageSeconds).toBe(300)
    expect(result.freshness.documentCount).toBe(first.documentCount)
  })

  test("resolves old bare-sessionId pages through started and ended bounds", async () => {
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
    const result = searchCriticalDb({ query: "Legacy epoch bridge", dbPath: paths.db, sessionsDbPath: paths.sessionsDb })
    expect(result.hits[0]?.observerSessionReference).toMatchObject({
      kind: "capture-conversation",
      value: "session-456",
      resolvableInSessionsDb: true,
      candidateRuns: [{ runId: "capture-a" }, { runId: "capture-b" }],
    })
  })

  test("marks an unresolved hit false only after its exact sessions.db lookup", async () => {
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
    const result = searchCriticalDb({ query: "Unresolved epoch bridge", dbPath: paths.db, sessionsDbPath: paths.sessionsDb })
    expect(result.hits[0]?.observerSessionReference).toEqual({
      kind: "capture-conversation",
      value: "missing-conversation",
      resolvableInSessionsDb: false,
      candidateRuns: [],
      window: { from: 1784505600000, to: 1784509200000 },
    })
  })

  test("resolves every Run with chunks inside (windowFrom, windowTo]", () => {
    const paths = fixture()
    expect(resolveObservationReference({
      captureConversationId: "session-456",
      windowFrom: 1784505600000,
      windowTo: 1784509200000,
      sessionsDbPath: paths.sessionsDb,
    })).toEqual({
      kind: "capture-conversation",
      value: "session-456",
      resolvableInSessionsDb: true,
      candidateRuns: [
        { runId: "capture-a", startedAt: 1784505600100, endedAt: 1784509199000, chunkCount: 1 },
        { runId: "capture-b", startedAt: 1784505600200, endedAt: 1784509199000, chunkCount: 1 },
      ],
      window: { from: 1784505600000, to: 1784509200000 },
    })
    expect(resolveObservationReference({ captureConversationId: "missing", sessionsDbPath: paths.sessionsDb }).resolvableInSessionsDb).toBe(false)
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
    const previousSessionsDb = process.env.JOELCLAW_SESSIONS_DB
    process.env.JOELCLAW_CRITICAL_DB = paths.db
    try {
      process.env.JOELCLAW_SESSIONS_DB = paths.sessionsDb
      const result = await __sqliteRecallTestUtils.sqliteRecall({
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
      expect(hit?.producerRunId).toBe("producer-123")
      expect(hit?.observerRunId).toBeUndefined()
      expect(hit?.observerRunReference).toBeUndefined()
      expect(hit?.observerSessionReference).toEqual({
        kind: "capture-conversation",
        value: "session-456",
        resolvableInSessionsDb: true,
        candidateRuns: [
          { runId: "capture-a", startedAt: 1784505600100, endedAt: 1784509199000, chunkCount: 1 },
          { runId: "capture-b", startedAt: 1784505600200, endedAt: 1784509199000, chunkCount: 1 },
        ],
        window: { from: 1784505600000, to: 1784509200000 },
      })
    } finally {
      if (previousSessionsDb === undefined) delete process.env.JOELCLAW_SESSIONS_DB
      else process.env.JOELCLAW_SESSIONS_DB = previousSessionsDb
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

  test("walks replicas in order, skips stale health, and surfaces the answering replica", async () => {
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
    const replicaResult = searchCriticalDb({ query: "SQLite critical index", dbPath: paths.db })
    const requests: string[] = []
    const stale = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(`stale:${new URL(request.url).pathname}`)
        return Response.json({ ok: true, syncCheckAgeSeconds: 900, replicaLagSeconds: 12 })
      },
    })
    const healthy = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(`healthy:${path}`)
        if (path === "/health") {
          return Response.json({ ok: true, checkedAt: new Date().toISOString(), syncCheckAgeSeconds: 10, replicaLagSeconds: 4 })
        }
        if (path === "/search") return Response.json(replicaResult)
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const result = await searchCriticalProjection({
        query: "SQLite critical index",
        skipLocal: true,
        replicas: [
          { name: "nas-a", url: `http://127.0.0.1:${stale.port}`, maxStalenessSeconds: 300, token: "test-token" },
          { name: "nas-b", url: `http://127.0.0.1:${healthy.port}`, maxStalenessSeconds: 300, token: "test-token" },
        ],
      })
      expect(requests).toEqual(["stale:/health", "healthy:/health", "healthy:/search"])
      expect(result.servedBy).toEqual(expect.objectContaining({
        name: "nas-b",
        kind: "replica",
        syncCheckAgeSeconds: 10,
        replicaLagSeconds: 4,
      }))
      expect(result.found).toBeGreaterThan(0)
    } finally {
      stale.stop(true)
      healthy.stop(true)
    }
  })

  test("rejects a replica whose sync heartbeat is missing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, syncCheckAgeSeconds: null, replicaLagSeconds: null })
      },
    })
    try {
      await expect(searchCriticalProjection({
        query: "unverified snapshot",
        skipLocal: true,
        replicas: [{ name: "nas-a", url: `http://127.0.0.1:${server.port}`, token: "test-token" }],
      })).rejects.toThrow("sync check age is missing or invalid")
    } finally {
      server.stop(true)
    }
  })

  test("queries the real authenticated read-only Python shim", async () => {
    const python = Bun.which("python3")
    if (!python) return
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
    const statePath = join(paths.root, "sync-state.json")
    writeFileSync(statePath, JSON.stringify({
      checkedAt: new Date().toISOString(),
      copiedAt: new Date().toISOString(),
      sourceMtime: new Date().toISOString(),
      sha256: "fixture-sha",
    }))
    const token = "a".repeat(64)
    const port = await freePort()
    const child = Bun.spawn([python, "infra/critical-search-replica/server.py"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CRITICAL_DB_PATH: paths.db,
        SYNC_STATE_PATH: statePath,
        CRITICAL_SEARCH_TOKEN: token,
        REPLICA_NAME: "python-shim",
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    try {
      let ready = false
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { authorization: `Bearer ${token}` },
          })
          if (response.ok) {
            ready = true
            break
          }
        } catch {}
        await Bun.sleep(50)
      }
      expect(ready).toBe(true)
      const result = await searchCriticalProjection({
        query: "SQLite critical index",
        skipLocal: true,
        replicas: [{ name: "python-shim", url: `http://127.0.0.1:${port}`, token }],
      })
      expect(result.found).toBeGreaterThan(0)
      expect(result.servedBy).toEqual(expect.objectContaining({ name: "python-shim", kind: "replica" }))
    } finally {
      child.kill()
      await child.exited
    }
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
