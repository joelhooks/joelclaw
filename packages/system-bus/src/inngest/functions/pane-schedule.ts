import { NonRetriableError } from "inngest";
import {
  isPaneScheduleLate,
  PANE_SCHEDULE_REGISTRY_KEY,
  PaneScheduleValidationError,
  validatePaneSchedule,
} from "../../lib/pane-schedule";
import { getRedisClient } from "../../lib/redis";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

export const paneSchedule = inngest.createFunction(
  {
    id: "pane/schedule",
    name: "Pane Schedule",
    idempotency: "event.data.scheduleId",
    cancelOn: [{ event: "pane/schedule.cancelled", match: "data.scheduleId" }],
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
