import { NonRetriableError } from "inngest";
import {
  isPaneScheduleLate,
  PANE_SCHEDULE_FAILURES_KEY,
  PANE_SCHEDULE_REGISTRY_KEY,
  PaneScheduleValidationError,
  validatePaneSchedule,
} from "../../lib/pane-schedule";
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

    const firedAt = await step.run("emit-due-signal", async () => {
      const firedAt = new Date();
      const late = isPaneScheduleLate(entry.at, firedAt.getTime());
      await pushGatewayEvent({
        type: "pane.schedule.due",
        source: "inngest/pane-schedule",
        payload: {
          ...entry,
          firedAt: firedAt.toISOString(),
          late,
        },
      });
      return firedAt.toISOString();
    });

    await step.run("remove-pending-schedule", async () => {
      await getRedisClient().hdel(PANE_SCHEDULE_REGISTRY_KEY, entry.scheduleId);
    });

    return {
      status: "due-signal-emitted",
      scheduleId: entry.scheduleId,
      firedAt,
      late: isPaneScheduleLate(entry.at, Date.parse(firedAt)),
    };
  },
);
