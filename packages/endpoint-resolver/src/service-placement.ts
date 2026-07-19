import defaultPlacement from "../config/service-placement.json";

export type HostedService = "k8s" | "joelclaw-headless-runtime";

export type ServicePlacementConfig = {
  readonly version: 1;
  readonly hosts: readonly {
    readonly hostname: string;
    readonly services: readonly HostedService[];
  }[];
};

export type ServicePlacement = {
  readonly service: HostedService;
  readonly hostname: string;
  readonly hostedHere: boolean;
  readonly hostedOn: readonly string[];
};

export const DEFAULT_SERVICE_PLACEMENT = defaultPlacement as ServicePlacementConfig;

export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "").split(".")[0] ?? "";
}

export function resolveServicePlacement(
  service: HostedService,
  hostname: string,
  config: ServicePlacementConfig = DEFAULT_SERVICE_PLACEMENT,
): ServicePlacement {
  const normalizedHostname = normalizeHostname(hostname);
  const hostedOn = config.hosts
    .filter((host) => host.services.includes(service))
    .map((host) => normalizeHostname(host.hostname))
    .filter(Boolean);

  return {
    service,
    hostname: normalizedHostname,
    hostedHere: hostedOn.includes(normalizedHostname),
    hostedOn,
  };
}

export function formatNotHostedHere(placement: ServicePlacement): string {
  const hosts = placement.hostedOn.length > 0 ? placement.hostedOn.join(", ") : "unassigned";
  return `not-hosted-here (hosted on: ${hosts})`;
}
