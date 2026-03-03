import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { __inngestTestUtils } from "./inngest"

const {
  parseCsvList,
  buildSweepStalePredicate,
  parseSqliteJsonRows,
  runIdHexToUlid,
  mapSweepCandidates,
  decodeConnectStartResponse,
  encodeConnectStartResponseForTest,
  encodeConnectMessage,
  decodeConnectMessage,
  connectMessageKindName,
} = __inngestTestUtils

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts")

type JsonEnvelope = Record<string, unknown>

const defaultCliEnv = {
  INNGEST_EVENT_KEY: "test-event-key",
  INNGEST_SIGNING_KEY: "test-signing-key",
}

const runCli = async (commandArgs: string[], env: Record<string, string> = {}): Promise<JsonEnvelope> => {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...commandArgs], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      ...defaultCliEnv,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [status, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  expect(status).toBe(0)
  expect(stderrText.trim()).toBe("")

  const output = stdoutText.trim()
  expect(output.length).toBeGreaterThan(0)
  return JSON.parse(output) as JsonEnvelope
}

const connectStartFixture = (gatewayEndpoint: string) => ({
  connectionId: "01KJS3DYBNS2FHXFC02KXNZFE3",
  gatewayEndpoint,
  gatewayGroup: "gw-dev",
  sessionToken: "eyJ.test.session",
  syncToken: "d51bc9e432e7b6f694a4b496b2b3f7595db1e0852d031887cfb19ebcd0d139b5",
})

describe("inngest sweep-stale-runs helpers", () => {
  test("parseCsvList trims and drops empty items", () => {
    expect(parseCsvList("check/system-health, check/o11y-triage ,, ")).toEqual([
      "check/system-health",
      "check/o11y-triage",
    ])
  })

  test("runIdHexToUlid decodes 16-byte run_id hex", () => {
    expect(runIdHexToUlid("019cb031eca3471598a1731acd6b8945")).toBe("01KJR33V538WASH8BK3B6PQ2A5")
    expect(runIdHexToUlid("not-hex")).toBeNull()
  })

  test("buildSweepStalePredicate includes age threshold and escaped function names", () => {
    const where = buildSweepStalePredicate({
      namespace: "joelclaw",
      pod: "inngest-0",
      dbPath: "/data/main.db",
      functionNames: ["check/o11y-triage", "team/o'hara"],
      olderThanMinutes: 10,
      sampleLimit: 25,
      maxApplyCandidates: 200,
    })

    expect(where).toContain("tr.status = 200")
    expect(where).toContain("10 * 60 * 1000")
    expect(where).toContain("'check/o11y-triage'")
    expect(where).toContain("'team/o''hara'")
  })

  test("parseSqliteJsonRows parses multi-statement sqlite -json output", () => {
    const output = [
      '[{"metric":"candidates","value":2}]',
      '[{"metric":"trace_runs_terminalized","value":2}]',
    ].join("\n")

    expect(parseSqliteJsonRows(output)).toEqual([
      { metric: "candidates", value: 2 },
      { metric: "trace_runs_terminalized", value: 2 },
    ])
  })

  test("mapSweepCandidates normalizes preview rows", () => {
    const rows = [
      {
        run_id_hex: "019cb031eca3471598a1731acd6b8945",
        function_name: "check/system-health",
        trace_status: 200,
        started_at: 1772482587821,
        ended_at: 0,
        age_minutes: 17,
        has_finish: 0,
        has_terminal_history: 1,
      },
    ]

    const [candidate] = mapSweepCandidates(rows)
    expect(candidate?.runId).toBe("01KJR33V538WASH8BK3B6PQ2A5")
    expect(candidate?.runIdHex).toBe("019cb031eca3471598a1731acd6b8945")
    expect(candidate?.hasFinish).toBe(false)
    expect(candidate?.hasTerminalHistory).toBe(true)
    expect(candidate?.startedAtIso).toMatch(/^2026-03-02T/) // deterministic enough for fixture
  })
})

describe("inngest connect-auth protobuf helpers", () => {
  test("decodeConnectStartResponse round-trips encoded fixture", () => {
    const fixture = {
      connectionId: "01KJS3DYBNS2FHXFC02KXNZFE3",
      gatewayEndpoint: "ws://localhost:8289/v0/connect",
      gatewayGroup: "gw-dev",
      sessionToken: "eyJ.test.session",
      syncToken: "d51bc9e432e7b6f694a4b496b2b3f7595db1e0852d031887cfb19ebcd0d139b5",
    }

    const encoded = encodeConnectStartResponseForTest(fixture)
    expect(decodeConnectStartResponse(encoded)).toEqual(fixture)
  })

  test("connect message encode/decode preserves kind and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const encoded = encodeConnectMessage(2, payload)
    const decoded = decodeConnectMessage(encoded)

    expect(decoded.kind).toBe(2)
    expect([...decoded.payload]).toEqual([1, 2, 3, 4])
    expect(connectMessageKindName(decoded.kind)).toBe("GATEWAY_CONNECTION_READY")
    expect(connectMessageKindName(999)).toBe("UNKNOWN(999)")
  })
})

describe("inngest connect-auth command error paths", () => {
  test("returns CONNECT_START_AUTH_FAILED when start endpoint rejects bearer token", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/v0/connect/start") {
          return new Response("not authorized", { status: 401 })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const envelope = await runCli([
        "inngest",
        "connect-auth",
        "--url",
        `http://127.0.0.1:${server.port}`,
      ])

      expect(envelope.ok).toBe(false)
      expect((envelope.error as { code?: string } | undefined)?.code).toBe("CONNECT_START_AUTH_FAILED")
    } finally {
      server.stop(true)
    }
  })

  test("returns CONNECT_START_PARSE_FAILED when start payload is malformed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/v0/connect/start") {
          return new Response("definitely-not-protobuf", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const envelope = await runCli([
        "inngest",
        "connect-auth",
        "--url",
        `http://127.0.0.1:${server.port}`,
      ])

      expect(envelope.ok).toBe(false)
      expect((envelope.error as { code?: string } | undefined)?.code).toBe("CONNECT_START_PARSE_FAILED")
    } finally {
      server.stop(true)
    }
  })

  test("returns CONNECT_WS_AUTH_FAILED when websocket handshake cannot be established", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/v0/connect/start") {
          const payload = encodeConnectStartResponseForTest(
            connectStartFixture(`ws://127.0.0.1:${server.port}/v0/connect`),
          )
          return new Response(payload, { status: 200 })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const envelope = await runCli([
        "inngest",
        "connect-auth",
        "--url",
        `http://127.0.0.1:${server.port}`,
        "--timeout-ms",
        "1000",
      ])

      expect(envelope.ok).toBe(false)
      expect((envelope.error as { code?: string } | undefined)?.code).toBe("CONNECT_WS_AUTH_FAILED")
    } finally {
      server.stop(true)
    }
  })

  test("start-only mode succeeds with valid protobuf payload and skips websocket", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/v0/connect/start") {
          const payload = encodeConnectStartResponseForTest(
            connectStartFixture("ws://127.0.0.1:65535/v0/connect"),
          )
          return new Response(payload, { status: 200 })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const envelope = await runCli([
        "inngest",
        "connect-auth",
        "--url",
        `http://127.0.0.1:${server.port}`,
        "--start-only",
      ])

      expect(envelope.ok).toBe(true)
      expect((envelope.result as { mode?: string } | undefined)?.mode).toBe("start-only")
      expect(((envelope.result as { websocket?: { skipped?: boolean } } | undefined)?.websocket)?.skipped).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
