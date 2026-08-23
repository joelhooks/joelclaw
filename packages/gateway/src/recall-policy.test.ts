import { expect, test } from "bun:test"
import { type ParsedComposedRecall, RecallCliError } from "@joelclaw/recall"
import {
  buildGatewayRecallSection,
  DISCORD_PUBLIC_RECALL_POLICY,
  GATEWAY_RECALL_UNAVAILABLE_MARKER,
} from "./recall-enrichment"

const emptyRecall = {
  ok: true,
  envelope: {},
  scope: { project: "joelclaw-fleet", workstream: "default" },
  access: {
    principalRef: "service:gateway",
    purpose: "gateway-prompt-enrichment",
    allowedPrivacy: ["public", "private"],
    decidedAt: "2026-08-23T00:00:00.000Z",
  },
  lanes: [
    {
      _tag: "available",
      name: "flowing-reflections",
      source: "flowing-memory-read-v1",
      health: "Healthy",
      scoreScale: "unit-interval",
      items: [],
    },
    {
      _tag: "available",
      name: "flowing-observations",
      source: "flowing-memory-read-v1",
      health: "Healthy",
      scoreScale: "unit-interval",
      items: [],
    },
    {
      _tag: "available",
      name: "curated-pages",
      source: "critical-db-curated",
      health: "Healthy",
      scoreScale: "bm25-negated",
      items: [],
    },
  ],
  unavailable: [],
} as unknown as ParsedComposedRecall

test("gateway failure adds a generic prompt marker and redacted telemetry", async () => {
  const emitted: unknown[] = []
  const result = await buildGatewayRecallSection("private gateway query", {
    runRecall: async () => {
      throw new RecallCliError({ code: "RECALL_LANE_UNAVAILABLE", exitCode: 3 })
    },
    emitTelemetry: async (event) => {
      emitted.push(event)
    },
  })

  expect(result).toBe(GATEWAY_RECALL_UNAVAILABLE_MARKER)
  const encoded = JSON.stringify(emitted)
  expect(encoded).toContain("memory.recall.failed")
  expect(encoded).toContain("RECALL_LANE_UNAVAILABLE")
  expect(encoded).not.toContain("private gateway query")
  expect(encoded).not.toContain("gateway-prompt-enrichment")
})

test("gateway emits no lane boilerplate when recall has no items", async () => {
  const result = await buildGatewayRecallSection("empty recall", {
    runRecall: async () => emptyRecall,
  })
  expect(result).toBe("")
})

test("Discord public recall policy is explicit", () => {
  expect(DISCORD_PUBLIC_RECALL_POLICY).toEqual({
    scope: { project: "joelclaw-fleet", workstream: "default" },
    access: {
      principalRef: "service:discord-recall",
      purpose: "discord-public-recall",
      allowedPrivacy: ["public"],
    },
  })
})
