import { describe, expect, test } from "bun:test";
import type { ServicePlacementConfig } from "@joelclaw/endpoint-resolver";
import { buildPlacedKubectlCommand } from "./network-status-update";

const placement = {
  version: 1,
  hosts: [
    { hostname: "flagg", services: ["joelclaw-headless-runtime"] },
    { hostname: "panda", services: ["k8s"] },
  ],
} satisfies ServicePlacementConfig;

const podArgs = ["get", "pods", "-n", "joelclaw"] as const;

describe("network/status-update Kubernetes placement", () => {
  test("runs kubectl over SSH on the configured k8s host from flagg", () => {
    expect(
      buildPlacedKubectlCommand(podArgs, {
        hostname: "flagg",
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
        "panda",
        "/opt/homebrew/bin/kubectl",
        ...podArgs,
      ],
      operatorHost: "panda",
      hostedHere: false,
    });
  });

  test("runs local kubectl only on the configured k8s host", () => {
    expect(buildPlacedKubectlCommand(podArgs, { hostname: "panda", placement })).toEqual({
      command: "kubectl",
      args: [...podArgs],
      operatorHost: "panda",
      hostedHere: true,
    });
  });

  test("fails when k8s has no configured host", () => {
    const unassigned = {
      version: 1,
      hosts: [{ hostname: "flagg", services: ["joelclaw-headless-runtime"] }],
    } satisfies ServicePlacementConfig;

    expect(() =>
      buildPlacedKubectlCommand(podArgs, {
        hostname: "flagg",
        placement: unassigned,
      })
    ).toThrow("Kubernetes has no host in service-placement.json");
  });
});
