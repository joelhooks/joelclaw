import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { readPrivateRecallRequest } from "./recall"

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts")

const request = {
  _tag: "ComposedRecallRequestV1",
  access: {
    _tag: "RecallAccessV1",
    allowedPrivacy: ["public", "private"],
    decidedAt: "2026-08-23T00:00:00.000Z",
    principalRef: "service:test",
    purpose: "production-command-test",
  },
  includeSuperseded: false,
  limits: { curated: 2, observations: 2, reflections: 2 },
  schemaVersion: 1,
  scope: { _tag: "ProjectWorkstream", project: "joelhooks.joelclaw", workstream: "main" },
  text: "fixture-only private query",
}

describe("production recall command", () => {
  test("refuses interactive recall outside a trusted repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "recall-no-repo-"))
    const proc = spawnSync("bun", ["run", CLI_ENTRY, "recall", "fixture query"], {
      cwd,
      env: { ...process.env, HOME: cwd },
      encoding: "utf8",
    })
    expect(proc.status).toBe(1)
    const envelope = JSON.parse(proc.stdout)
    expect(envelope.error.code).toBe("RECALL_SCOPE_REQUIRED")
  })

  test("returns typed unavailable lanes with exit 3", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-unavailable-"))
    const proc = spawnSync("bun", ["run", CLI_ENTRY, "recall", "--request-file", "-"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        JOELCLAW_CRITICAL_DB: join(home, "missing-critical.db"),
        JOELCLAW_RECALL_OTEL: "0",
      },
      input: JSON.stringify(request),
      encoding: "utf8",
    })
    expect(proc.status).toBe(3)
    const envelope = JSON.parse(proc.stdout)
    expect(envelope.ok).toBe(false)
    expect(envelope.result.adapter).toBe("flowing-memory-recall")
    expect(
      envelope.result.composed.unavailable.map((item: { code: string }) => item.code),
    ).toContain("not-configured")
  })

  test("deprecated --limit is ignored and cannot widen composed lanes", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-limit-"))
    const proc = spawnSync(
      "bun",
      [
        "run",
        CLI_ENTRY,
        "recall",
        "fixture query",
        "--project",
        "joelhooks.joelclaw",
        "--workstream",
        "main",
        "--limit",
        "50",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          JOELCLAW_CRITICAL_DB: join(home, "missing-critical.db"),
          JOELCLAW_RECALL_OTEL: "0",
        },
        encoding: "utf8",
      },
    )
    expect(proc.status).toBe(3)
    const envelope = JSON.parse(proc.stdout)
    expect(envelope.result.composed.request.limits).toEqual({
      curated: 5,
      observations: 5,
      reflections: 5,
    })
    expect(envelope.result.compatibility).toEqual({
      deprecatedFlag: "--limit",
      disposition: "ignored",
      replacement: "--reflection-limit/--observation-limit/--curated-limit",
    })
  })

  test("invalid explicit lane limits return an accurate input code", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-invalid-limit-"))
    const proc = spawnSync(
      "bun",
      [
        "run",
        CLI_ENTRY,
        "recall",
        "fixture query",
        "--project",
        "joelhooks.joelclaw",
        "--workstream",
        "main",
        "--reflection-limit",
        "100",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, JOELCLAW_RECALL_OTEL: "0" },
        encoding: "utf8",
      },
    )
    expect(proc.status).toBe(1)
    const envelope = JSON.parse(proc.stdout)
    expect(envelope.error.code).toBe("RECALL_LIMIT_INVALID")
    expect(envelope.error.message).toContain("between 1 and 50")
  })

  test("refuses a request file that is not private", () => {
    const root = mkdtempSync(join(tmpdir(), "recall-request-mode-"))
    const path = join(root, "request.json")
    writeFileSync(path, JSON.stringify(request))
    chmodSync(path, 0o644)
    expect(() => readPrivateRecallRequest(path)).toThrow("must not be readable")
  })
})
