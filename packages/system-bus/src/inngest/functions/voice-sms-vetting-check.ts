import {
  attachNumberToCampaign,
  isNumberAttachedToCampaign,
  tryDeleteCampaign,
} from "../../lib/telnyx";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

/**
 * Daily 10DLC vetting watch for the public ShitRat SMS line.
 * Replaces the flagg LaunchAgent com.joelclaw.sms-vetting-check (remove the
 * agent once this function is verified live — overlap is harmless, both are
 * idempotent). Full context: ~/.brain/projects/public-shitrat-line-sms.svx
 */
const PUBLIC_DID = "+13609258342";
const CAMPAIGN_ID = "4b30019f-5c00-f617-8e3c-bda78fb2fda1";
// First submission, missing subUsecases; undeletable while TCR holds it.
const SUPERSEDED_CAMPAIGN_ID = "4b30019f-5bf8-c0c8-c836-616b50a35694";

export const voiceSmsVettingCheck = inngest.createFunction(
  { id: "voice-sms-vetting-check", retries: 1 },
  { cron: "23 9 * * *" },
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;

    await step.run("cleanup-superseded-campaign", () =>
      tryDeleteCampaign(SUPERSEDED_CAMPAIGN_ID),
    );

    const alreadyAttached = await step.run("check-existing-attachment", () =>
      isNumberAttachedToCampaign(PUBLIC_DID),
    );
    if (alreadyAttached) return { done: true, attached: "already" };

    const attach = await step.run("attach-did-to-campaign", () =>
      attachNumberToCampaign(PUBLIC_DID, CAMPAIGN_ID),
    );

    if (attach.result === "attached") {
      await step.run("notify-joel", async () =>
        gateway?.notify("voice.sms.vetting", {
          prompt:
            `ShitRat SMS: 10DLC campaign cleared vetting — ${PUBLIC_DID} is attached ` +
            "and the public line can text back. The docent reply handler " +
            "(voice-public-sms-reply) goes live with the next worker deploy. " +
            "You can remove LaunchAgent com.joelclaw.sms-vetting-check now.",
          priority: "normal",
        }),
      );
      return { done: true, attached: "now" };
    }

    if (attach.result === "failed") {
      await step.run("notify-joel-failure", async () =>
        gateway?.notify("voice.sms.vetting", {
          prompt:
            `ShitRat SMS: 10DLC attach for ${PUBLIC_DID} failed unexpectedly — ` +
            `check campaign ${CAMPAIGN_ID}. ${attach.detail ?? ""}`,
          priority: "normal",
        }),
      );
      return { done: false, attached: "failed", detail: attach.detail };
    }

    // pending (10036) or transient (10007): quiet, try again tomorrow.
    return { done: false, attached: attach.result };
  },
);
