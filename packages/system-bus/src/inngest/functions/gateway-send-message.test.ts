import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NonRetriableError } from "inngest";
import Redis from "ioredis";
import * as telemetry from "../../observability/emit";
import { gatewaySendMessage } from "./gateway-send-message";

afterEach(() => mock.restore());

const handler = (
  gatewaySendMessage as unknown as {
    fn: (context: unknown) => Promise<unknown>;
  }
).fn;

describe("gateway/send.message retired", () => {
  test("fails non-retriably with producer and flow ID; never queues, publishes, or journals", async () => {
    const emit = spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
    const push = spyOn(Redis.prototype, "rpush").mockImplementation(() => {
      throw new Error("Redis forbidden");
    });
    const publish = spyOn(Redis.prototype, "publish").mockImplementation(() => {
      throw new Error("Redis forbidden");
    });
    const run = mock(async () => {
      throw new Error("queue step forbidden");
    });
    const context = {
      event: {
        id: "event-1",
        data: { text: "private body", audit: { producer: "fixture", flowId: "flow-1" } },
      },
      step: { run },
    };
    await expect(handler(context)).rejects.toBeInstanceOf(NonRetriableError);
    await expect(handler(context)).rejects.toThrow(
      "gateway outbound path retired: no consumer since the gateway was removed; use notifyJoel (producer=fixture, flowId=flow-1)",
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "gateway-send-message",
        action: "gateway.send.retired",
        success: false,
        metadata: { producer: "fixture", flowId: "flow-1", eventId: "event-1" },
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private body");
    expect(push).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const source = await Bun.file(new URL("gateway-send-message.ts", import.meta.url)).text();
    expect(source).not.toMatch(/ioredis|message-journal|buildQueuedGatewayMessage|rpush|publish/);
  });

  test("falls back to the event ID and stays non-retriable if telemetry fails", async () => {
    const emit = spyOn(telemetry, "emitOtelEvent").mockRejectedValue(new Error("telemetry down"));
    await expect(handler({ event: { id: "event-2", data: { text: "fixture" } } })).rejects.toThrow(
      "producer=gateway/send.message, flowId=event-2",
    );
    expect(emit).toHaveBeenCalled();
  });
});
