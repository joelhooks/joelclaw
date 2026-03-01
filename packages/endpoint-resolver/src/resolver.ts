import { spawnSync } from "node:child_process";

export const DEFAULT_COLIMA_VM_IP = "192.168.64.2";

export type EndpointClass = "localhost" | "vm" | "svc_dns";
export type HealthService = "inngest" | "worker" | "typesense";

export type EndpointCandidate = {
  endpointClass: EndpointClass;
  endpoint: string;
  probeUrls: string[];
};

export type EndpointCandidateFailure = {
  endpointClass: EndpointClass;
  endpoint: string;
  reason: string;
};

export type EndpointResolutionSuccess = {
  ok: true;
  endpointClass: EndpointClass;
  endpoint: string;
  probeUrl: string;
  status: number;
  body: string;
  skippedCandidates: EndpointCandidateFailure[];
};

export type EndpointResolutionFailure = {
  ok: false;
  endpointClass: null;
  endpoint: null;
  probeUrl: null;
  status: 0;
  body: "";
  reason: string;
  skippedCandidates: EndpointCandidateFailure[];
};

export type EndpointResolution = EndpointResolutionSuccess | EndpointResolutionFailure;

export type ResolveEndpointOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type BuildEndpointCandidatesOptions = {
  localhostUrl: string;
  serviceDnsUrl: string;
  probePaths?: readonly string[];
  vmIp?: string;
  vmFallbackIp?: string;
};

type BuildServiceHealthCandidatesOptions = {
  localhostUrl?: string;
  serviceDnsUrl?: string;
  probePaths?: readonly string[];
  vmIp?: string;
  vmFallbackIp?: string;
};

type ColimaIpOptions = {
  env?: Record<string, string | undefined>;
  fallbackIp?: string;
  cacheTtlMs?: number;
  nowMs?: number;
  commandRunner?: () => string | null;
  bypassCache?: boolean;
};

type ProbeAttempt =
  | {
      ok: true;
      status: number;
      body: string;
    }
  | {
      ok: false;
      status: number;
      reason: string;
    };

const SERVICE_HEALTH_DEFAULTS: Record<
  HealthService,
  { localhostUrl: string; serviceDnsUrl: string; probePaths: readonly string[] }
> = {
  inngest: {
    localhostUrl: "http://localhost:8288",
    serviceDnsUrl: "http://inngest-svc.joelclaw.svc.cluster.local:8288",
    probePaths: ["/health"],
  },
  worker: {
    localhostUrl: "http://localhost:3111",
    serviceDnsUrl: "http://system-bus-worker.joelclaw.svc.cluster.local:3111",
    probePaths: ["/", "/health", "/api/inngest"],
  },
  typesense: {
    localhostUrl: "http://localhost:8108",
    serviceDnsUrl: "http://typesense.joelclaw.svc.cluster.local:8108",
    probePaths: ["/health"],
  },
};

let cachedColimaVmIp: { value: string; capturedAtMs: number } | null = null;

export function discoverColimaVmIp(options: ColimaIpOptions = {}): string {
  const env = options.env ?? process.env;
  const fallbackIp = options.fallbackIp ?? DEFAULT_COLIMA_VM_IP;
  const nowMs = options.nowMs ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;

  if (!options.bypassCache && cachedColimaVmIp && nowMs - cachedColimaVmIp.capturedAtMs < cacheTtlMs) {
    return cachedColimaVmIp.value;
  }

  const envIp = (env.JOELCLAW_COLIMA_VM_IP ?? env.COLIMA_VM_IP)?.trim();
  if (isValidIpv4(envIp)) {
    cachedColimaVmIp = { value: envIp, capturedAtMs: nowMs };
    return envIp;
  }

  const runner = options.commandRunner ?? defaultColimaCommandRunner;
  const discovered = parseColimaVmIp(runner());
  const resolvedIp = discovered ?? fallbackIp;

  cachedColimaVmIp = { value: resolvedIp, capturedAtMs: nowMs };
  return resolvedIp;
}

export function buildEndpointCandidates(options: BuildEndpointCandidatesOptions): EndpointCandidate[] {
  const localhostUrl = new URL(options.localhostUrl);
  const serviceDnsUrl = new URL(options.serviceDnsUrl);
  const vmIp =
    options.vmIp
    ?? discoverColimaVmIp({
      fallbackIp: options.vmFallbackIp ?? DEFAULT_COLIMA_VM_IP,
    });

  const vmUrl = new URL(localhostUrl.toString());
  vmUrl.hostname = vmIp;

  const probePaths =
    options.probePaths && options.probePaths.length > 0
      ? [...options.probePaths]
      : [
          `${localhostUrl.pathname}${localhostUrl.search}`.trim().length > 0
            ? `${localhostUrl.pathname}${localhostUrl.search}`
            : "/",
        ];

  const candidateInputs: Array<{ endpointClass: EndpointClass; baseUrl: URL }> = [
    { endpointClass: "localhost", baseUrl: localhostUrl },
    { endpointClass: "vm", baseUrl: vmUrl },
    { endpointClass: "svc_dns", baseUrl: serviceDnsUrl },
  ];

  return candidateInputs.map(({ endpointClass, baseUrl }) => {
    const probeUrls = dedupe(
      probePaths.map((probePath) => buildProbeUrl(baseUrl, probePath)).filter((value) => value.length > 0),
    );

    const endpoint =
      options.probePaths && options.probePaths.length > 0
        ? baseUrl.origin
        : normalizeUrl(baseUrl.toString());

    return {
      endpointClass,
      endpoint,
      probeUrls,
    };
  });
}

export function buildServiceHealthCandidates(
  service: HealthService,
  options: BuildServiceHealthCandidatesOptions = {},
): EndpointCandidate[] {
  const defaults = SERVICE_HEALTH_DEFAULTS[service];

  return buildEndpointCandidates({
    localhostUrl: options.localhostUrl ?? defaults.localhostUrl,
    serviceDnsUrl: options.serviceDnsUrl ?? defaults.serviceDnsUrl,
    probePaths: options.probePaths ?? defaults.probePaths,
    vmIp: options.vmIp,
    vmFallbackIp: options.vmFallbackIp,
  });
}

export async function resolveEndpoint(candidates: readonly EndpointCandidate[], options: ResolveEndpointOptions = {}): Promise<EndpointResolution> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const skippedCandidates: EndpointCandidateFailure[] = [];

  for (const candidate of candidates) {
    const attemptReasons: string[] = [];

    for (const probeUrl of candidate.probeUrls) {
      const probe = await probeUrlWithTimeout(probeUrl, timeoutMs, fetchImpl);
      if (probe.ok) {
        return {
          ok: true,
          endpointClass: candidate.endpointClass,
          endpoint: candidate.endpoint,
          probeUrl,
          status: probe.status,
          body: probe.body,
          skippedCandidates,
        };
      }

      const failureReason =
        probe.status > 0
          ? `HTTP ${probe.status} (${probeUrl})`
          : `${probe.reason} (${probeUrl})`;
      attemptReasons.push(failureReason);
    }

    skippedCandidates.push({
      endpointClass: candidate.endpointClass,
      endpoint: candidate.endpoint,
      reason: attemptReasons.join(" | ") || "unreachable",
    });
  }

  return {
    ok: false,
    endpointClass: null,
    endpoint: null,
    probeUrl: null,
    status: 0,
    body: "",
    reason: summarizeSkippedCandidates(skippedCandidates),
    skippedCandidates,
  };
}

export function summarizeSkippedCandidates(candidates: readonly EndpointCandidateFailure[]): string {
  if (candidates.length === 0) return "no-candidates";

  return candidates
    .map((candidate) => `${candidate.endpointClass}: ${candidate.reason}`)
    .join("; ");
}

export const __endpointResolverTestUtils = {
  parseColimaVmIp,
  buildProbeUrl,
  resetColimaVmIpCache: () => {
    cachedColimaVmIp = null;
  },
};

async function probeUrlWithTimeout(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<ProbeAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const body = await response.text().catch(() => "");

    if (response.ok) {
      return { ok: true, status: response.status, body };
    }

    return {
      ok: false,
      status: response.status,
      reason: body.trim().slice(0, 200) || "HTTP failure",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: normalizeProbeError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildProbeUrl(baseUrl: URL, probePath: string): string {
  const trimmedProbePath = probePath.trim();
  if (trimmedProbePath.length === 0) {
    return normalizeUrl(baseUrl.toString());
  }

  if (trimmedProbePath.startsWith("http://") || trimmedProbePath.startsWith("https://")) {
    return normalizeUrl(trimmedProbePath);
  }

  const [pathnameRaw = "", queryRaw = ""] = trimmedProbePath.split("?", 2);
  const url = new URL(baseUrl.toString());
  const normalizedPathname = pathnameRaw.startsWith("/") ? pathnameRaw : `/${pathnameRaw}`;
  url.pathname = normalizedPathname.length > 0 ? normalizedPathname : "/";
  url.search = queryRaw.length > 0 ? `?${queryRaw}` : "";
  return normalizeUrl(url.toString());
}

function parseColimaVmIp(raw: string | null): string | null {
  if (!raw || raw.trim().length === 0) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;

      const directAddress = readAddressField(entry as Record<string, unknown>);
      if (directAddress) return directAddress;

      const network = (entry as Record<string, unknown>).network;
      if (network && typeof network === "object") {
        const networkAddress = readAddressField(network as Record<string, unknown>);
        if (networkAddress) return networkAddress;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function readAddressField(input: Record<string, unknown>): string | null {
  const value = input.address;
  if (typeof value === "string" && isValidIpv4(value.trim())) {
    return value.trim();
  }
  return null;
}

function defaultColimaCommandRunner(): string | null {
  try {
    const command = spawnSync("colima", ["ls", "-j"], {
      encoding: "utf8",
      timeout: 1200,
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (command.status !== 0) return null;

    const output = command.stdout?.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function normalizeProbeError(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError"
  ) {
    return "timeout";
  }

  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : "unreachable";
  }

  return String(error || "unreachable");
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/u, "").replace(/\/$/u, "");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isValidIpv4(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(trimmed)) return false;
  return trimmed
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}
