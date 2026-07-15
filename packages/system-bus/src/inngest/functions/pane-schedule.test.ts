import { expect, test } from "bun:test";
import { paneSchedule } from "./pane-schedule";

test("pane schedule cancellation matches the schedule id", () => {
  const cancelOn = ((paneSchedule as unknown as { opts?: { cancelOn?: unknown[] } }).opts?.cancelOn ?? [])[0];
  expect(cancelOn).toEqual({ event: "pane/schedule.cancelled", match: "data.scheduleId" });
});
