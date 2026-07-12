import { leaseSecretStrict } from "../../lib/voice-canary";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

export const voiceMissedCall = inngest.createFunction(
  { id: "voice-missed-call", retries: 0 },
  { event: "telnyx/call.initiated" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;
    const did = await step.run("lease-voice-did", () => leaseSecretStrict("telnyx_phone_number"));
    const direction = String(event.data.direction ?? "");
    const to = String(event.data.to ?? "");
    const from = String(event.data.from ?? "");
    const callSessionId = String(event.data.call_session_id ?? "");

    if (direction !== "incoming" || to !== did || from === did || !callSessionId) {
      return { skipped: true };
    }

    const answered = await step.waitForEvent("wait-for-answer", {
      event: "telnyx/call.answered",
      timeout: "45s",
      if: "event.data.call_session_id == async.data.call_session_id",
    });
    if (answered) return { answered: true };

    const message = `Missed call from ${from || "unknown"} — voice worker did not answer within 45s`;
    await step.sendEvent("page-joel", {
      name: "notification/call.requested",
      data: { message },
    });
    await step.run("notify-gateway-urgent", async () =>
      gateway?.notify("voice.call.missed", { prompt: message, priority: "urgent" }),
    );
    return { answered: false, from, callSessionId };
  },
);
