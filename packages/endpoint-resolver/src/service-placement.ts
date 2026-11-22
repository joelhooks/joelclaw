import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function parseServicePlacement(value: unknown): ServicePlacementConfig {
  if (typeof value !== "object" || value === null || !("version" in value) ||
      value.version !== 1 || !("hosts" in value) || !Array.isArray(value.hosts)) {
    throw new Error("Invalid service placement: expected version 1 and a hosts array");
  }
  const hosts = value.hosts.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("hostname" in entry) ||
        typeof entry.hostname !== "string" || !/^[a-z0-9][a-z0-9.-]*$/i.test(entry.hostname) ||
        !("services" in entry) || !Array.isArray(entry.services)) {
      throw new Error("Invalid service placement host entry");
    }
    const services = entry.services.map((service: unknown): HostedService => {
      if (service === "k8s" || service === "joelclaw-headless-runtime") return service;
      throw new Error("Invalid service placement role");
    });
    return { hostname: entry.hostname, services };
  });
  return { version: 1, hosts };
}

function loadServicePlacement(): ServicePlacementConfig {
  const configured = process.env.JOELCLAW_SERVICE_PLACEMENT_FILE?.trim();
  const path = configured || join(homedir(), ".config", "joelclaw", "service-placement.json");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (!configured && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return parseServicePlacement(defaultPlacement);
    }
    throw error;
  }
  return parseServicePlacement(JSON.parse(source));
}

export const DEFAULT_SERVICE_PLACEMENT = loadServicePlacement();

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
