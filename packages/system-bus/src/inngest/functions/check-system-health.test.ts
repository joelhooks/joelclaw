import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __endpointResolverTestUtils } from "@joelclaw/endpoint-resolver";
import {
  __checkSystemHealthTestUtils,
  resolveHealthCheckMode,
} from "./check-system-health";

const originalFetch = globalThis.fetch;

process.env.JOELCLAW_COLIMA_VM_IP = "10.10.10.10";

beforeEach(() => {
  __endpointResolverTestUtils.resetColimaVmIpCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe("check/system-health endpoint fallback", () => {
  test("inngest check falls back to service dns and exposes endpoint class", async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      calls.push(target);

      if (target !== "http://inngest-svc.joelclaw.svc.cluster.local:8288/health") {
        return new Response("down", { status: 503 });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const result = await __checkSystemHealthTestUtils.checkInngest();

    expect(result.ok).toBe(true);
    expect(result.endpointClass).toBe("svc_dns");
    expect(result.detail).toContain("[svc_dns]");
    expect(calls).toEqual([
      "http://localhost:8288/health",
      "http://10.10.10.10:8288/health",
      "http://inngest-svc.joelclaw.svc.cluster.local:8288/health",
    ]);
  });

  test("typesense check reports vm endpoint metadata on fallback", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      if (target === "http://10.10.10.10:8108/health") {
        return new Response('{"ok":true}', { status: 200 });
      }
      if (target.startsWith("http://localhost:8108")) {
        throw new Error("connect ECONNREFUSED");
      }
      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const result = await __checkSystemHealthTestUtils.checkTypesense();

    expect(result.ok).toBe(true);
    expect(result.endpointClass).toBe("vm");
    expect(result.detail).toContain("[vm]");
  });
});
