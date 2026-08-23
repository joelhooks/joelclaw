import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseComposedRecallEnvelope } from "./contract"
import {
  createComposedRecallRequest,
  formatRecallLanes,
  type RecallProcessRunner,
  runComposedRecallCli,
  runRecallProcess,
} from "./index"

const request = createComposedRecallRequest({
  query: "private canary query",
  scope: { project: "joelhooks.joelclaw", workstream: "main" },
  access: {
    principalRef: "operator:joel",
    purpose: "test-recall",
    allowedPrivacy: ["public", "private"],
  },
  decidedAt: "2026-08-23T00:00:00.000Z",
})

function availableLane(name: "flowing-reflections" | "flowing-observations" | "curated-pages") {
  return {
    _tag: "RecallLaneAvailableV1",
    health:
      name === "curated-pages"
        ? { _tag: "Stale", detail: "fixture stale projection" }
        : { _tag: "Healthy" },
    items: [
      {
        evidenceIds: name === "curated-pages" ? [] : ["run:1"],
        id: `${name}-1`,
        kind: name === "curated-pages" ? "brain_pages" : "observation",
        lane: name,
        privacy: "private",
        rank: 1,
        scope: request.scope,
        scopeBinding: name === "curated-pages" ? "retrieval-scope" : "record-scope",
        score: 0.8,
        summary: `${name} summary`,
        title: `${name} title`,
      },
    ],
    lane: name,
    scoreScale: name === "curated-pages" ? "bm25-negated" : "unit-interval",
    source: name === "curated-pages" ? "critical-db-curated" : "flowing-memory-read-v1",
  }
}

function envelope() {
  return {
    ok: true,
    command: "joelclaw recall",
    result: {
      adapter: "flowing-memory-recall",
      composed: {
        _tag: "ComposedRecallResultV1",
        lanes: {
          curatedPages: availableLane("curated-pages"),
          flowingObservations: availableLane("flowing-observations"),
          flowingReflections: availableLane("flowing-reflections"),
        },
        request,
        resolvedAccess: request.access,
        resolvedScope: request.scope,
        schemaVersion: 1,
        unavailable: [],
      },
    },
    next_actions: [],
  }
}

describe("composed recall parser", () => {
  test("preserves canonical lane order without blending scores", () => {
    const parsed = parseComposedRecallEnvelope(envelope())
    expect(parsed.lanes.map((lane) => lane.name)).toEqual([
      "flowing-reflections",
      "flowing-observations",
      "curated-pages",
    ])
    expect(formatRecallLanes(parsed).map((lane) => lane.name)).toEqual([
      "flowing-reflections",
      "flowing-observations",
      "curated-pages",
    ])
  })

  test("rejects an unknown lane shape", () => {
    const value = envelope()
    ;(value.result.composed.lanes as Record<string, unknown>).legacyHits = []
    expect(() => parseComposedRecallEnvelope(value)).toThrow("unknown or missing lane field")
  })

  test("rejects wrong score scales, foreign scopes, and unknown unavailable codes", () => {
    const wrongScale = envelope()
    wrongScale.result.composed.lanes.flowingObservations.scoreScale = "bm25-negated"
    expect(() => parseComposedRecallEnvelope(wrongScale)).toThrow("score scale")

    const foreignScope = structuredClone(envelope())
    const foreignItem = foreignScope.result.composed.lanes.flowingReflections
      .items[0] as unknown as {
      scope: { _tag: "ProjectWorkstream"; project: string; workstream: string }
    }
    foreignItem.scope = {
      _tag: "ProjectWorkstream",
      project: "other.repo",
      workstream: "main",
    }
    expect(() => parseComposedRecallEnvelope(foreignScope)).toThrow("item scope")

    const unknownCode = envelope() as unknown as {
      ok: boolean
      result: { composed: { lanes: Record<string, unknown>; unavailable: unknown[] } }
    }
    const unavailable = {
      _tag: "RecallLaneUnavailableV1",
      code: "made-up-code",
      lane: "curated-pages",
      message: "unavailable",
      source: "critical-db-curated",
    }
    unknownCode.result.composed.lanes.curatedPages = unavailable
    unknownCode.result.composed.unavailable = [unavailable]
    expect(() => parseComposedRecallEnvelope(unknownCode)).toThrow("unavailable code")
  })
})

describe("private CLI process boundary", () => {
  test("caps automatic queries before serializing private stdin", () => {
    const capped = createComposedRecallRequest({
      query: `  ${"q".repeat(1_500)}  `,
      scope: { project: "joelhooks.joelclaw", workstream: "main" },
      access: {
        principalRef: "service:test",
        purpose: "query-cap-test",
        allowedPrivacy: ["public"],
      },
    })
    expect(capped.text).toHaveLength(1_000)
    expect(capped.text).toBe("q".repeat(1_000))
  })

  test("places the exact request on stdin and never argv", async () => {
    let observedArgs: readonly string[] = []
    let observedStdin = ""
    const runner: RecallProcessRunner = async (input) => {
      observedArgs = input.args
      observedStdin = input.stdin
      return { exitCode: 0, signal: null, stdout: JSON.stringify(envelope()) }
    }

    await runComposedRecallCli({ request, runProcess: runner })
    expect(observedArgs).toEqual(["recall", "--request-file", "-"])
    expect(observedArgs.join(" ")).not.toContain(request.text)
    expect(observedStdin).toContain(request.text)
  })

  test("drains EPIPE when a child exits before private stdin is written", async () => {
    const root = mkdtempSync(join(tmpdir(), "recall-epipe-"))
    const executable = join(root, "early-exit-child")
    writeFileSync(executable, "#!/bin/sh\nexit 0\n")
    chmodSync(executable, 0o700)
    const result = await runRecallProcess({
      bin: executable,
      args: [],
      stdin: "x".repeat(2 * 1024 * 1024),
      timeoutMs: 1_000,
    })
    expect(result.exitCode).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  test("kills a SIGTERM-resistant process group within a bounded timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "recall-timeout-"))
    const executable = join(root, "resistant-child")
    writeFileSync(executable, "#!/bin/sh\ntrap '' TERM\n(sleep 30) &\nwait\n")
    chmodSync(executable, 0o700)
    const startedAt = Date.now()
    await expect(
      runRecallProcess({
        bin: executable,
        args: [],
        stdin: "{}",
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "RECALL_CLI_TIMEOUT" })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    rmSync(root, { recursive: true, force: true })
  })

  test("surfaces unavailable lane codes without echoing the query", async () => {
    const value = envelope() as unknown as {
      ok: boolean
      result: {
        composed: {
          lanes: Record<string, unknown>
          unavailable: unknown[]
        }
      }
    }
    const unavailable = {
      _tag: "RecallLaneUnavailableV1",
      code: "store-unavailable",
      lane: "curated-pages",
      message: "store unavailable",
      source: "critical-db-curated",
    }
    value.ok = false
    value.result.composed.lanes.curatedPages = unavailable
    value.result.composed.unavailable = [unavailable]

    await expect(
      runComposedRecallCli({
        request,
        runProcess: async () => ({ exitCode: 3, signal: null, stdout: JSON.stringify(value) }),
      }),
    ).rejects.toMatchObject({ code: "RECALL_LANE_UNAVAILABLE", exitCode: 3 })

    try {
      await runComposedRecallCli({
        request,
        runProcess: async () => ({ exitCode: 3, signal: null, stdout: JSON.stringify(value) }),
      })
    } catch (error) {
      expect(String(error)).not.toContain(request.text)
    }
  })
})
