import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import type { OtelEvent } from "../../observability/otel-event";

const emittedEvents: Array<Record<string, any>> = [];

const tier1Event: OtelEvent = {
  id: "evt-o11y-tier1",
  timestamp: Date.now(),
  level: "error",
  source: "worker",
  component: "triage-test",
  action: "probe.emit",
  success: false,
  error: "probe transient failure",
  metadata: {},
};

mock.module("../../observability/emit", () => ({
  emitOtelEvent: async (event: Record<string, any>) => {
    emittedEvents.push(event);
  },
}));

mock.module("../../observability/triage", () => ({
  scanRecentFailures: async () => [tier1Event],
  triageFailures: async () => ({
    tier1: [tier1Event],
    tier2: [],
    tier3: [],
    unmatchedTier2: [],
  }),
  classifyWithLLM: async () => [],
}));

mock.module("../../memory/context-prefetch", () => ({
  prefetchMemoryContext: async () => "",
}));

mock.module("../../lib/typesense", () => ({
  search: async () => ({ found: 0, hits: [] }),
}));

describe("o11y triage runbook metadata", () => {
  beforeEach(() => {
    emittedEvents.length = 0;
  });

  test("emits auto_fix.applied with runbookCode and recoverCommand metadata", async () => {
    const { o11yTriage } = await import("./o11y-triage");

    const engine = new InngestTestEngine({
      function: o11yTriage as any,
      events: [
        {
          name: "inngest/scheduled.timer",
          data: { cron: "TZ=America/Los_Angeles */15 * * * *" },
        } as any,
      ],
    });

    await engine.execute();

    const autoFixApplied = emittedEvents.find((event) => event.action === "auto_fix.applied");

    expect(autoFixApplied).toBeTruthy();
    expect(autoFixApplied?.metadata?.runbookCode).toBe("NO_ACTIVE_LOOP");
    expect(autoFixApplied?.metadata?.recoverCommand).toBe(
      "joelclaw recover NO_ACTIVE_LOOP --phase diagnose"
    );
    expect(Array.isArray(autoFixApplied?.metadata?.runbookCommands)).toBe(true);
    expect(autoFixApplied?.metadata?.runbookCommands?.length).toBeGreaterThan(0);
  });
});
