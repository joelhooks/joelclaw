import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as notification from "../../lib/notify-agent";
import * as telemetry from "../../observability/emit";
import { dailyTokenUsageReport } from "./daily-token-usage-report";

afterEach(() => mock.restore());
const handler = (dailyTokenUsageReport as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;

test("daily report routes quietly to the agent inside a durable step and propagates failures", async () => {
  spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
  const notify = spyOn(notification, "notifyAgent").mockResolvedValue(undefined);
  const steps: string[] = [];
  const ctx = {
    step: {
      run: async (id: string, fn: () => Promise<unknown>) => {
        steps.push(id);
        if (id === "collect-clickhouse-usage")
          return {
            ok: true,
            totals: {
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              usageCoveragePct: 0,
              costTotal: 0,
            },
            topModels: [],
            topComponents: [],
            perMachine: [],
          };
        if (id === "collect-inngest-runs") return { ok: true, command: "fixture", json: {} };
        if (id === "scan-codex-automation-health")
          return { sessions: 0, activeNames: [], credits: [] };
        return fn();
      },
      sendEvent: () => {
        throw new Error("retired sends forbidden");
      },
    },
  };
  await expect(handler(ctx)).resolves.toMatchObject({ status: "sent" });
  expect(steps).toContain("send-token-usage-report");
  expect(notify).toHaveBeenCalledWith({
    to: "switchboard/ea",
    quiet: true,
    source: "daily-token-usage-report",
    summary: "Daily token usage report",
    message: expect.stringContaining("daily token report"),
  });
  const failure = new notification.NotifyAgentUncertainError("uncertain", 3);
  notify.mockRejectedValue(failure);
  await expect(handler(ctx)).rejects.toBe(failure);
});
