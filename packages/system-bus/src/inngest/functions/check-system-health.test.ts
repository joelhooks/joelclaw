import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __endpointResolverTestUtils } from "@joelclaw/endpoint-resolver";
import {
  __checkSystemHealthTestUtils,
  resolveHealthCheckMode,
  shouldSkipHealthCheckSchedule,
} from "./check-system-health";

const originalFetch = globalThis.fetch;
const { checkWebhooks, classifyHealthSummary, interpretAgentSecretsStatus } =
  __checkSystemHealthTestUtils;

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

describe("check/system-health schedule gate", () => {
  test("defaults scheduled canary mode to off", () => {
    expect(__checkSystemHealthTestUtils.resolveHealthCanaryScheduleMode(undefined)).toBe("off");
    expect(__checkSystemHealthTestUtils.resolveHealthCanaryScheduleMode("garbage")).toBe("off");
  });

  test("accepts scheduled canary signals mode", () => {
    expect(__checkSystemHealthTestUtils.resolveHealthCanaryScheduleMode("signals")).toBe("signals");
  });

  test("skips when last run was healthy within 45 minutes", () => {
    const now = Date.now();
    const shouldSkip = shouldSkipHealthCheckSchedule({
      now,
      lastCheckTimestamp: now - 20 * 60 * 1000,
      lastResult: "healthy",
    });

    expect(shouldSkip).toBe(true);
  });

  test("does not skip when last run was degraded", () => {
    const now = Date.now();
    const shouldSkip = shouldSkipHealthCheckSchedule({
      now,
      lastCheckTimestamp: now - 20 * 60 * 1000,
      lastResult: "degraded",
    });

    expect(shouldSkip).toBe(false);
  });

  test("does not skip when last healthy run is stale", () => {
    const now = Date.now();
    const shouldSkip = shouldSkipHealthCheckSchedule({
      now,
      lastCheckTimestamp: now - 50 * 60 * 1000,
      lastResult: "healthy",
    });

    expect(shouldSkip).toBe(false);
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

  test("webhook check falls back to vm worker webhook endpoint", async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      calls.push(target);

      if (target.startsWith("http://localhost:3111/webhooks")) {
        throw new Error("connect ECONNREFUSED");
      }

      if (target === "http://10.10.10.10:3111/webhooks") {
        return new Response(
          '{"service":"webhook-gateway","status":"running","providers":["github","vercel"]}',
          { status: 200 },
        );
      }

      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const result = await checkWebhooks();

    expect(result.ok).toBe(true);
    expect(result.endpointClass).toBe("vm");
    expect(result.detail).toContain("[vm]");
    expect(result.detail).toContain("providers: github, vercel");
    expect(calls).toEqual([
      "http://localhost:3111/webhooks",
      "http://10.10.10.10:3111/webhooks",
    ]);
  });
});

describe("check/system-health summary classification", () => {
  test("treats non-critical degradation as warn-but-successful", () => {
    const result = classifyHealthSummary({
      services: [
        { name: "NFS Mounts", ok: false, detail: "nas-nvme: missing, three-body: ok" },
        { name: "Redis", ok: true },
      ],
      agentDispatchCanary: null,
    });

    expect(result.degradedCount).toBe(1);
    expect(result.criticalDegradedCount).toBe(0);
    expect(result.nonCriticalDegradedCount).toBe(1);
    expect(result.nonCriticalDegradedServices).toEqual(["NFS Mounts"]);
    expect(result.hasCriticalDegradation).toBe(false);
  });

  test("treats critical services and canary failures as failed health summaries", () => {
    const result = classifyHealthSummary({
      services: [
        { name: "Worker", ok: false, detail: "unreachable" },
        { name: "NFS Mounts", ok: false, detail: "nas-nvme: missing" },
      ],
      agentDispatchCanary: {
        enabled: true,
        ok: false,
        summary: "agent-dispatch timeout canary returned unexpected truth",
        error: "terminal=completed registry=running",
      },
    });

    expect(result.degradedCount).toBe(3);
    expect(result.criticalDegradedCount).toBe(2);
    expect(result.nonCriticalDegradedCount).toBe(1);
    expect(result.criticalDegradedServices).toEqual(["Worker", "Agent Dispatch Canary"]);
    expect(result.hasCriticalDegradation).toBe(true);
  });
});

describe("check/system-health agent secrets parsing", () => {
  test("treats secrets status running payload as healthy", () => {
    const result = interpretAgentSecretsStatus({
      status: 0,
      stdout: JSON.stringify({ result: { running: true, active_leases: 27 } }),
      stderr: "",
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("27 active leases");
  });

  test("surfaces status error payload as degraded", () => {
    const result = interpretAgentSecretsStatus({
      status: 1,
      stdout: JSON.stringify({ error: { message: "daemon unresponsive (timeout after 5s)" } }),
      stderr: "Error: failed to get health report",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("failed to get health report");
  });
});
