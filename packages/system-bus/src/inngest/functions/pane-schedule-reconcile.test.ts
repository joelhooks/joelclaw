import { expect, test } from "bun:test";
import {
  isPaneScheduleOverdue,
  PANE_SCHEDULE_LATE_AFTER_MS,
  PANE_SCHEDULE_RECONCILE_GRACE_MS,
} from "../../lib/pane-schedule";
import { paneScheduleReconcile, partitionPaneScheduleRegistry } from "./pane-schedule-reconcile";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

function entryAt(at: string, scheduleId = "sched-1"): string {
  return JSON.stringify({
    version: 1,
    scheduleId,
    verb: "wake",
    at,
    target: "observer",
    requestedBy: "test",
    createdAt: "2026-07-20T00:00:00.000Z",
  });
}

test("reconciler triggers on a five-minute cron and an explicit request event", () => {
  const triggers = (paneScheduleReconcile as unknown as { opts?: { triggers?: unknown[] } }).opts
    ?.triggers;
  expect(triggers).toEqual([
    { cron: "*/5 * * * *" },
    { event: "pane/schedule.reconcile.requested" },
  ]);
});

test("reconciler runs one at a time", () => {
  const opts = (paneScheduleReconcile as unknown as { opts?: { concurrency?: unknown } }).opts;
  expect(opts?.concurrency).toEqual({ limit: 1 });
});

test("overdue filtering respects the grace window", () => {
  const justInsideGrace = new Date(NOW - PANE_SCHEDULE_RECONCILE_GRACE_MS + 1_000).toISOString();
  const exactlyAtGrace = new Date(NOW - PANE_SCHEDULE_RECONCILE_GRACE_MS).toISOString();
  const wellPastGrace = new Date(NOW - PANE_SCHEDULE_RECONCILE_GRACE_MS - 60_000).toISOString();
  const future = new Date(NOW + 60_000).toISOString();

  expect(isPaneScheduleOverdue(justInsideGrace, NOW)).toBe(false);
  expect(isPaneScheduleOverdue(exactlyAtGrace, NOW)).toBe(true);
  expect(isPaneScheduleOverdue(wellPastGrace, NOW)).toBe(true);
  expect(isPaneScheduleOverdue(future, NOW)).toBe(false);
});

test("grace window is wider than the late threshold so healthy wakes never race", () => {
  expect(PANE_SCHEDULE_RECONCILE_GRACE_MS).toBeGreaterThan(PANE_SCHEDULE_LATE_AFTER_MS);
});

test("malformed registry entries are partitioned out instead of failing the sweep", () => {
  const { valid, malformed } = partitionPaneScheduleRegistry({
    "sched-good": entryAt("2026-07-20T11:00:00.000Z", "sched-good"),
    "sched-not-json": "{not json",
    "sched-bad-shape": JSON.stringify({ scheduleId: "sched-bad-shape" }),
  });

  expect(valid.map((entry) => entry.scheduleId)).toEqual(["sched-good"]);
  expect(malformed.map((entry) => entry.scheduleId).sort()).toEqual([
    "sched-bad-shape",
    "sched-not-json",
  ]);
  for (const entry of malformed) {
    expect(entry.issue.length).toBeGreaterThan(0);
    expect(entry.raw.length).toBeGreaterThan(0);
  }
});

test("empty registry partitions to nothing", () => {
  expect(partitionPaneScheduleRegistry({})).toEqual({ valid: [], malformed: [] });
});
