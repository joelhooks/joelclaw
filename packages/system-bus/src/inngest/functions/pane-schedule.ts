import { NonRetriableError } from "inngest";
import {
  isPaneScheduleLate,
  PANE_SCHEDULE_FAILURES_KEY,
  PANE_SCHEDULE_REGISTRY_KEY,
  type PaneScheduleEntry,
  PaneScheduleValidationError,
  validatePaneSchedule,
} from "../../lib/pane-schedule";
import {
  DEFAULT_AUTOMATION_HERDR_SESSION,
  executeSpawnBeat,
  type SpawnBeatPorts,
  type SpawnBeatResult,
} from "../../lib/pane-schedule-spawn";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * onFailure receives the wrapping `inngest/function.failed` event, so the
 * original payload lives at event.data.event.data. Walk both shapes
 * defensively.
 */
function extractFailedScheduleId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.scheduleId === "string" && record.scheduleId.length > 0) {
    return record.scheduleId;
  }
  const nested = record.event;
  if (nested && typeof nested === "object") {
    return extractFailedScheduleId((nested as Record<string, unknown>).data);
  }
  return undefined;
}

/** Durable beat-lane registry: brief path -> pane id, so a lane survives the
 * pi name-sync extension rewriting its pane label out from under us. */
export const BEAT_LANE_REGISTRY_KEY = "pane:beats:lanes";

export function beatLaneRegistryKey(session: string): string {
  return `${BEAT_LANE_REGISTRY_KEY}:${session}`;
}

function defaultSpawnPorts(): SpawnBeatPorts {
  const herdrSession =
    process.env.HERDR_AUTOMATION_SESSION?.trim() || DEFAULT_AUTOMATION_HERDR_SESSION;
  const registryKey = beatLaneRegistryKey(herdrSession);
  return {
    herdrSession,
    readLanePane: async (laneKey) =>
      (await getRedisClient().hget(registryKey, laneKey)) ?? undefined,
    writeLanePane: async (laneKey, paneId) => {
      await getRedisClient().hset(registryKey, laneKey, paneId);
    },
  };
}

export type PaneScheduleDeps = {
  pushGatewayEvent?: typeof pushGatewayEvent;
  executeSpawnBeat?: (entry: PaneScheduleEntry, ports?: SpawnBeatPorts) => Promise<SpawnBeatResult>;
  spawnPorts?: SpawnBeatPorts;
  hdelPending?: (scheduleId: string) => Promise<number>;
  hsetPending?: (scheduleId: string, raw: string) => Promise<unknown>;
  emitOtelEvent?: typeof emitOtelEvent;
};

/**
 * verb:spawn is mechanical herdr work. It must never enter the gateway
 * judgment queue as "work needing a worker." wake/revive keep the due-signal
 * path so existing consumers still see them.
 */
export async function dispatchDuePaneSchedule(
  entry: PaneScheduleEntry,
  firedAt: Date,
  deps: PaneScheduleDeps = {},
): Promise<{
  route: "mechanical-spawn" | "gateway-due-signal";
  late: boolean;
  firedAt: string;
  spawn?: SpawnBeatResult;
  gatewayPushed: boolean;
  acked: boolean;
}> {
  const late = isPaneScheduleLate(entry.at, firedAt.getTime());
  const firedAtIso = firedAt.toISOString();
  const push = deps.pushGatewayEvent ?? pushGatewayEvent;
  const spawn = deps.executeSpawnBeat ?? executeSpawnBeat;
  const emit = deps.emitOtelEvent ?? emitOtelEvent;
  const hdel =
    deps.hdelPending ??
    (async (scheduleId: string) => getRedisClient().hdel(PANE_SCHEDULE_REGISTRY_KEY, scheduleId));

  if (entry.verb === "spawn") {
    const spawnPorts = deps.spawnPorts ?? defaultSpawnPorts();
    const spawnResult = await spawn(entry, spawnPorts);
    let acked = false;
    if (spawnResult.ack) {
      await hdel(entry.scheduleId);
      acked = true;
    }
    await emit({
      level: spawnResult.ack ? "info" : "warn",
      source: "inngest/pane-schedule",
      component: "system-bus",
      action: "pane.schedule.spawn-dispatched",
      success: spawnResult.ack,
      error: spawnResult.ack ? undefined : ("reason" in spawnResult ? spawnResult.reason : spawnResult.status),
      metadata: {
        scheduleId: entry.scheduleId,
        verb: entry.verb,
        late,
        firedAt: firedAtIso,
        status: spawnResult.status,
        acked,
        herdrSession:
          spawnPorts.herdrSession?.trim() || DEFAULT_AUTOMATION_HERDR_SESSION,
        ...(spawnResult.status === "spawned" || spawnResult.status === "reused" || spawnResult.status === "busy"
          ? { paneId: spawnResult.paneId, label: spawnResult.label }
          : {}),
      },
    });
    return {
      route: "mechanical-spawn",
      late,
      firedAt: firedAtIso,
      spawn: spawnResult,
      gatewayPushed: false,
      acked,
    };
  }

  await push({
    type: "pane.schedule.due",
    source: "inngest/pane-schedule",
    payload: {
      ...entry,
      firedAt: firedAtIso,
      late,
    },
  });
  return {
    route: "gateway-due-signal",
    late,
    firedAt: firedAtIso,
    gatewayPushed: true,
    acked: false,
  };
}

export const paneSchedule = inngest.createFunction(
  {
    id: "pane/schedule",
    name: "Pane Schedule",
    idempotency: "event.data.scheduleId",
    cancelOn: [{ event: "pane/schedule.cancelled", match: "data.scheduleId" }],
    // Observability ONLY. Never hdel the pending registry entry here — the
    // still-pending entry is what lets the reconciler recover the schedule
    // after a terminal run failure (the de16dde1 case).
    onFailure: async ({ event, error, runId, step }) => {
      const scheduleId = extractFailedScheduleId(event.data) ?? "unknown";
      const message = stringifyError(error);
      await step.run("record-schedule-run-failure", async () => {
        await getRedisClient().hset(
          PANE_SCHEDULE_FAILURES_KEY,
          scheduleId,
          JSON.stringify({
            failedAt: new Date().toISOString(),
            runId,
            error: message,
          }),
        );
        await emitOtelEvent({
          level: "error",
          source: "inngest/pane-schedule",
          component: "system-bus",
          action: "pane.schedule.run-failed",
          success: false,
          error: message,
          metadata: { scheduleId, runId },
        });
        return { scheduleId, recorded: true };
      });
    },
  },
  { event: "pane/schedule.requested" },
  async ({ event, step }) => {
    let entry;
    try {
      entry = validatePaneSchedule(event.data);
    } catch (error) {
      if (error instanceof PaneScheduleValidationError) {
        throw new NonRetriableError(error.message);
      }
      throw error;
    }

    await step.run("register-pending-schedule", async () => {
      await getRedisClient().hset(PANE_SCHEDULE_REGISTRY_KEY, entry.scheduleId, JSON.stringify(entry));
      return { scheduleId: entry.scheduleId, status: "pending" };
    });

    await step.sleepUntil("sleep-until-due", new Date(entry.at));

    const dispatch = await step.run("dispatch-due-schedule", async () => {
      return dispatchDuePaneSchedule(entry, new Date());
    });

    if (dispatch.route === "mechanical-spawn") {
      return {
        status: dispatch.acked
          ? "spawn-dispatched"
          : dispatch.spawn?.status === "busy"
            ? "spawn-busy-awaiting-retry"
            : "spawn-failed-awaiting-retry",
        scheduleId: entry.scheduleId,
        firedAt: dispatch.firedAt,
        late: dispatch.late,
        spawn: dispatch.spawn,
        gatewayPushed: false,
      };
    }

    // wake/revive: dispatcher (or gateway path) owns terminal acknowledgement.
    // Keep the registry entry until success or retry exhaustion. The reconciler
    // re-emits this due signal while the entry remains pending.
    return {
      status: "due-signal-emitted-awaiting-dispatcher-ack",
      scheduleId: entry.scheduleId,
      firedAt: dispatch.firedAt,
      late: dispatch.late,
      gatewayPushed: true,
    };
  },
);
