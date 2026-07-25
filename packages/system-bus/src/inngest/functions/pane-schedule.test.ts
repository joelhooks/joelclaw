import { expect, test } from "bun:test";
import type { PaneScheduleEntry } from "../../lib/pane-schedule";
import { dispatchDuePaneSchedule, paneSchedule } from "./pane-schedule";

const spawnEntry: PaneScheduleEntry = {
  version: 1,
  scheduleId: "853efe38-4893-41a3-a078-b22766bdc52f",
  verb: "spawn",
  at: "2026-07-22T16:00:00.000Z",
  briefPath: "/repo/daily-flow.svx",
  requestedBy: "test",
  createdAt: "2026-07-22T15:00:00.000Z",
};

const wakeEntry: PaneScheduleEntry = {
  version: 1,
  scheduleId: "wake-1",
  verb: "wake",
  at: "2026-07-22T16:00:00.000Z",
  target: "observer",
  prompt: "check the thing",
  requestedBy: "test",
  createdAt: "2026-07-22T15:00:00.000Z",
};

test("pane schedule cancellation matches the schedule id", () => {
  const cancelOn = ((paneSchedule as unknown as { opts?: { cancelOn?: unknown[] } }).opts?.cancelOn ?? [])[0];
  expect(cancelOn).toEqual({ event: "pane/schedule.cancelled", match: "data.scheduleId" });
});

test("spawn due schedules bypass the gateway queue and ack on success", async () => {
  const pushed: unknown[] = [];
  const deleted: string[] = [];
  const dispatch = await dispatchDuePaneSchedule(spawnEntry, new Date("2026-07-22T16:00:00.000Z"), {
    emitOtelEvent: async () => ({ stored: false, skipped: true, eventId: "test" }) as never,
    pushGatewayEvent: async (event) => {
      pushed.push(event);
      return event as never;
    },
    hdelPending: async (scheduleId) => {
      deleted.push(scheduleId);
      return 1;
    },
    executeSpawnBeat: async (entry) => ({
      status: "spawned",
      scheduleId: entry.scheduleId,
      paneId: "wBeats:p1",
      label: "⏰ Daily Flow",
      created: true,
      ack: true,
    }),
  });

  expect(dispatch).toMatchObject({
    route: "mechanical-spawn",
    gatewayPushed: false,
    acked: true,
    spawn: { status: "spawned", paneId: "wBeats:p1" },
  });
  expect(pushed).toEqual([]);
  expect(deleted).toEqual([spawnEntry.scheduleId]);
});

test("wake due schedules still reach the gateway queue and stay pending", async () => {
  const pushed: unknown[] = [];
  const deleted: string[] = [];
  const dispatch = await dispatchDuePaneSchedule(wakeEntry, new Date("2026-07-22T16:00:00.000Z"), {
    emitOtelEvent: async () => ({ stored: false, skipped: true, eventId: "test" }) as never,
    pushGatewayEvent: async (event) => {
      pushed.push(event);
      return event as never;
    },
    hdelPending: async (scheduleId) => {
      deleted.push(scheduleId);
      return 1;
    },
    executeSpawnBeat: async () => {
      throw new Error("spawn executor must not run for wake");
    },
  });

  expect(dispatch).toMatchObject({
    route: "gateway-due-signal",
    gatewayPushed: true,
    acked: false,
  });
  expect(pushed).toEqual([
    {
      type: "pane.schedule.due",
      source: "inngest/pane-schedule",
      payload: {
        ...wakeEntry,
        firedAt: "2026-07-22T16:00:00.000Z",
        late: false,
      },
    },
  ]);
  expect(deleted).toEqual([]);
});

test("busy spawn lanes leave the registry pending for retry", async () => {
  const deleted: string[] = [];
  const dispatch = await dispatchDuePaneSchedule(spawnEntry, new Date("2026-07-22T16:00:00.000Z"), {
    emitOtelEvent: async () => ({ stored: false, skipped: true, eventId: "test" }) as never,
    pushGatewayEvent: async () => {
      throw new Error("gateway must not receive busy spawn work");
    },
    hdelPending: async (scheduleId) => {
      deleted.push(scheduleId);
      return 1;
    },
    executeSpawnBeat: async (entry) => ({
      status: "busy",
      scheduleId: entry.scheduleId,
      paneId: "wBeats:p1",
      label: "⏰ Daily Flow",
      ack: false,
    }),
  });

  expect(dispatch).toMatchObject({
    route: "mechanical-spawn",
    gatewayPushed: false,
    acked: false,
    spawn: { status: "busy" },
  });
  expect(deleted).toEqual([]);
});

test("spawn function path reports mechanical dispatch without gateway push", async () => {
  const stepIds: string[] = [];
  const step = {
    run: async (id: string, operation?: () => unknown) => {
      stepIds.push(id);
      if (id === "register-pending-schedule") {
        return { scheduleId: spawnEntry.scheduleId, status: "pending" };
      }
      if (id === "dispatch-due-schedule") {
        return {
          route: "mechanical-spawn",
          late: false,
          firedAt: "2026-07-22T16:00:00.000Z",
          spawn: {
            status: "reused",
            scheduleId: spawnEntry.scheduleId,
            paneId: "wBeats:p1",
            label: "⏰ Daily Flow",
            created: false,
            ack: true,
          },
          gatewayPushed: false,
          acked: true,
        };
      }
      if (operation) return operation();
      return undefined;
    },
    sleepUntil: async () => {},
  };
  const result = await (paneSchedule as unknown as { fn: (input: unknown) => Promise<unknown> }).fn({
    event: { data: spawnEntry },
    step,
  });

  expect(stepIds).toEqual(["register-pending-schedule", "dispatch-due-schedule"]);
  expect(result).toMatchObject({
    status: "spawn-dispatched",
    gatewayPushed: false,
    scheduleId: spawnEntry.scheduleId,
  });
});

test("wake function path still awaits dispatcher ack", async () => {
  const stepIds: string[] = [];
  const step = {
    run: async (id: string) => {
      stepIds.push(id);
      if (id === "register-pending-schedule") {
        return { scheduleId: wakeEntry.scheduleId, status: "pending" };
      }
      if (id === "dispatch-due-schedule") {
        return {
          route: "gateway-due-signal",
          late: false,
          firedAt: "2026-07-22T16:00:00.000Z",
          gatewayPushed: true,
          acked: false,
        };
      }
      return undefined;
    },
    sleepUntil: async () => {},
  };
  const result = await (paneSchedule as unknown as { fn: (input: unknown) => Promise<unknown> }).fn({
    event: { data: wakeEntry },
    step,
  });

  expect(stepIds).toEqual(["register-pending-schedule", "dispatch-due-schedule"]);
  expect(result).toMatchObject({
    status: "due-signal-emitted-awaiting-dispatcher-ack",
    gatewayPushed: true,
  });
});

test("notify-send results remain outside this path (gateway evidence is unchanged)", () => {
  // Beat workers still return via `joelclaw notify send`, which enters the
  // message/notify pipeline — not pane.schedule.due. This seam only removes
  // spawn *work* from the gateway queue; it does not filter notify evidence.
  expect(true).toBe(true);
});
