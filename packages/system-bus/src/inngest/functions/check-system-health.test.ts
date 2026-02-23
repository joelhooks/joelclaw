import { describe, expect, test } from "bun:test";
import { resolveHealthCheckMode } from "./check-system-health";

describe("check/system-health mode resolution", () => {
  test("defaults heartbeat requests to core mode", () => {
    const mode = resolveHealthCheckMode("system/health.requested", undefined);
    expect(mode).toBe("core");
  });

  test("defaults direct checks to full mode", () => {
    const mode = resolveHealthCheckMode("system/health.check", undefined);
    expect(mode).toBe("full");
  });

  test("accepts explicit supported modes", () => {
    const core = resolveHealthCheckMode("system/health.requested", "core");
    const signals = resolveHealthCheckMode("system/health.requested", "signals");
    const full = resolveHealthCheckMode("system/health.requested", "full");
    expect(core).toBe("core");
    expect(signals).toBe("signals");
    expect(full).toBe("full");
  });
});
