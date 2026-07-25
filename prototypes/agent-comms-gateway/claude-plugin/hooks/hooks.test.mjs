import { expect, test } from "bun:test";
import { appendCompactionReceipt } from "./post-compact.mjs";
import { buildSessionStartContext, loadConversationSection } from "./session-start.mjs";

const root = new URL("..", import.meta.url).pathname;

function fatPending(n = 30) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `input-${i}`,
    kind: "message.requested",
    source: "inngest/check-system-health",
    recordedAt: Date.now() - i * 1000,
    payload: {
      text: `## 🚨 System Health Degradation\n\n- detail line ${i}\n- ${"x".repeat(400)}`,
      evidence: { huge: "y".repeat(800), nested: { a: 1, b: 2 } },
    },
  }));
}

test("SessionStart puts Joel ack first, then prompts, compact pending, herdr counts", async () => {
  const joel = {
    _id: "joel-1",
    kind: "inbound.received",
    source: "telegram",
    recordedAt: Date.now(),
    payload: { actorId: "7718912466", content: { text: "bing bong" } },
  };
  const pending = [fatPending(20)[0], joel, ...fatPending(10)];
  const context = await buildSessionStartContext({
    input: { session_id: "session-1", source: "startup" },
    root,
    now: Date.now(),
    stream: {
      bootstrap: async () => ({
        latestHandoff: { payload: { note: "advisory note" } },
        pending,
        pendingCompact: pending.map((event) => ({ id: event._id, kind: event.kind, text: "x", joel: event._id === "joel-1" })),
        ackRequiredJoel: ["joel-1"],
      }),
      readSince: async ({ recordedAt }) => {
        if (recordedAt === 0) {
          return {
            events: [
              { kind: "inbound.received", recordedAt: 1, payload: { actorId: "7718912466", content: { text: "older hi" } } },
              { kind: "gateway.decision.recorded", recordedAt: 2, payload: { rewrite: "hey" } },
            ],
          };
        }
        return { events: [] };
      },
    },
    herdr: {
      snapshot: async () => ({
        agents: { result: { agents: Array.from({ length: 8 }, (_, i) => ({ pane_id: `p${i}`, agent: "pi", agent_status: "idle", noise: "z".repeat(2000) })) } },
        panes: { result: { panes: Array.from({ length: 20 }, (_, i) => ({ pane_id: `p${i}`, label: `pane-${i}`, workspace_id: "w1", noise: "z".repeat(2000) })) } },
        capturedAt: new Date().toISOString(),
      }),
    },
  });

  expect(context.indexOf("JOEL NEEDS ACK FIRST")).toBeGreaterThan(-1);
  expect(context.indexOf("JOEL NEEDS ACK FIRST")).toBeLessThan(context.indexOf("prompts/identity.md"));
  expect(context.indexOf("prompts/identity.md")).toBeLessThan(context.indexOf("Latest gateway.handoff"));
  expect(context.indexOf("Latest gateway.handoff")).toBeLessThan(context.indexOf("Authoritative pending replay (compact)"));
  expect(context.indexOf("Authoritative pending replay (compact)")).toBeLessThan(context.indexOf("Herdr footprint (counts only)"));
  expect(context).toContain("advisory note");
  expect(context).toContain("joel-1");
  expect(context).toContain("bing bong");
  expect(context).toContain("agentCount");
  expect(context).not.toContain("\"noise\"");
  // Compact pending must stay far smaller than raw event dumps.
  expect(context.length).toBeLessThan(25_000);
});

test("conversation section widens past empty 24h until real exchanges appear", async () => {
  const calls = [];
  const stream = {
    readSince: async ({ recordedAt }) => {
      calls.push(recordedAt);
      // First windows empty; full history has the thread.
      if (recordedAt === 0) {
        return {
          events: [
            { kind: "inbound.received", recordedAt: 1_000, payload: { content: { data: { text: "old ping" } } } },
            { kind: "gateway.decision.recorded", recordedAt: 2_000, payload: { decision: { rewrite: "old pong nested" } } },
          ],
        };
      }
      return { events: [] };
    },
  };
  const section = await loadConversationSection(stream, { now: 10_000_000 });
  expect(section.empty).toBe(false);
  expect(section.lines.join("\n")).toContain("old ping");
  expect(section.lines.join("\n")).toContain("old pong nested");
  expect(calls.at(-1)).toBe(0);
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
