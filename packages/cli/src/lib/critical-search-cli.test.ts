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
    fetch(request) {
      if (new URL(request.url).pathname === "/multi_search") {
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
