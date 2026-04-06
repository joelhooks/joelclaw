import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __endpointResolverTestUtils } from "@joelclaw/endpoint-resolver";

const originalFetch = globalThis.fetch;

process.env.INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "test-event-key";
process.env.JOELCLAW_COLIMA_VM_IP = "10.10.10.10";

const { __inngestHealthTestUtils } = await import("./inngest");
const {
  probeServerHealth,
  probeWorkerHealth,
  resolveRunsGqlTimeoutMs,
  resolveDetailGqlTimeoutMs,
  resolveDetailGqlOptions,
} = __inngestHealthTestUtils;

beforeEach(() => {
  __endpointResolverTestUtils.resetColimaVmIpCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI health probes endpoint fallback", () => {
  test("server probe falls back to vm and reports endpoint class", async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      calls.push(target);

      if (target === "http://localhost:8288/health") {
        throw new Error("connect ECONNREFUSED");
      }

      if (target === "http://10.10.10.10:8288/health") {
        return new Response("healthy", { status: 200 });
      }

      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const result = await probeServerHealth();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("[vm]");
    expect(result.detail).toContain("skipped=1");
    expect(calls).toEqual([
      "http://localhost:8288/health",
      "http://10.10.10.10:8288/health",
    ]);
  });

  test("worker probe walks localhost paths before vm fallback", async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      calls.push(target);

      if (target.startsWith("http://localhost:3111")) {
        return new Response("down", { status: 503 });
      }

      if (target === "http://10.10.10.10:3111") {
        return new Response('{"status":"ok"}', { status: 200 });
      }

      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const result = await probeWorkerHealth();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("[vm]");
    expect(calls).toEqual([
      "http://localhost:3111",
      "http://localhost:3111/health",
      "http://localhost:3111/api/inngest",
      "http://10.10.10.10:3111",
    ]);
  });
});

describe("CLI runs timeout budgeting", () => {
  test("uses elevated timeout even for small run windows", () => {
    expect(resolveRunsGqlTimeoutMs(5)).toBeGreaterThanOrEqual(45000);
  });

  test("scales timeout upward for larger run queries", () => {
    expect(resolveRunsGqlTimeoutMs(50)).toBeGreaterThan(resolveRunsGqlTimeoutMs(10));
    expect(resolveRunsGqlTimeoutMs(300)).toBeGreaterThanOrEqual(resolveRunsGqlTimeoutMs(50));
  });
});

describe("CLI run detail timeout budgeting", () => {
  test("uses an elevated timeout for run and event detail queries", () => {
    expect(resolveDetailGqlTimeoutMs()).toBeGreaterThanOrEqual(75000);
  });

  test("retries detail queries with a larger second budget", () => {
    const options = resolveDetailGqlOptions();
    expect(options.retryTimeoutMs).toBeGreaterThan(options.timeoutMs);
  });
});
