import { describe, expect, test } from "bun:test";
import {
  buildServiceHealthCandidates,
  DEFAULT_COLIMA_VM_IP,
  discoverColimaVmIp,
  resolveEndpoint,
} from "../resolver";

describe("endpoint resolver candidate ordering", () => {
  test("builds candidates in ADR-0182 order", () => {
    const candidates = buildServiceHealthCandidates("inngest", {
      vmIp: "10.10.10.10",
    });

    expect(candidates.map((candidate) => candidate.endpointClass)).toEqual([
      "localhost",
      "vm",
      "svc_dns",
    ]);

    expect(candidates[0]?.probeUrls).toEqual(["http://localhost:8288/health"]);
    expect(candidates[1]?.probeUrls).toEqual(["http://10.10.10.10:8288/health"]);
    expect(candidates[2]?.probeUrls).toEqual([
      "http://inngest-svc.joelclaw.svc.cluster.local:8288/health",
    ]);
  });

  test("uses fallback vm ip when discovery fails", () => {
    const vmIp = discoverColimaVmIp({
      env: {},
      bypassCache: true,
      commandRunner: () => null,
    });

    expect(vmIp).toBe(DEFAULT_COLIMA_VM_IP);
  });
});

describe("endpoint resolver fallback behavior", () => {
  test("falls back from localhost to vm and records skipped reason", async () => {
    const calls: string[] = [];
    const candidates = buildServiceHealthCandidates("typesense", {
      vmIp: "10.10.10.10",
    });

    const resolution = await resolveEndpoint(candidates, {
      timeoutMs: 50,
      fetchImpl: (async (url: string | URL) => {
        const target = String(url);
        calls.push(target);

        if (target.includes("localhost")) {
          throw new Error("connect ECONNREFUSED");
        }

        if (target.includes("10.10.10.10")) {
          return new Response('{"ok":true}', { status: 200 });
        }

        return new Response("down", { status: 503 });
      }) as typeof fetch,
    });

    expect(calls).toEqual([
      "http://localhost:8108/health",
      "http://10.10.10.10:8108/health",
    ]);

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.endpointClass).toBe("vm");
    expect(resolution.probeUrl).toBe("http://10.10.10.10:8108/health");
    expect(resolution.skippedCandidates).toHaveLength(1);
    expect(resolution.skippedCandidates[0]?.endpointClass).toBe("localhost");
    expect(resolution.skippedCandidates[0]?.reason).toContain("ECONNREFUSED");
  });

  test("returns failure summary when all candidates fail", async () => {
    const candidates = buildServiceHealthCandidates("inngest", {
      vmIp: "10.10.10.10",
    });

    const resolution = await resolveEndpoint(candidates, {
      timeoutMs: 50,
      fetchImpl: (async () => new Response("unhealthy", { status: 503 })) as typeof fetch,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    expect(resolution.reason).toContain("localhost");
    expect(resolution.reason).toContain("vm");
    expect(resolution.reason).toContain("svc_dns");
    expect(resolution.skippedCandidates).toHaveLength(3);
  });
});
