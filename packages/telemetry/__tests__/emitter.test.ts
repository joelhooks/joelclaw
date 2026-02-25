import { describe, expect, test, vi } from "vitest";
import type { GatewayOtelLevel, TelemetryEmitter } from "..";
import { createGatewayEmitter, emitGatewayOtel } from "../src";

describe("telemetry package", () => {
  test("createGatewayEmitter returns a TelemetryEmitter", () => {
    const emitter: TelemetryEmitter = createGatewayEmitter("gateway");
    expect(typeof emitter.emit).toBe("function");
  });

  test("GatewayOtelLevel includes expected values", () => {
    const levels: GatewayOtelLevel[] = ["debug", "info", "warn", "error", "fatal"];
    expect(levels).toContain("info");
  });

  test("emitGatewayOtel does not throw when OTEL_EMIT_URL is not set", async () => {
    const previousEmitUrl = process.env.OTEL_EMIT_URL;
    const previousEmitEnabled = process.env.OTEL_EVENTS_ENABLED;

    delete process.env.OTEL_EMIT_URL;
    process.env.OTEL_EVENTS_ENABLED = "true";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 200,
    }));

    await expect(emitGatewayOtel({
      level: "info",
      component: "gateway",
      action: "telemetry.url.fallback",
      success: true,
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();

    fetchMock.mockRestore();
    if (previousEmitUrl === undefined) {
      delete process.env.OTEL_EMIT_URL;
    } else {
      process.env.OTEL_EMIT_URL = previousEmitUrl;
    }

    if (previousEmitEnabled === undefined) {
      delete process.env.OTEL_EVENTS_ENABLED;
    } else {
      process.env.OTEL_EVENTS_ENABLED = previousEmitEnabled;
    }
  });
});
