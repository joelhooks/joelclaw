import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as guardrail from "../../lib/infra-recovery-guardrail";
import * as notification from "../../lib/notify-agent";
import * as telemetry from "../../observability/emit";
import { selfHealingRouter } from "./self-healing-router";

afterEach(() => mock.restore());
const handler = (selfHealingRouter as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;

for (const [source, data] of [
  ["self-healing-backup-blocked", { domain: "backup", attempt: 0 }],
  ["self-healing-retry-exhausted", { domain: "sdk-reachability", attempt: 0 }],
  ["self-healing-escalated", { domain: "sdk-reachability", attempt: 100 }],
] as const) {
  for (const owner of ["team/operator-1", "UPPER", "--unsafe", "a/b/c", "a_b", undefined]) {
    test(`${source} routes owner ${owner ?? "missing"} without a retired send`, async () => {
      spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
      spyOn(guardrail, "isInfraRecoveryModelRouterEnabled").mockReturnValue(false);
      const notify = spyOn(notification, "notifyAgent").mockResolvedValue(undefined);
      const steps: string[] = [];
      const sendEvent = mock(async (_id: string, event: { name: string }) => {
        expect(event.name).toBe("system/self.healing.completed");
      });
      const ctx = {
        event: {
          id: "fixture-event",
          name: "system/self.healing.requested",
          data: {
            sourceFunction: "fixture-source",
            targetComponent: "fixture-target",
            problemSummary: "fixture failure",
            ...data,
            owner,
          },
        },
        step: {
          run: async (id: string, fn: () => Promise<unknown>) => {
            steps.push(id);
            return fn();
          },
          sendEvent,
          sleep: () => {
            throw new Error("unexpected retry");
          },
        },
      };
      await handler(ctx);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          to: owner === "team/operator-1" ? owner : "switchboard/ea",
          source,
          summary: expect.any(String),
          message: expect.stringContaining("Self-healing"),
        }),
      );
      expect(steps).toHaveLength(1);
      const failure = new notification.NotifyAgentUncertainError("uncertain", 3);
      notify.mockRejectedValue(failure);
      await expect(handler(ctx)).rejects.toBe(failure);
    });
  }
}
