import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(tmpdir(), `critical-search-cli-${crypto.randomUUID()}`)
const binary = join(root, "joelclaw-critical-test")
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  mkdirSync(root, { recursive: true })
  const build = Bun.spawn(["bun", "build", "packages/cli/src/cli.ts", "--compile", "--outfile", binary], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await build.exited).toBe(0)
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/health") {
        if (request.headers.get("authorization") !== "Bearer replica-test-token") {
          return Response.json({ ok: false }, { status: 401 })
        }
        return Response.json({
          ok: true,
          checkedAt: new Date().toISOString(),
          syncCheckAgeSeconds: 5,
          replicaLagSeconds: 2,
        })
      }
      if (path === "/search") {
        if (request.headers.get("authorization") !== "Bearer replica-test-token") {
          return Response.json({ ok: false }, { status: 401 })
        }
        const body = await request.json() as { collections?: string[] }
        const knowledge = body.collections?.includes("system_knowledge")
        return Response.json({
          dbPath: "/data/critical.db",
          found: 1,
          durationMs: 2,
          freshness: {
            builtAt: new Date().toISOString(),
            ageSeconds: 5,
            newestSourceAt: new Date().toISOString(),
            sourceAgeSeconds: 5,
            documentCount: 1,
            status: "ok",
            sources: {},
            coverageGaps: [],
          },
          hits: [{
            id: knowledge ? "replica-knowledge" : "replica-recall",
            collection: knowledge ? "system_knowledge" : "observations",
            type: knowledge ? "adr" : "observation",
            title: knowledge ? "Replica knowledge" : "Replica recall",
            content: "Critical search replica result",
            source: "fixture",
            sourceKey: "fixture",
            privacy: "private",
            payload: {},
            rank: -1,
            score: 1,
            snippet: "Critical search replica result",
            sourceFreshness: {
              sourceKey: "fixture",
              highWaterAt: null,
              ageSeconds: 5,
              status: "fresh",
              documentAgeSeconds: 5,
            },
          }],
        })
      }
      if (path === "/multi_search") {
        return Response.json({
          results: [
            {
              found: 1,
              hits: [{ document: { id: "fallback-observation", gist: "Typesense fallback result", started_at: Date.now() } }],
            },
            { found: 0, hits: [] },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(() => {
  server?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([binary, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TYPESENSE_URL: `http://127.0.0.1:${server.port}`,
      TYPESENSE_API_KEY: "compiled-fallback-test-key",
      JOELCLAW_RECALL_REWRITE: "0",
      JOELCLAW_RECALL_OTEL: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
}

function schemaMismatchDb(path: string): void {
  const db = new Database(path, { create: true })
  db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO metadata VALUES ('schema_version', 'wrong')")
  db.close()
}

describe("compiled critical-search fallback", () => {
  for (const fixture of ["missing", "truncated", "unreadable", "schema-mismatch"] as const) {
    test(`recall falls back for ${fixture} critical.db`, async () => {
      const dbPath = join(root, `${fixture}.db`)
      if (fixture === "truncated") writeFileSync(dbPath, "not sqlite")
      if (fixture === "unreadable") {
        writeFileSync(dbPath, "not readable")
        chmodSync(dbPath, 0o000)
      }
      if (fixture === "schema-mismatch") schemaMismatchDb(dbPath)
      const [exit, stdout, stderr] = await run(["recall", "fallback result", "--limit", "1"], {
        JOELCLAW_CRITICAL_DB: dbPath,
      })
      expect(exit, stderr).toBe(0)
      expect(stdout).toContain("fallback-observation")
      expect(stdout).toContain('"from": "sqlite-fts5"')
    })
  }

  test("compiled recall surfaces the answering replica", async () => {
    const [exit, stdout, stderr] = await run(["recall", "critical replica", "--limit", "1"], {
      JOELCLAW_CRITICAL_DB: join(root, "missing-replica-recall.db"),
      JOELCLAW_CRITICAL_SEARCH_REPLICAS: `nas-a=http://127.0.0.1:${server.port}`,
      JOELCLAW_CRITICAL_SEARCH_TOKEN: "replica-test-token",
    })
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain('"name": "nas-a"')
    expect(stdout).toContain("replica-recall")
  })

  test("compiled knowledge surfaces the answering replica", async () => {
    const [exit, stdout, stderr] = await run(["knowledge", "search", "critical replica", "--limit", "1"], {
      JOELCLAW_CRITICAL_DB: join(root, "missing-replica-knowledge.db"),
      JOELCLAW_CRITICAL_SEARCH_REPLICAS: `nas-a=http://127.0.0.1:${server.port}`,
      JOELCLAW_CRITICAL_SEARCH_TOKEN: "replica-test-token",
    })
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain('"name": "nas-a"')
    expect(stdout).toContain("replica-knowledge")
  })

  test("knowledge reports credential failure without crashing", async () => {
    const [exit, stdout, stderr] = await run(["knowledge", "search", "credential failure"], {
      JOELCLAW_CRITICAL_DB: join(root, "missing-knowledge.db"),
      TYPESENSE_API_KEY: undefined,
      PATH: "/usr/bin:/bin",
      HOME: join(root, "empty-home"),
    })
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain("KNOWLEDGE_SEARCH_FAILED")
    expect(stdout).toContain("Typesense fallback failed")
  })

  test("knowledge reports network failure without crashing", async () => {
    const [exit, stdout, stderr] = await run(["knowledge", "search", "network failure"], {
      JOELCLAW_CRITICAL_DB: join(root, "missing-network.db"),
      TYPESENSE_URL: "http://127.0.0.1:1",
    })
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain("KNOWLEDGE_SEARCH_FAILED")
    expect(stdout).toContain("Typesense fallback failed")
  })
})
