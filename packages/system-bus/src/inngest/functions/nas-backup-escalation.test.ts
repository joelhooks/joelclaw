import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as inference from "../../lib/inference";
import * as notification from "../../lib/notify-joel";
import * as telemetry from "../../observability/emit";
import { backupFailureRouter } from "./nas-backup";

afterEach(() => mock.restore());

const handler = (
  backupFailureRouter as unknown as {
    fn: (context: unknown) => Promise<unknown>;
  }
).fn;

function setup(action: "retry" | "escalate", notifyError?: Error) {
  spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
  const infer = spyOn(inference, "infer").mockResolvedValue({
    text: JSON.stringify({
      action,
      reason: "fixture decision",
      routeTo: "system/backup.redis",
      delayMs: 30_000,
    }),
  } as never);
  const notify = spyOn(notification, "notifyJoel");
  if (notifyError) notify.mockRejectedValue(notifyError);
  else notify.mockResolvedValue(undefined);
  const sendEvent = mock(async () => {
    throw new Error("event sends forbidden");
  });
  const steps: string[] = [];
  const context = {
    event: {
      id: "event-backup",
      name: "system/backup.failure.detected",
      data: {
        targetFunctionId: "system/backup.redis",
        target: "redis",
        attempt: 100,
        error: "permission denied",
      },
    },
    step: {
      run: async (id: string, operation: () => Promise<unknown>) => {
        steps.push(id);
        return operation();
      },
      sendEvent,
      sleep: mock(async () => {
        throw new Error("sleep forbidden");
      }),
    },
  };
  return { context, notify, sendEvent, steps, infer };
}

describe("backup escalation delivery", () => {
  test("direct escalation calls notifyJoel needs_joel inside a durable step", async () => {
    const { context, notify, sendEvent, steps } = setup("escalate");
    await expect(handler(context)).resolves.toMatchObject({ status: "escalated" });
    expect(steps).toEqual(["alert-backup-failure-escalated"]);
    expect(notify).toHaveBeenCalledWith({
      kind: "needs_joel",
      source: "nas-backup-escalation",
      message: expect.stringContaining("Backup failure escalated"),
    });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  test("notification failure propagates out of the step so Inngest retries", async () => {
    const failure = new notification.NotifyJoelError("http_error", "HTTP 503", 503);
    const { context, notify, sendEvent } = setup("escalate", failure);
    await expect(handler(context)).rejects.toBe(failure);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  // Enable the existing model-router switch to reach its retry-budget guard.
  // Inference remains mocked; no model, webhook, or Redis is contacted.
  test.skipIf(process.env.JOELCLAW_BACKUP_FAILURE_MODEL_ROUTER !== "1")(
    "retry-budget escalation uses its distinct source and also propagates delivery failure",
    async () => {
      const { context, notify, sendEvent, steps, infer } = setup("retry");
      await expect(handler(context)).resolves.toMatchObject({ status: "escalated" });
      expect(infer).toHaveBeenCalled();
      expect(steps).toEqual(["alert-backup-retry-budget-exceeded"]);
      expect(notify).toHaveBeenCalledWith({
        kind: "needs_joel",
        source: "nas-backup-retry-budget",
        message: expect.stringContaining("Backup retry budget exhausted"),
      });
      const failure = new notification.NotifyJoelError("missing_secret", "fixture unavailable");
      notify.mockRejectedValue(failure);
      await expect(handler(context)).rejects.toBe(failure);
      expect(sendEvent).not.toHaveBeenCalled();
    },
  );
});
