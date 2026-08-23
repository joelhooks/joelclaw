import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createJoelclawClient } from "./client"

function fakeRecallCli(): string {
  const root = mkdtempSync(join(tmpdir(), "sdk-recall-cli-"))
  const path = join(root, "joelclaw")
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const raw = await Bun.stdin.text();
const request = JSON.parse(raw);
if (process.argv.join(" ").includes(request.text)) process.exit(9);
const lane = (name, source) => ({
  _tag: "RecallLaneAvailableV1",
  health: { _tag: "Healthy" },
  items: [],
  lane: name,
  scoreScale: name === "curated-pages" ? "bm25-negated" : "unit-interval",
  source,
});
console.log(JSON.stringify({
  ok: true,
  command: "joelclaw recall",
  result: {
    adapter: "flowing-memory-recall",
    composed: {
      _tag: "ComposedRecallResultV1",
      lanes: {
        curatedPages: lane("curated-pages", "critical-db-curated"),
        flowingObservations: lane("flowing-observations", "flowing-memory-read-v1"),
        flowingReflections: lane("flowing-reflections", "flowing-memory-read-v1"),
      },
      request,
      resolvedAccess: request.access,
      resolvedScope: request.scope,
      schemaVersion: 1,
      unavailable: [],
    },
  },
  next_actions: [],
}));
`,
  )
  chmodSync(path, 0o700)
  return path
}

describe("SDK recall convergence", () => {
  test("uses the CLI composition root through private stdin even in inprocess mode", async () => {
    const client = createJoelclawClient({ bin: fakeRecallCli(), transport: "inprocess" })
    const envelope = await client.recall<{ adapter: string }>("sdk private query", {
      project: "joelhooks.joelclaw",
      workstream: "main",
      principalRef: "service:sdk-test",
      purpose: "sdk-convergence-test",
      allowedPrivacy: ["public", "private"],
    })
    expect(envelope.ok).toBe(true)
    expect(envelope.result.adapter).toBe("flowing-memory-recall")
  })
})
