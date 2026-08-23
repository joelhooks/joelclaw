import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { RecallCliError } from "@joelclaw/recall"
import { buildPrefetchTelemetryMetadata, prefetchMemoryContext } from "./context-prefetch"

const callerFiles = [
  "../inngest/functions/check-email.ts",
  "../inngest/functions/o11y-triage.ts",
  "../inngest/functions/meeting-analyze.ts",
  "../inngest/functions/summarize.ts",
] as const

test("automatic recall callers name scope and access policy", () => {
  for (const relative of callerFiles) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8")
    expect(
      source.includes("runComposedRecallCli") || source.includes("prefetchMemoryContext"),
    ).toBe(true)
    expect(source).toContain("project:")
    expect(source).toContain("workstream:")
    expect(source).toContain("principalRef:")
    expect(source).toContain("purpose:")
    expect(source).toContain("allowedPrivacy:")
    expect(source).not.toContain('spawnSync("joelclaw", ["recall"')
  }
})

test("prefetch telemetry omits query and access bodies", () => {
  const metadata = buildPrefetchTelemetryMetadata(
    {
      scope: { project: "joelhooks.joelclaw", workstream: "main" },
      access: {
        principalRef: "service:sensitive-caller",
        purpose: "private-purpose",
        allowedPrivacy: ["public", "private"],
      },
    },
    5,
  )
  const encoded = JSON.stringify(metadata)
  expect(encoded).not.toContain("private-purpose")
  expect(encoded).not.toContain("sensitive-caller")
  expect(encoded).not.toContain("allowedPrivacy")
  expect(encoded).toContain("principalClass")
  expect(encoded).toContain("scopeHash")
})

test("automatic prefetch degrades to empty context and observes a redacted failure", async () => {
  const emitted: unknown[] = []
  const context = await prefetchMemoryContext(
    "query body must not reach telemetry",
    {
      scope: { project: "joelhooks.joelclaw", workstream: "main" },
      access: {
        principalRef: "service:automatic-test",
        purpose: "private-prefetch-purpose",
        allowedPrivacy: ["public", "private"],
      },
    },
    {
      runRecall: async () => {
        throw new RecallCliError({ code: "RECALL_LANE_UNAVAILABLE", exitCode: 3 })
      },
      emitTelemetry: (async (event: unknown) => {
        emitted.push(event)
      }) as never,
    },
  )

  expect(context).toBe("")
  expect(emitted).toHaveLength(1)
  const encoded = JSON.stringify(emitted)
  expect(encoded).toContain("memory.context_prefetch.failed")
  expect(encoded).toContain("RECALL_LANE_UNAVAILABLE")
  expect(encoded).not.toContain("query body")
  expect(encoded).not.toContain("private-prefetch-purpose")
  expect(encoded).not.toContain("automatic-test")
})

test("successful zero-item prefetch returns empty context without lane boilerplate", async () => {
  const context = await prefetchMemoryContext(
    "zero item query",
    {
      scope: { project: "joelhooks.joelclaw", workstream: "main" },
      access: {
        principalRef: "service:automatic-test",
        purpose: "zero-item-test",
        allowedPrivacy: ["public"],
      },
    },
    {
      runRecall: async () =>
        ({
          lanes: [
            {
              _tag: "available",
              name: "flowing-reflections",
              source: "flowing-memory-read-v1",
              health: "Healthy",
              items: [],
            },
            {
              _tag: "available",
              name: "flowing-observations",
              source: "flowing-memory-read-v1",
              health: "Healthy",
              items: [],
            },
            {
              _tag: "available",
              name: "curated-pages",
              source: "critical-db-curated",
              health: "Healthy",
              items: [],
            },
          ],
        }) as never,
      emitTelemetry: (async () => ({ success: true })) as never,
    },
  )
  expect(context).toBe("")
  expect(context).not.toContain("(no items)")
})

test("system-bus image includes the shared recall runtime package", () => {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8")
  expect(dockerfile).toContain("COPY --from=deps /app/packages/recall /app/packages/recall")
})

test("shared prefetch no longer reads the retired observation store", () => {
  const source = readFileSync(new URL("./context-prefetch.ts", import.meta.url), "utf8")
  expect(source).toContain("runComposedRecallCli")
  expect(source).not.toContain("memory_observations")
  expect(source).not.toContain("searchTypesenseWithCache")
})
