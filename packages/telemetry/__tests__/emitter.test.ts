import { describe, expect, test, vi } from "vitest";
import type { GatewayOtelLevel, TelemetryEmitter } from "..";
import {
  createChannelDeliveryAudit,
  createGatewayEmitter,
  emitGatewayOtel,
  fingerprintChannelContent,
  summarizeChannelError,
} from "../src";

describe("telemetry package", () => {
  test("createGatewayEmitter returns a TelemetryEmitter", () => {
    const emitter: TelemetryEmitter = createGatewayEmitter("gateway");
    expect(typeof emitter.emit).toBe("function");
  });

  test("GatewayOtelLevel includes expected values", () => {
    const levels: GatewayOtelLevel[] = ["debug", "info", "warn", "error", "fatal"];
    expect(levels).toContain("info");
  });

  test("fingerprints content without retaining message text", () => {
    const fingerprint = fingerprintChannelContent("hello 🐀");

    expect(fingerprint).toEqual({
      contentHash: "6301c916436f331594ed0c1011c65d4146abffa79d1be052bea886dac06e49ff",
      contentChars: 7,
      contentBytes: 10,
    });
    expect(JSON.stringify(fingerprint)).not.toContain("hello");
  });

  test("summarizes provider errors without retaining request content", () => {
    const summary = summarizeChannelError({
      name: "GrammyError",
      error_code: 400,
      description: "Bad Request: can't parse entities",
      message: "request contained private Telegram body",
    });

    expect(summary).toBe("GrammyError:400");
    expect(summary).not.toContain("private Telegram body");
    expect(summarizeChannelError("private Telegram body")).toBe("channel_delivery_error");
  });

  test("preserves a flow id and producer across channel hops", () => {
    const audit = createChannelDeliveryAudit("private message", {
      flowId: "flow-123",
      producer: "queue-observer",
      originSystemId: "panda",
      eventId: "event-456",
      requestedAtMs: 1_000,
      queuedAtMs: 1_250,
      route: "redis-outbound",
    }, 2_000);

    expect(audit).toMatchObject({
      schemaVersion: 1,
      flowId: "flow-123",
      producer: "queue-observer",
      originSystemId: "panda",
      eventId: "event-456",
      requestedAtMs: 1_000,
      queuedAtMs: 1_250,
      route: "redis-outbound",
      contentChars: 15,
      contentBytes: 15,
    });
    expect(JSON.stringify(audit)).not.toContain("private message");
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
      systemId: "flagg",
      component: "gateway",
      action: "telemetry.url.fallback",
      success: true,
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body.systemId).toBe("flagg");

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
