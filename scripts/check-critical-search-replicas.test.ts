import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("critical-search replica synthetic", () => {
  test("alerts once per failure transition and once on recovery", async () => {
    const root = join(tmpdir(), `critical-search-synthetic-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const token = "synthetic-test-token"
    let healthy = false
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return Response.json({ ok: false }, { status: 401 })
        }
        const path = new URL(request.url).pathname
        if (path === "/health") {
          return healthy
            ? Response.json({ ok: true, syncCheckAgeSeconds: 5, replicaLagSeconds: 2 })
            : Response.json({ ok: false }, { status: 503 })
        }
        if (path === "/search") return Response.json({ found: 1 })
        return new Response("not found", { status: 404 })
      },
    })
    const tokenFile = join(root, "token")
    const configFile = join(root, "config.json")
    const stateFile = join(root, "state.json")
    const notifyLog = join(root, "notify.log")
    const notifier = join(root, "notify")
    writeFileSync(tokenFile, token)
    writeFileSync(configFile, JSON.stringify({
      tokenFile,
      replicas: [
        { name: "nas-a", url: `http://127.0.0.1:${server.port}` },
        { name: "nas-b", url: `http://127.0.0.1:${server.port}` },
      ],
    }))
    writeFileSync(notifier, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NOTIFY_LOG\"\n")
    chmodSync(notifier, 0o700)

    const run = async () => {
      const child = Bun.spawn(["bun", "scripts/check-critical-search-replicas.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JOELCLAW_CRITICAL_SEARCH_CONFIG: configFile,
          JOELCLAW_CRITICAL_SEARCH_SYNTHETIC_STATE: stateFile,
          JOELCLAW_BIN: notifier,
          NOTIFY_LOG: notifyLog,
          CRITICAL_SEARCH_NOTIFY: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return exitCode
    }

    try {
      expect(await run()).toBe(1)
      expect(await run()).toBe(1)
      expect(readFileSync(notifyLog, "utf8").trim().split("\n")).toHaveLength(1)
      healthy = true
      expect(await run()).toBe(0)
      const notifications = readFileSync(notifyLog, "utf8").trim().split("\n")
      expect(notifications).toHaveLength(2)
      expect(notifications[0]).toContain("synthetic failed")
      expect(notifications[1]).toContain("synthetic recovered")
      expect(JSON.parse(readFileSync(stateFile, "utf8")).overall).toBe("ok")
    } finally {
      server.stop(true)
    }
  })
})
