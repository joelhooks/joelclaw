import { hostname as osHostname } from "node:os";
import {
  formatNotHostedHere,
  resolveServicePlacement,
  type ServicePlacementConfig,
} from "./service-placement";

export type K8sHealthStatus = {
  readonly ok: boolean;
  readonly status: string;
  readonly detail: string;
  readonly hostname: string;
  readonly hostedOn: readonly string[];
};

type CommandResult = {
  readonly stdout: string;
};

export type K8sHealthProbeOptions = {
  readonly hostname?: string;
  readonly placement?: ServicePlacementConfig;
  readonly runKubectl?: () => CommandResult;
};

function runLocalK8sProbe(): CommandResult {
  const proc = Bun.spawnSync([
    "kubectl",
    "get",
    "pods",
    "-n",
    "joelclaw",
    "--no-headers",
    "-o",
    "custom-columns=NAME:.metadata.name,STATUS:.status.phase,READY:.status.containerStatuses[0].ready",
  ]);
  return { stdout: proc.stdout.toString() };
}

export function probeK8sHealth(options: K8sHealthProbeOptions = {}): K8sHealthStatus {
  const placement = resolveServicePlacement(
    "k8s",
    options.hostname ?? osHostname(),
    options.placement,
  );

  if (!placement.hostedHere) {
    const status = formatNotHostedHere(placement);
    return {
      ok: true,
      status,
      detail: status,
      hostname: placement.hostname,
      hostedOn: placement.hostedOn,
    };
  }

  try {
    const output = (options.runKubectl ?? runLocalK8sProbe)().stdout.trim();
    const pods = output.split("\n").filter(Boolean);
    const activePods = pods.filter((line) => {
      const [, status] = line.trim().split(/\s+/, 3);
      return status !== "Succeeded" && status !== "Completed";
    });
    const allRunning = activePods.length > 0
      && activePods.every((pod) => pod.includes("Running") && pod.includes("true"));

    return {
      ok: allRunning,
      status: allRunning ? "healthy" : "unhealthy",
      detail: pods.join(" | "),
      hostname: placement.hostname,
      hostedOn: placement.hostedOn,
    };
  } catch {
    return {
      ok: false,
      status: "unhealthy",
      detail: "kubectl not available or k3d cluster not running",
      hostname: placement.hostname,
      hostedOn: placement.hostedOn,
    };
  }
}
