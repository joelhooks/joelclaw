import { expect, test } from "bun:test"

import {
  buildDagNodeContentTelemetry,
  executeRecall,
  RESTATE_RECALL_UNAVAILABLE_MARKER,
} from "./workflows/dag-orchestrator"

test("Restate recall degrades explicitly when the CLI or store is absent", async () => {
  const result = await executeRecall(
    {
      query: "private restate query",
      scope: { project: "joelclaw-fleet", workstream: "default" },
      access: {
        principalRef: "service:restate-test",
        purpose: "restate-degrade-test",
        allowedPrivacy: ["public", "private"],
      },
    },
    1_000,
    async () => {
      throw Object.assign(new Error("missing joelclaw CLI"), { code: "ENOENT" })
    },
  )
  expect(result).toBe(RESTATE_RECALL_UNAVAILABLE_MARKER)
})

test("Restate research and contact OTEL task labels omit private inputs", () => {
  const recall = buildDagNodeContentTelemetry(
    "recall",
    "search agent memory for: private query body",
    "private record title and summary",
    "research",
  )
  const researchSibling = buildDagNodeContentTelemetry(
    "shell",
    "search the web for: private query body",
    undefined,
    "research",
  )
  const contactSibling = buildDagNodeContentTelemetry(
    "shell",
    "load existing contact file for Private Person",
    undefined,
    "enrich-contact:Private Person",
  )
  const encoded = JSON.stringify({ recall, researchSibling, contactSibling })
  expect(recall).toEqual({ task: "optional recall enrichment" })
  expect(researchSibling).toEqual({ task: "research pipeline node" })
  expect(contactSibling).toEqual({ task: "contact enrichment pipeline node" })
  expect(encoded).not.toContain("private query body")
  expect(encoded).not.toContain("Private Person")
  expect(encoded).not.toContain("private record title")
})
