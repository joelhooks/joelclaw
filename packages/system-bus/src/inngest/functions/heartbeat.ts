/**
 * System heartbeat — pure fan-out dispatcher.
 * ADR-0062: Heartbeat-Driven Task Triage
 *
 * Every 15 minutes, emits events for independent check functions.
 * Each check function owns its own cooldown, retries, and gateway notification.
 * The heartbeat itself does NO work — it just says "time to check everything."
 *
 * The final step pushes cron.heartbeat to the gateway, which triggers
 * the HEARTBEAT.md checklist in the gateway session.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const HEARTBEAT_EVENTS = [
  { name: "tasks/triage.requested" as const, data: {} },
  { name: "sessions/prune.requested" as const, data: {} },
  { name: "triggers/audit.requested" as const, data: {} },
  { name: "system/health.requested" as const, data: {} },
  { name: "memory/review.check" as const, data: {} },
  { name: "vault/sync.check" as const, data: {} },
  { name: "granola/check.requested" as const, data: {} },
  { name: "email/triage.requested" as const, data: {} },
  { name: "calendar/daily.check" as const, data: {} },
  { name: "loops/stale.check" as const, data: {} },
];

export const heartbeatCron = inngest.createFunction(
  { id: "system-heartbeat" },
  [{ cron: "*/15 * * * *" }],
  async ({ step }) => {
    // Fan out all checks as independent events
    await step.sendEvent("fan-out-checks", HEARTBEAT_EVENTS);

    // Push cron.heartbeat to gateway — triggers HEARTBEAT.md checklist
    await step.run("push-gateway-heartbeat", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);

export const heartbeatWake = inngest.createFunction(
  { id: "system-heartbeat-wake" },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    // Same fan-out on manual wake
    await step.sendEvent("fan-out-checks", HEARTBEAT_EVENTS);

    await step.run("push-gateway-heartbeat", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);
