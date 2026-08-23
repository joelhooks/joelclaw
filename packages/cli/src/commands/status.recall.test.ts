import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildRecallStatus } from "./status"

test("status names actual composed lanes and warns on stale curated search", () => {
  const cwd = mkdtempSync(join(tmpdir(), "recall-status-"))
  const status = buildRecallStatus({
    cwd,
    now: new Date("2026-08-23T00:00:00.000Z"),
    resolveFlowingStatus: () => ({ ok: true }),
    readCuratedFreshness: () => ({
      builtAt: "2026-08-03T00:00:00.000Z",
      ageSeconds: 20 * 86_400,
      newestSourceAt: null,
      sourceAgeSeconds: null,
      documentCount: 1,
      status: "stale",
      sources: {},
      coverageGaps: [],
    }),
  })

  expect(status.adapter).toBe("flowing-memory-recall")
  expect(status.requestedLanes).toEqual([
    "flowing-reflections",
    "flowing-observations",
    "curated-pages",
  ])
  expect(status.answeringLanes).toEqual([
    "flowing-reflections",
    "flowing-observations",
    "curated-pages",
  ])
  expect(status.flowing.ok).toBe(true)
  expect(status.ok).toBe(true)
  expect(status.curated.warning).toContain("separate operator action")
})

test("dated rollback adapter warns without making global status red", () => {
  const cwd = mkdtempSync(join(tmpdir(), "recall-status-rollback-"))
  mkdirSync(join(cwd, ".joelclaw"), { recursive: true })
  writeFileSync(
    join(cwd, ".joelclaw", "config.toml"),
    '[capabilities.recall]\nadapter = "typesense-recall"\n',
  )
  const status = buildRecallStatus({
    cwd,
    readCuratedFreshness: () => {
      throw new Error("rollback does not require curated readiness")
    },
  })
  expect(status.adapter).toBe("typesense-recall")
  expect(status.ok).toBe(true)
  expect(status.degraded).toBe(true)
  expect(status.warning).toContain("rollback adapter is active")
  expect(status.answeringLanes).toEqual(["legacy-typesense-recall"])
})

test("fresh curated search cannot hide unconfigured flowing lanes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "recall-status-fresh-"))
  const status = buildRecallStatus({
    cwd,
    readCuratedFreshness: () => ({
      builtAt: "2026-08-23T00:00:00.000Z",
      ageSeconds: 1,
      newestSourceAt: null,
      sourceAgeSeconds: null,
      documentCount: 1,
      status: "ok",
      sources: {},
      coverageGaps: [],
    }),
  })
  expect(status.curated.ok).toBe(true)
  expect(status.flowing.ok).toBe(false)
  expect(status.ok).toBe(false)
  expect(status.answeringLanes).toEqual(["curated-pages"])
})
