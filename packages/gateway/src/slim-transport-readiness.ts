import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SLIM_TRANSPORT_READY_FILE = "/tmp/joelclaw/gateway.ready.json";
export const SLIM_TRANSPORT_READINESS_SCHEMA = "gateway-transport-readiness.v1" as const;

export interface SlimTransportLivenessDependencies {
  readonly startChannelRuntime: () => Promise<void>;
  readonly publishPid: () => Promise<void>;
  readonly publishHeartbeat: () => Promise<void>;
}

export async function startChannelRuntimeWithLiveness(
  dependencies: SlimTransportLivenessDependencies,
): Promise<void> {
  await dependencies.startChannelRuntime();
  await dependencies.publishPid();
  await dependencies.publishHeartbeat();
}

export interface SlimTransportReadinessReceipt {
  readonly schema: typeof SLIM_TRANSPORT_READINESS_SCHEMA;
  readonly pid: number;
  readonly readyAt: number;
  readonly eventLogReady: true;
  readonly initialDrainCompleted: true;
  readonly queues: {
    readonly gateway: number;
    readonly legacy: number;
  };
}

export async function publishSlimTransportReadiness(
  receipt: Omit<SlimTransportReadinessReceipt, "schema">,
  path = SLIM_TRANSPORT_READY_FILE,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ schema: SLIM_TRANSPORT_READINESS_SCHEMA, ...receipt })}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

export async function clearSlimTransportReadiness(
  path = SLIM_TRANSPORT_READY_FILE,
): Promise<void> {
  await rm(path, { force: true });
}
