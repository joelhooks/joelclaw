import { expect, test } from "bun:test";
import { paneSchedule } from "./pane-schedule";

test("pane schedule cancellation matches the schedule id", () => {
  const cancelOn = ((paneSchedule as unknown as { opts?: { cancelOn?: unknown[] } }).opts?.cancelOn ?? [])[0];
  expect(cancelOn).toEqual({ event: "pane/schedule.cancelled", match: "data.scheduleId" });
});

test("2026-07-22 dispatcher failure keeps the pending schedule registered for retry", async () => {
  const stepIds: string[] = [];
  const step = {
    run: async (id: string) => {
      stepIds.push(id);
      if (id === "emit-due-signal") return "2026-07-22T16:00:00.000Z";
      return { scheduleId: "853efe38-4893-41a3-a078-b22766bdc52f", status: "pending" };
    },
    sleepUntil: async () => {},
  };
  const result = await (paneSchedule as unknown as { fn: (input: unknown) => Promise<unknown> }).fn({
    event: { data: {
      version: 1,
      scheduleId: "853efe38-4893-41a3-a078-b22766bdc52f",
      verb: "spawn",
      at: "2026-07-22T16:00:00.000Z",
      briefPath: "/repo/daily-flow.svx",
      requestedBy: "test",
      createdAt: "2026-07-22T15:00:00.000Z",
    } },
    step,
  });

  expect(stepIds).toEqual(["register-pending-schedule", "emit-due-signal"]);
  expect(result).toMatchObject({ status: "due-signal-emitted-awaiting-dispatcher-ack" });
});
