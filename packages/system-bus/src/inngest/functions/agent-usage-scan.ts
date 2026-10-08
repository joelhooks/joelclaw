/**
 * Passive agent-usage capture: tail Pi / Claude Code / Codex transcripts on a
 * schedule and emit normalized usage events into the OTEL pipeline. Reads ~
 * paths, so it registers on the host worker only.
 */

import { scanAgentUsage } from "../../lib/agent-usage/scanner";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const agentUsageScan = inngest.createFunction(
  {
    id: "system/agent-usage.scan",
    name: "Agent Usage Scan",
    concurrency: { limit: 1 },
    retries: 0,
  },
  [{ cron: "2-59/15 * * * *" }, { event: "system/agent-usage.scan.requested" }],
  async ({ step }) => {
    const summary = await step.run("scan-agent-transcripts", async () => {
      return scanAgentUsage();
    });

    await step.run("emit-scan-summary", async () => {
      await emitOtelEvent({
        level: summary.oversizedFiles > 0 ? "warn" : "info",
        source: "agent-usage",
        component: "agent-usage",
        action: "agent_usage.scan.summary",
        success: true,
        metadata: summary,
      });
    });

    return { status: "ok", ...summary };
  },
);
