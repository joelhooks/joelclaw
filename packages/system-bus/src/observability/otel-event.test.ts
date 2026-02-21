import { describe, expect, test } from "bun:test";
import { assertOtelEvent, createOtelEvent } from "./otel-event";

describe("otel-event contract", () => {
  test("creates a valid event with defaults", () => {
    const event = createOtelEvent({
      level: "info",
      source: "worker",
      component: "serve",
      action: "worker.started",
      success: true,
    });

    expect(event.id.length).toBeGreaterThan(10);
    expect(typeof event.timestamp).toBe("number");
    expect(event.metadata).toEqual({});
    expect(() => assertOtelEvent(event)).not.toThrow();
  });

  test("auto-fills error for failed events", () => {
    const event = createOtelEvent({
      level: "error",
      source: "worker",
      component: "check-system-health",
      action: "health.failed",
      success: false,
    });
    expect(event.error).toBe("operation_failed");
  });

  test("throws on invalid input", () => {
    expect(() =>
      createOtelEvent({
        // @ts-expect-error intentionally invalid
        level: "meh",
        source: "worker",
        component: "observe",
        action: "x",
        success: true,
      })
    ).toThrow();

    expect(() =>
      assertOtelEvent({
        id: "a",
        timestamp: "bad",
        level: "info",
        source: "worker",
        component: "serve",
        action: "x",
        success: true,
        metadata: {},
      })
    ).toThrow();
  });
});

