import { expect, test } from "bun:test";
import { appendCompactionReceipt } from "./post-compact.mjs";
import { buildSessionStartContext } from "./session-start.mjs";

const root = new URL("..", import.meta.url).pathname;

test("SessionStart orders advisory handoff before authoritative replay and fresh Herdr state", async () => {
  const context = await buildSessionStartContext({
    input: { session_id: "session-1", source: "startup" },
    root,
    stream: {
      bootstrap: async () => ({
        latestHandoff: { payload: { note: "advisory note" } },
        pending: [{ _id: "input-1", kind: "message.requested" }],
      }),
    },
    herdr: { snapshot: async () => ({ agents: [{ pane_id: "p1" }] }) },
  });
  expect(context.indexOf("prompts/identity.md")).toBeLessThan(context.indexOf("Latest gateway.handoff"));
  expect(context.indexOf("Latest gateway.handoff")).toBeLessThan(context.indexOf("Authoritative pending replay"));
  expect(context.indexOf("Authoritative pending replay")).toBeLessThan(context.indexOf("Fresh Herdr snapshot"));
  expect(context).toContain("advisory note");
  expect(context).toContain("input-1");
});

test("PostCompact emits a silent OTEL receipt", async () => {
  const calls = [];
  const receipt = await appendCompactionReceipt(
    { session_id: "session-1", trigger: "auto", hook_event_name: "PostCompact" },
    { run: async (args) => { calls.push(args); return ""; } },
  );
  expect(receipt.sessionId).toBe("session-1");
  expect(calls[0]).toContain("gateway.compaction.recorded");
});
