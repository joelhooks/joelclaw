import { getTelnyxBalance } from "../../lib/telnyx";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

export const voiceTelnyxBalance = inngest.createFunction(
  { id: "voice-telnyx-balance", retries: 1 },
  { cron: "0 */6 * * *" },
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;
    const balance = await step.run("fetch-telnyx-balance", () => getTelnyxBalance());
    const figure = `$${balance.availableCredit.toFixed(2)} ${balance.currency}`;

    if (balance.availableCredit < 10) {
      const message = `Telnyx voice balance critical: ${figure}`;
      await step.sendEvent("page-joel", {
        name: "notification/call.requested",
        data: { message },
      });
      await step.run("notify-gateway-urgent", async () =>
        gateway?.notify("voice.telnyx.balance", { prompt: message, priority: "urgent" }),
      );
      return { ...balance, severity: "critical" };
    }

    if (balance.availableCredit < 25) {
      await step.run("notify-gateway-warning", async () =>
        gateway?.notify("voice.telnyx.balance", {
          prompt: `Telnyx voice balance low: ${figure}`,
          priority: "normal",
        }),
      );
      return { ...balance, severity: "warning" };
    }

    return { ...balance, severity: "ok" };
  },
);
