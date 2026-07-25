import { expect, test } from "bun:test";
import {
  isPaneScheduleOverdue,
  PANE_SCHEDULE_LATE_AFTER_MS,
  PANE_SCHEDULE_RECONCILE_GRACE_MS,
} from "../../lib/pane-schedule";
import { paneScheduleReconcile, partitionPaneScheduleRegistry } from "./pane-schedule-reconcile";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

function entryAt(at: string, scheduleId = "sched-1", verb: "wake" | "spawn" = "wake"): string {
  return JSON.stringify({
    version: 1,
    scheduleId,
    verb,
    at,
    ...(verb === "wake" ? { target: "observer" } : { briefPath: "/repo/beat.svx" }),
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

test("reconciler recovers overdue wake work without deleting dispatcher-owned pending state", async () => {
  const schedule = JSON.parse(entryAt("2026-07-20T11:00:00.000Z", "853efe38-4893-41a3-a078-b22766bdc52f"));
  const stepIds: string[] = [];
  const step = {
    run: async (id: string, operation: () => unknown) => {
      stepIds.push(id);
      if (id === "read-pending-registry") return { scanned: 1, valid: [schedule], quarantined: [] };
      if (id === "select-overdue") return operation();
      if (id.startsWith("recover-due-")) {
        return {
          scheduleId: "853efe38-4893-41a3-a078-b22766bdc52f",
          firedAt: "2026-07-20T12:00:00.000Z",
          route: "gateway-due-signal",
          acked: false,
        };
      }
      throw new Error(`unexpected step: ${id}`);
    },
  };
  const result = await (paneScheduleReconcile as unknown as { fn: (input: unknown) => Promise<unknown> }).fn({ step });

  expect(stepIds).toEqual([
    "read-pending-registry",
    "select-overdue",
    "recover-due-853efe38-4893-41a3-a078-b22766bdc52f",
  ]);
  expect(result).toMatchObject({ recovered: ["853efe38-4893-41a3-a078-b22766bdc52f"] });
});

test("reconciler routes overdue spawn recoveries through the mechanical branch", async () => {
  const schedule = JSON.parse(
    entryAt("2026-07-20T11:00:00.000Z", "spawn-overdue-1", "spawn"),
  );
  const stepIds: string[] = [];
  const step = {
    run: async (id: string, operation: () => unknown) => {
      stepIds.push(id);
      if (id === "read-pending-registry") return { scanned: 1, valid: [schedule], quarantined: [] };
      if (id === "select-overdue") return operation();
      if (id.startsWith("recover-due-")) {
        // The production step calls dispatchDuePaneSchedule. Here we assert the
        // function still invokes a recover step for spawn entries (mechanical
        // path is covered unit-wise in pane-schedule.test.ts).
        return {
          scheduleId: "spawn-overdue-1",
          firedAt: "2026-07-20T12:00:00.000Z",
          route: "mechanical-spawn",
          acked: true,
          spawnStatus: "reused",
        };
      }
      throw new Error(`unexpected step: ${id}`);
    },
  };
  const result = await (paneScheduleReconcile as unknown as { fn: (input: unknown) => Promise<unknown> }).fn({
    step,
  });
  expect(stepIds).toContain("recover-due-spawn-overdue-1");
  expect(result).toMatchObject({ recovered: ["spawn-overdue-1"] });
});
