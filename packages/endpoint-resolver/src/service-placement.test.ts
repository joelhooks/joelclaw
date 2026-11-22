import { describe, expect, test } from "bun:test";
import { probeK8sHealth } from "./k8s-health";
import {
  parseServicePlacement,
  formatNotHostedHere,
  resolveServicePlacement,
  type ServicePlacementConfig,
} from "./service-placement";

const placement = {
  version: 1,
  hosts: [
    { hostname: "central-host", services: ["joelclaw-headless-runtime"] },
    { hostname: "k8s-host", services: ["k8s"] },
  ],
} as const satisfies ServicePlacementConfig;

describe("service placement", () => {
  test("maps k8s to k8s-host from config", () => {
    expect(resolveServicePlacement("k8s", "k8s-host.local", placement)).toEqual({
      service: "k8s",
      hostname: "k8s-host",
      hostedHere: true,
      hostedOn: ["k8s-host"],
    });
  });

  test("maps the headless runtime to central-host", () => {
    expect(resolveServicePlacement("joelclaw-headless-runtime", "central-host.localdomain", placement)).toEqual({
      service: "joelclaw-headless-runtime",
      hostname: "central-host",
      hostedHere: true,
      hostedOn: ["central-host"],
    });
  });

  test("leaves roles unassigned in an empty config", () => {
    const unassigned = parseServicePlacement({ version: 1, hosts: [] });
    expect(resolveServicePlacement("joelclaw-headless-runtime", "central-host", unassigned)).toMatchObject({
      hostedHere: false,
      hostedOn: [],
    });
    const k8s = resolveServicePlacement("k8s", "central-host", unassigned);
    expect(k8s).toMatchObject({ hostedHere: false, hostedOn: [] });
    expect(formatNotHostedHere(k8s)).toBe("not-hosted-here (hosted on: unassigned)");
  });

  test("rejects malformed private config", () => {
    expect(() => parseServicePlacement({ version: 1, hosts: [{ hostname: "central-host", services: ["unknown"] }] })).toThrow("Invalid service placement role");
    expect(() => parseServicePlacement({ version: 1, hosts: [{ hostname: "invalid host", services: ["k8s"] }] })).toThrow("Invalid service placement host entry");
  });

  test("reports a non-hosting machine as healthy context without running kubectl", () => {
    let kubectlRuns = 0;
    const result = probeK8sHealth({
      hostname: "central-host.localdomain",
      placement,
      runKubectl: () => {
        kubectlRuns += 1;
        throw new Error("must not run");
      },
    });

    expect(kubectlRuns).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      status: "not-hosted-here (hosted on: k8s-host)",
      detail: "not-hosted-here (hosted on: k8s-host)",
      hostname: "central-host",
      hostedOn: ["k8s-host"],
    });
    expect(formatNotHostedHere(resolveServicePlacement("k8s", "central-host", placement)))
      .toBe("not-hosted-here (hosted on: k8s-host)");
  });

  test("runs the existing local pod check on the hosting machine", () => {
    const result = probeK8sHealth({
      hostname: "k8s-host",
      placement,
      runKubectl: () => ({
        stdout: [
          "inngest-0 Running true",
          "completed-job Succeeded false",
          "redis-0 Running true",
        ].join("\n"),
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      status: "healthy",
      hostname: "k8s-host",
    });
  });
});
