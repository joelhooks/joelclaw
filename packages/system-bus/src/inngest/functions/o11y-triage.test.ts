import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import type { OtelEvent } from "../../observability/otel-event";

const emittedEvents: Array<Record<string, any>> = [];
const gatewayEvents: Array<Record<string, any>> = [];

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

const tier3Event: OtelEvent = {
  id: "evt-o11y-tier3",
  timestamp: Date.now(),
  level: "fatal",
  source: "worker",
  component: "tier3-test",
  action: "pipeline.stalled",
  success: false,
  error: "RUN_FAILED",
  metadata: {
    runId: "01RUNTEST",
  },
};

let mockScannedEvents: OtelEvent[] = [tier1Event];
let mockTier1: OtelEvent[] = [tier1Event];
let mockTier2: OtelEvent[] = [];
let mockTier3: OtelEvent[] = [];

mock.module("node:child_process", () => ({
  execSync: () => "",
}));

mock.module("../../observability/emit", () => ({
  emitOtelEvent: async (event: Record<string, any>) => {
    emittedEvents.push(event);
  },
}));

mock.module("../../observability/triage", () => ({
  scanRecentFailures: async () => mockScannedEvents,
  triageFailures: async () => ({
    tier1: mockTier1,
    tier2: mockTier2,
    tier3: mockTier3,
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

mock.module("./agent-loop/utils", () => ({
  pushGatewayEvent: async (event: Record<string, unknown>) => {
    gatewayEvents.push(event as Record<string, any>);
    return { id: "evt-test" };
  },
}));

describe("o11y triage runbook metadata", () => {
  beforeEach(() => {
    emittedEvents.length = 0;
    gatewayEvents.length = 0;

    mockScannedEvents = [tier1Event];
    mockTier1 = [tier1Event];
    mockTier2 = [];
    mockTier3 = [];
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

  test("threads runbook metadata into tier3 escalated OTEL and telegram payload", async () => {
    mockScannedEvents = [tier3Event];
    mockTier1 = [];
    mockTier2 = [];
    mockTier3 = [tier3Event];

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

    const escalated = emittedEvents.find((event) => event.action === "triage.escalated");
    expect(escalated).toBeTruthy();
    expect(escalated?.metadata?.runbookCode).toBe("RUN_FAILED");
    expect(escalated?.metadata?.runbookPhase).toBe("diagnose");
    expect(escalated?.metadata?.recoverCommand).toBe(
      "joelclaw recover RUN_FAILED --phase diagnose"
    );
    expect(Array.isArray(escalated?.metadata?.runbookCommands)).toBe(true);
    expect(escalated?.metadata?.runbookCommands?.length).toBeGreaterThan(0);

    const telegramSent = emittedEvents.find((event) => event.action === "triage.telegram_sent");
    expect(telegramSent).toBeTruthy();
    expect(telegramSent?.metadata?.runbookCode).toBe("RUN_FAILED");
    expect(telegramSent?.metadata?.recoverCommand).toBe(
      "joelclaw recover RUN_FAILED --phase diagnose"
    );

    const alertEvent = gatewayEvents.find((event) => event.type === "alert");
    expect(alertEvent).toBeTruthy();
    expect(alertEvent?.payload?.runbookCode).toBe("RUN_FAILED");
    expect(alertEvent?.payload?.runbookPhase).toBe("diagnose");
    expect(alertEvent?.payload?.recoverCommand).toBe(
      "joelclaw recover RUN_FAILED --phase diagnose"
    );
  });
});
