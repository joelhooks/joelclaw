import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { respond, respondError } from "../../response"
import { fleetDiffResponse } from "./diff"
import { DEFAULT_FLEET_CONFIG_PATH, loadFleetManifest, type FleetManifest } from "./manifest"
import { probeFleetHost, type FleetHostProbeResult } from "./probe"

export type FleetStatusDependencies = {
  readonly loadManifest: (path: string) => FleetManifest
  readonly probeHost: (host: FleetManifest["hosts"][number]) => FleetHostProbeResult
}

const defaultDependencies: FleetStatusDependencies = {
  loadManifest: loadFleetManifest,
  probeHost: probeFleetHost,
}

export function fleetStatusResponse(
  input: { readonly config: string; readonly host?: string },
  dependencies: FleetStatusDependencies = defaultDependencies,
): string {
  let manifest: FleetManifest
  try {
    manifest = dependencies.loadManifest(input.config)
  } catch {
    return respondError(
      "fleet status",
      "Could not load the local fleet manifest",
      "FLEET_MANIFEST_INVALID",
      "Create or repair the private local fleet manifest; do not commit it.",
      [{ command: "fleet status", description: "Retry fleet status after repairing the local manifest" }],
    )
  }

  const hosts = input.host
    ? manifest.hosts.filter((host) => host.alias === input.host)
    : manifest.hosts

  if (input.host && hosts.length === 0) {
    return respondError(
      "fleet status",
      `Unknown fleet host alias: ${input.host}`,
      "FLEET_HOST_UNKNOWN",
      "Choose an alias declared in the private local fleet manifest.",
      [{ command: "fleet status", description: "Inspect all declared fleet hosts" }],
    )
  }

  const results = hosts.map((host) => dependencies.probeHost(host))
  const failed = results.filter((result) => !result.ok)

  return respond(
    "fleet status",
    {
      hosts: results,
      hostCount: results.length,
      failedCount: failed.length,
      sourceBehavior: "Reads the private local manifest and probes declared hosts without changing remote state",
    },
    [
      { command: "fleet status", description: "Refresh the read-only fleet inventory" },
      { command: "fleet diff", description: "Compare observed facts against role-aware policy when available" },
    ],
    failed.length === 0,
  )
}

const hostOpt = Options.optional(
  Options.text("host").pipe(
    Options.withDescription("One declared private-manifest host alias to probe"),
  ),
)

const configOpt = Options.text("config").pipe(
  Options.withDefault(DEFAULT_FLEET_CONFIG_PATH),
  Options.withDescription("Private local fleet manifest path; it is never created or printed"),
)

const statusCmd = Command.make(
  "status",
  { host: hostOpt, config: configOpt },
  ({ host, config }) => Effect.gen(function* () {
    yield* Console.log(fleetStatusResponse({ host: Option.getOrUndefined(host), config }))
  }),
).pipe(Command.withDescription("Read-only role-aware fleet inventory"))

const diffCmd = Command.make(
  "diff",
  { host: hostOpt, config: configOpt },
  ({ host, config }) => Effect.gen(function* () {
    yield* Console.log(fleetDiffResponse({ host: Option.getOrUndefined(host), config }, defaultDependencies))
  }),
).pipe(Command.withDescription("Compare read-only fleet facts against role-aware policy"))

export const fleetCmd = Command.make("fleet", {}).pipe(
  Command.withDescription("Read-only fleet inventory tools"),
  Command.withSubcommands([statusCmd, diffCmd]),
)
