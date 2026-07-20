/**
 * Wake-registry reconciler for pane schedules.
 *
 * A pane/schedule run that dies terminally (worker reboot, "Unable to reach
 * SDK URL", exhausted retries) leaves its entry stuck in the pending registry
 * with no due signal ever emitted. This function sweeps the registry on a
 * cron (and on demand at worker startup) and re-emits `pane.schedule.due` for
 * orphaned entries. It deliberately does NOT re-send `pane/schedule.requested`
 * — the main function's idempotency key would swallow it inside the
 * idempotency period, and outside it a duplicate sleeping run would be
 * created. The observer dispatcher dedupes executions by scheduleId, so a
 * re-emit for a schedule that actually delivered is a safe no-op downstream.
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

    for (const entry of overdue) {
      // Emit first; delete only after the emit step resolved. pushGatewayEvent
      // resolves only after the Redis lpush+publish to the gateway queue
      // succeed, and step memoization guarantees a retry of the delete step
      // never re-runs the emit step.
      await step.run(`re-emit-due-${entry.scheduleId}`, async () => {
        const firedAt = new Date();
        await pushGatewayEvent({
          type: "pane.schedule.due",
          source: "inngest/pane-schedule-reconcile",
          payload: {
            ...entry,
            firedAt: firedAt.toISOString(),
            late: isPaneScheduleLate(entry.at, firedAt.getTime()),
            recovered: true,
          },
        });
        await emitOtelEvent({
          level: "warn",
          source: "inngest/pane-schedule-reconcile",
          component: "system-bus",
          action: "pane.schedule.recovered",
          success: true,
          metadata: {
            scheduleId: entry.scheduleId,
            verb: entry.verb,
            at: entry.at,
            firedAt: firedAt.toISOString(),
          },
        });
        return firedAt.toISOString();
      });

      await step.run(`remove-recovered-${entry.scheduleId}`, async () => {
        await getRedisClient().hdel(PANE_SCHEDULE_REGISTRY_KEY, entry.scheduleId);
        return { scheduleId: entry.scheduleId, removed: true };
      });
    }

    return {
      status: "ok",
      scanned: scan.scanned,
      overdue: overdue.length,
      recovered: overdue.map((entry) => entry.scheduleId),
      quarantined: scan.quarantined,
    };
  },
);
