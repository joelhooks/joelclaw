import { expect, test } from "bun:test";
import { agentUsageScan } from "./agent-usage-scan";
import { heartbeatCron } from "./heartbeat";
import { o11yTriage } from "./o11y-triage";
import { paneScheduleReconcile } from "./pane-schedule-reconcile";
import { voiceWorkerCanary } from "./voice-worker-canary";

type ScheduledFunction = {
  opts?: { triggers?: Array<{ cron?: string }> };
};

function registeredCrons(fn: unknown): string[] {
  return (fn as ScheduledFunction).opts?.triggers?.flatMap((trigger) =>
    trigger.cron ? [trigger.cron] : [],
  ) ?? [];
}

test("periodic host jobs use distinct off-phase cron minutes", () => {
  const schedules = [
    { name: "pane schedule reconcile", cron: registeredCrons(paneScheduleReconcile)[0] },
    { name: "agent usage scan", cron: registeredCrons(agentUsageScan)[0] },
    { name: "heartbeat", cron: registeredCrons(heartbeatCron)[0] },
    { name: "voice worker canary", cron: registeredCrons(voiceWorkerCanary)[0] },
    { name: "o11y triage", cron: registeredCrons(o11yTriage)[0] },
  ];

  expect(schedules.map(({ cron }) => cron)).toEqual([
    "1-59/5 * * * *",
    "2-59/15 * * * *",
    "7-59/15 * * * *",
    "4-59/5 * * * *",
    "TZ=America/Los_Angeles 12-59/15 * * * *",
  ]);

  const quarterMarks = new Set([0, 15, 30, 45]);
  const occupiedMinutes = new Map<number, string>();

  for (const { name, cron } of schedules) {
    const expression = cron?.replace(/^TZ=[^ ]+ /, "");
    const minuteField = expression?.split(" ")[0];
    const match = minuteField?.match(/^(\d+)-59\/(\d+)$/);
    expect(match, `${name} uses an offset range cron`).not.toBeNull();
    if (!match) continue;

    const firstMinute = Number(match[1]);
    const intervalMinutes = Number(match[2]);
    for (let minute = firstMinute; minute < 60; minute += intervalMinutes) {
      expect(quarterMarks.has(minute), `${name} fires at :${minute}`).toBe(false);
      expect(occupiedMinutes.has(minute), `${name} overlaps ${occupiedMinutes.get(minute)}`).toBe(
        false,
      );
      occupiedMinutes.set(minute, name);
    }
  }
});
