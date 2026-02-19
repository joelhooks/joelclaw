/**
 * Trigger drift audit — detect silent function misregistration.
 * Extracted from heartbeat. Only notifies gateway on drift.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { auditTriggers } from "./trigger-audit";

export const checkTriggers = inngest.createFunction(
  { id: "check/trigger-audit", concurrency: { limit: 1 }, retries: 1 },
  { event: "triggers/audit.requested" },
  async ({ step }) => {
    const audit = await step.run("audit-triggers", async () => {
      try {
        return await auditTriggers();
      } catch (err) {
        return { ok: true, checked: 0, drifted: [] as string[], missing: [] as string[], extra: [] as string[], error: String(err) };
      }
    });

    // NOOP: only notify gateway when triggers have drifted
    if (!audit.ok) {
      await step.run("notify-drift", async () => {
        await pushGatewayEvent({
          type: "cron.heartbeat.drift",
          source: "inngest/check-triggers",
          payload: {
            prompt: [
              "## ⚠️ Trigger Drift Detected",
              "",
              `**Drifted:** ${audit.drifted?.join(", ") || "none"}`,
              `**Missing:** ${audit.missing?.join(", ") || "none"}`,
              "",
              "Worker may need restart: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`",
            ].join("\n"),
          },
        });
      });
    }

    return { status: audit.ok ? "noop" : "drift-detected", ...audit };
  }
);
