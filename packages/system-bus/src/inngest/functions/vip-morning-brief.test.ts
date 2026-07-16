import { describe, expect, mock, test } from "bun:test";
import type { GatewaySendMessageData } from "../../lib/channel-delivery-audit";
import { sendVipMorningBriefToGateway } from "./vip-morning-brief";

type GatewayMessageEvent = {
  name: "gateway/send.message";
  data: GatewaySendMessageData;
};

describe("vip-morning-brief delivery", () => {
  test("queues the existing message and keyboard with producer attribution", async () => {
    const calls: Array<[string, GatewayMessageEvent]> = [];
    const sendEvent = mock(async (stepId: string, event: GatewayMessageEvent) => {
      calls.push([stepId, event]);
      return { ids: ["mock-event-id"] };
    });
    const inlineKeyboard = [
      [{ text: "Open VIP thread", callback_data: "vip:open:cnv_123" }],
    ];

    await sendVipMorningBriefToGateway(sendEvent, "<b>VIP morning brief</b>", inlineKeyboard);

    expect(calls).toEqual([
      [
        "notify-telegram",
        {
          name: "gateway/send.message",
          data: {
            channel: "telegram",
            text: "<b>VIP morning brief</b>",
            audit: { producer: "vip-morning-brief" },
            inline_keyboard: inlineKeyboard,
          },
        },
      ],
    ]);
  });
});
