import { describe, expect, test } from "bun:test";
import { probeK8sHealth } from "./k8s-health";
import {
  DEFAULT_SERVICE_PLACEMENT,
  formatNotHostedHere,
  resolveServicePlacement,
  type ServicePlacementConfig,
} from "./service-placement";

const placement = {
  version: 1,
  hosts: [
    { hostname: "flagg", services: ["joelclaw-headless-runtime"] },
    { hostname: "panda", services: ["k8s"] },
  ],
} as const satisfies ServicePlacementConfig;

describe("service placement", () => {
  test("maps k8s to panda from config", () => {
    expect(resolveServicePlacement("k8s", "panda.local", placement)).toEqual({
      service: "k8s",
      hostname: "panda",
      hostedHere: true,
      hostedOn: ["panda"],
    });
  });

  test("maps the headless runtime to flagg", () => {
    expect(resolveServicePlacement("joelclaw-headless-runtime", "flagg.localdomain", placement)).toEqual({
      service: "joelclaw-headless-runtime",
      hostname: "flagg",
      hostedHere: true,
      hostedOn: ["flagg"],
    });
  });

  test("keeps the checked-in default placement aligned with Flagg and Panda", () => {
    expect(resolveServicePlacement("joelclaw-headless-runtime", "flagg", DEFAULT_SERVICE_PLACEMENT)).toMatchObject({
      hostedHere: true,
      hostedOn: ["flagg"],
    });
    expect(resolveServicePlacement("k8s", "panda", DEFAULT_SERVICE_PLACEMENT)).toMatchObject({
      hostedHere: true,
      hostedOn: ["panda"],
    });
  });

  test("reports a non-hosting machine as healthy context without running kubectl", () => {
    let kubectlRuns = 0;
    const result = probeK8sHealth({
      hostname: "flagg.localdomain",
      placement,
      runKubectl: () => {
        kubectlRuns += 1;
        throw new Error("must not run");
      },
    });

    expect(kubectlRuns).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      status: "not-hosted-here (hosted on: panda)",
      detail: "not-hosted-here (hosted on: panda)",
      hostname: "flagg",
      hostedOn: ["panda"],
    });
    expect(formatNotHostedHere(resolveServicePlacement("k8s", "flagg", placement)))
      .toBe("not-hosted-here (hosted on: panda)");
  });

  test("runs the existing local pod check on the hosting machine", () => {
    const result = probeK8sHealth({
      hostname: "panda",
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
      hostname: "panda",
    });
  });
});
