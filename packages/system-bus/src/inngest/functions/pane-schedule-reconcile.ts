/**
 * Wake-registry reconciler for pane schedules.
 *
 * A pane/schedule run that dies terminally (worker reboot, "Unable to reach
 * SDK URL", exhausted retries) leaves its entry stuck in the pending registry
 * with no due signal ever emitted. This function sweeps the registry on a
 * cron (and on demand at worker startup) and recovers orphaned entries.
 *
 * Recovery is verb-aware:
 * - verb:spawn is executed mechanically (stable beat lane) and never re-enters
 *   the gateway judgment queue.
 * - verb:wake|revive re-emit `pane.schedule.due` for the existing consumers.
 *
 * It deliberately does NOT re-send `pane/schedule.requested` — the main
 * function's idempotency key would swallow it inside the idempotency period,
 * and outside it a duplicate sleeping run would be created.
 */

import {
  isPaneScheduleLate,
  isPaneScheduleOverdue,
  PANE_SCHEDULE_DEAD_KEY,
  PANE_SCHEDULE_REGISTRY_KEY,
  type PaneScheduleEntry,
  validatePaneSchedule,
} from "../../lib/pane-schedule";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { dispatchDuePaneSchedule, type PaneScheduleDeps } from "./pane-schedule";

export type PaneScheduleRegistryPartition = {
  valid: PaneScheduleEntry[];
  malformed: { scheduleId: string; raw: string; issue: string }[];
};

export function partitionPaneScheduleRegistry(
  raw: Record<string, string>,
): PaneScheduleRegistryPartition {
  const valid: PaneScheduleEntry[] = [];
  const malformed: { scheduleId: string; raw: string; issue: string }[] = [];
  for (const [scheduleId, json] of Object.entries(raw)) {
    try {
      valid.push(validatePaneSchedule(JSON.parse(json)));
    } catch (error) {
      malformed.push({
        scheduleId,
        raw: json,
        issue: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { valid, malformed };
}

export const paneScheduleReconcile = inngest.createFunction(
  {
    id: "pane/schedule.reconcile",
    name: "Pane Schedule Reconciler",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "*/5 * * * *" }, { event: "pane/schedule.reconcile.requested" }],
  async ({ step }) => {
    const scan = await step.run("read-pending-registry", async () => {
      const redis = getRedisClient();
      const raw = await redis.hgetall(PANE_SCHEDULE_REGISTRY_KEY);
      const { valid, malformed } = partitionPaneScheduleRegistry(raw);

      // Quarantine malformed entries so they cannot stall the sweep forever.
      for (const entry of malformed) {
        await redis.hset(PANE_SCHEDULE_DEAD_KEY, entry.scheduleId, entry.raw);
        await redis.hdel(PANE_SCHEDULE_REGISTRY_KEY, entry.scheduleId);
        await emitOtelEvent({
          level: "warn",
          source: "inngest/pane-schedule-reconcile",
          component: "system-bus",
          action: "pane.schedule.quarantined",
          success: false,
          error: entry.issue,
          metadata: { scheduleId: entry.scheduleId },
        });
      }

      return {
        scanned: Object.keys(raw).length,
        valid,
        quarantined: malformed.map((entry) => entry.scheduleId),
      };
    });

    const overdueRaw = await step.run("select-overdue", () => {
      const nowMs = Date.now();
      return scan.valid
        .map((candidate) => validatePaneSchedule(candidate))
        .filter((entry) => isPaneScheduleOverdue(entry.at, nowMs));
    });
    // step.run output crosses a JSON boundary and loses its type; re-validate
    // to recover PaneScheduleEntry (pure and deterministic, so replay-safe).
    const overdue = overdueRaw.map((candidate) => validatePaneSchedule(candidate));

    const recoveries: Array<{
      scheduleId: string;
      route: string;
      acked: boolean;
      spawnStatus?: string;
    }> = [];

    for (const entry of overdue) {
      const recovery = await step.run(`recover-due-${entry.scheduleId}`, async () => {
        const firedAt = new Date();
        // Reconcile uses the same dispatch branch as the primary function so
        // spawn stays mechanical and wake/revive keep the gateway due signal.
        const deps: PaneScheduleDeps = {
          pushGatewayEvent: async (input) => {
            // Mark recovered on the payload for wake/revive consumers.
            return pushGatewayEvent({
              ...input,
              source: "inngest/pane-schedule-reconcile",
              payload: {
                ...input.payload,
                recovered: true,
                late: isPaneScheduleLate(entry.at, firedAt.getTime()),
              },
            });
          },
        };
        const dispatch = await dispatchDuePaneSchedule(entry, firedAt, deps);
        await emitOtelEvent({
          level: "warn",
          source: "inngest/pane-schedule-reconcile",
          component: "system-bus",
          action: "pane.schedule.recovered",
          success: dispatch.route === "gateway-due-signal" || dispatch.acked,
          metadata: {
            scheduleId: entry.scheduleId,
            verb: entry.verb,
            at: entry.at,
            firedAt: firedAt.toISOString(),
            route: dispatch.route,
            gatewayPushed: dispatch.gatewayPushed,
            acked: dispatch.acked,
            spawnStatus: dispatch.spawn?.status,
          },
        });
        return {
          scheduleId: entry.scheduleId,
          firedAt: firedAt.toISOString(),
          route: dispatch.route,
          acked: dispatch.acked,
          spawnStatus: dispatch.spawn?.status,
        };
      });
      recoveries.push({
        scheduleId: entry.scheduleId,
        route: typeof recovery?.route === "string" ? recovery.route : "unknown",
        acked: recovery?.acked === true,
        ...(typeof recovery?.spawnStatus === "string"
          ? { spawnStatus: recovery.spawnStatus }
          : {}),
      });
    }

    return {
      status: "ok",
      scanned: scan.scanned,
      overdue: overdue.length,
      recovered: recoveries.map((entry) => entry.scheduleId),
      spawnDispatched: recoveries
        .filter((entry) => entry.route === "mechanical-spawn" && entry.acked)
        .map((entry) => entry.scheduleId),
      spawnBusy: recoveries
        .filter((entry) => entry.route === "mechanical-spawn" && entry.spawnStatus === "busy")
        .map((entry) => entry.scheduleId),
      spawnFailed: recoveries
        .filter(
          (entry) =>
            entry.route === "mechanical-spawn" && !entry.acked && entry.spawnStatus !== "busy",
        )
        .map((entry) => entry.scheduleId),
      quarantined: scan.quarantined,
    };
  },
);
