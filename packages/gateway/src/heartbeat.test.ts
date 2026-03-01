import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __endpointResolverTestUtils } from "@joelclaw/endpoint-resolver";

const originalFetch = globalThis.fetch;

process.env.JOELCLAW_COLIMA_VM_IP = "10.10.10.10";

const { __heartbeatTestUtils } = await import("./heartbeat");
const { getTalonHealth } = __heartbeatTestUtils;

beforeEach(() => {
  __endpointResolverTestUtils.resetColimaVmIpCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gateway heartbeat talon health fallback", () => {
  test("falls back to vm endpoint and exposes endpoint class metadata", async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      calls.push(target);

      if (target === "http://127.0.0.1:9999/health") {
        throw new Error("connect ECONNREFUSED");
      }

      if (target === "http://10.10.10.10:9999/health") {
        return new Response('{"ok":true,"state":"healthy","failed_probe_count":0}', {
          status: 200,
        });
      }

      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const result = await getTalonHealth();

    expect(result.ok).toBe(true);
    expect(result.endpointClass).toBe("vm");
    expect(result.endpoint).toBe("http://10.10.10.10:9999/health");
    expect(result.skippedCandidates?.[0]?.endpointClass).toBe("localhost");
    expect(calls).toEqual([
      "http://127.0.0.1:9999/health",
      "http://10.10.10.10:9999/health",
    ]);
  });
});
