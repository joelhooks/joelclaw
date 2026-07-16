import { describe, expect, mock, test } from "bun:test";
import type { GatewaySendMessageData } from "../../lib/channel-delivery-audit";
import { sendContentReviewToGateway } from "./content-review";

type GatewayMessageEvent = {
  name: "gateway/send.message";
  data: GatewaySendMessageData;
};

describe("content-review delivery", () => {
  test("queues the message and keyboard with producer attribution", async () => {
    const calls: Array<[string, GatewayMessageEvent]> = [];
    const sendEvent = mock(async (stepId: string, event: GatewayMessageEvent) => {
      calls.push([stepId, event]);
      return { ids: ["mock-event-id"] };
    });
    const inlineKeyboard = [
      [{ text: "Open review", callback_data: "content:open:telegram-signal-system" }],
    ];

    await sendContentReviewToGateway(
      sendEvent,
      "✅ <b>Feedback applied</b>",
      inlineKeyboard,
    );

    expect(calls).toEqual([
      [
        "notify-operator-telegram",
        {
          name: "gateway/send.message",
          data: {
            channel: "telegram",
            text: "✅ <b>Feedback applied</b>",
            audit: { producer: "content-review" },
            inline_keyboard: inlineKeyboard,
          },
        },
      ],
    ]);
  });
});
