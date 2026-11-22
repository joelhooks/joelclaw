import { describe, expect, test } from "bun:test";
import type { ServicePlacementConfig } from "@joelclaw/endpoint-resolver";
import { buildPlacedKubectlCommand } from "./network-status-update";

const placement = {
  version: 1,
  hosts: [
    { hostname: "central-host", services: ["joelclaw-headless-runtime"] },
    { hostname: "k8s-host", services: ["k8s"] },
  ],
} satisfies ServicePlacementConfig;

const podArgs = ["get", "pods", "-n", "joelclaw"] as const;

describe("network/status-update Kubernetes placement", () => {
  test("runs kubectl over SSH on the configured k8s host from central-host", () => {
    expect(
      buildPlacedKubectlCommand(podArgs, {
        hostname: "central-host",
        placement,
        kubectlPath: "/opt/homebrew/bin/kubectl",
      })
    ).toEqual({
      command: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "k8s-host",
        "/opt/homebrew/bin/kubectl",
        ...podArgs,
      ],
      operatorHost: "k8s-host",
      hostedHere: false,
    });
  });

  test("runs local kubectl only on the configured k8s host", () => {
    expect(buildPlacedKubectlCommand(podArgs, { hostname: "k8s-host", placement })).toEqual({
      command: "kubectl",
      args: [...podArgs],
      operatorHost: "k8s-host",
      hostedHere: true,
    });
  });

  test("fails when k8s has no configured host", () => {
    const unassigned = {
      version: 1,
      hosts: [{ hostname: "central-host", services: ["joelclaw-headless-runtime"] }],
    } satisfies ServicePlacementConfig;

    expect(() =>
      buildPlacedKubectlCommand(podArgs, {
        hostname: "central-host",
        placement: unassigned,
      })
    ).toThrow("Kubernetes has no host in service-placement.json");
  });
});
