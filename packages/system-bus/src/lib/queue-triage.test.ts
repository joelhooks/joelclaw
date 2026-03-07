import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Priority, type QueueEventEnvelope } from "@joelclaw/queue";

const inferredPrompts: string[] = [];
const emittedEvents: Array<Record<string, unknown>> = [];
let inferResponse: { text: string; model?: string } | null = null;
let inferError: Error | null = null;

mock.module(new URL("./inference.ts", import.meta.url).pathname, () => ({
  infer: async (prompt: string) => {
    inferredPrompts.push(prompt);
    if (inferError) throw inferError;
    return inferResponse ?? { text: "{}", model: "anthropic/claude-haiku-4-5" };
  },
}));

mock.module(new URL("../observability/emit.ts", import.meta.url).pathname, () => ({
  emitOtelEvent: async (event: Record<string, unknown>) => {
    emittedEvents.push(event);
  },
}));

const buildEnvelope = (): QueueEventEnvelope<Record<string, unknown>> => ({
  id: "evt-queue-triage",
  name: "discovery/noted",
  source: "test",
  ts: 1_742_000_000_000,
  data: {
    url: "https://example.com/triage",
    title: "Example",
  },
  priority: Priority.P2,
  trace: {
    correlationId: "corr-queue-triage",
  },
});

describe("queue triage contract", () => {
  beforeEach(() => {
    inferredPrompts.length = 0;
    emittedEvents.length = 0;
    inferResponse = { text: JSON.stringify({
      priority: "P1",
      dedupKey: "discovery:https://example.com/triage",
      routeCheck: "confirm",
      reasoning: "Discovery URLs with clear identity can be nudged up slightly.",
    }) };
    inferError = null;
  });

  test("parses valid bounded queue triage output", async () => {
    const { __queueTriageTestUtils } = await import("./queue-triage");
    const parsed = __queueTriageTestUtils.parseQueueTriageOutput(JSON.stringify({
      priority: "P0",
      dedupKey: "github:workflow:123",
      routeCheck: "mismatch",
      reasoning: "Workflow completion may need faster attention.",
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.priority).toBe("P0");
      expect(parsed.value.routeCheck).toBe("mismatch");
    }
  });

  test("rejects unsafe route override attempts with canonical fallback reason", async () => {
    const { __queueTriageTestUtils } = await import("./queue-triage");
    const parsed = __queueTriageTestUtils.parseQueueTriageOutput(JSON.stringify({
      priority: "P1",
      dedupKey: null,
      routeCheck: "mismatch",
      reasoning: "The route looks wrong.",
      routeTarget: "github/other.event",
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("unsafe_override");
      expect(parsed.error).toContain("routeTarget");
    }
  });

  test("maps timeout-looking errors to the canonical timeout fallback reason", async () => {
    const { __queueTriageTestUtils } = await import("./queue-triage");
    expect(__queueTriageTestUtils.fallbackReasonFromError(new Error("pi timed out after 45000ms"))).toBe("timeout");
    expect(__queueTriageTestUtils.fallbackReasonFromError(new Error("something else broke"))).toBe("model_error");
  });

  test("shadow mode keeps registry priority but records the suggested decision and OTEL vocabulary", async () => {
    const { triageQueueEvent } = await import("./queue-triage");
    const decision = await triageQueueEvent({
      mode: "shadow",
      envelope: buildEnvelope(),
      dedupKey: "registry:dedup",
    });

    expect(inferredPrompts).toHaveLength(1);
    expect(inferredPrompts[0]).toContain("Queue family: discovery/noted");
    expect(decision.mode).toBe("shadow");
    expect(decision.suggested.priority).toBe("P1");
    expect(decision.final.priority).toBe("P2");
    expect(decision.applied).toBe(false);
    expect(decision.final.routeCheck).toBe("confirm");

    const actions = emittedEvents.map((event) => event.action);
    expect(actions).toEqual(["queue.triage.started", "queue.triage.completed"]);

    const completed = emittedEvents.find((event) => event.action === "queue.triage.completed");
    expect(completed?.metadata).toMatchObject({
      eventId: "evt-queue-triage",
      correlationId: "corr-queue-triage",
      family: "discovery/noted",
      suggestedPriority: "P1",
      finalPriority: "P2",
      applied: false,
    });
  });

  test("returns schema_error fallback and emits failed + fallback OTEL when the model shape is wrong", async () => {
    inferResponse = {
      text: JSON.stringify({
        priority: "P9",
        dedupKey: null,
        routeCheck: "confirm",
        reasoning: "bad priority",
      }),
    };

    const { triageQueueEvent } = await import("./queue-triage");
    const decision = await triageQueueEvent({
      mode: "enforce",
      envelope: buildEnvelope(),
    });

    expect(decision.fallbackReason).toBe("schema_error");
    expect(decision.applied).toBe(false);
    expect(decision.final.priority).toBe("P2");

    const actions = emittedEvents.map((event) => event.action);
    expect(actions).toEqual(["queue.triage.started", "queue.triage.failed", "queue.triage.fallback"]);
  });
});
