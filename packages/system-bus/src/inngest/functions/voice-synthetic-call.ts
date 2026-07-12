import { execFileSync } from "node:child_process";
import { getTelnyxBalance } from "../../lib/telnyx";
import {
  leaseSecretStrict,
  livekitEnv,
  OUTBOUND_TRUNK_ID,
} from "../../lib/voice-canary";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

const LK = "/opt/homebrew/bin/lk";

export const voiceSyntheticCall = inngest.createFunction(
  { id: "voice-synthetic-call", concurrency: { limit: 1 }, retries: 0 },
  { cron: "TZ=America/Los_Angeles 5 12 * * *" },
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;
    const result = await step.run("place-synthetic-call", () => {
      const env = livekitEnv();
      const did = leaseSecretStrict("telnyx_phone_number");
      const room = `canary-synthetic-${Date.now()}`;
      const request = JSON.stringify({
        sip_trunk_id: OUTBOUND_TRUNK_ID,
        sip_call_to: did,
        room_name: room,
        participant_identity: "synthetic-canary",
        participant_name: "Synthetic Canary",
        wait_until_answered: true,
      });
      const started = Date.now();
      try {
        execFileSync(LK, ["sip", "participant", "create", "-"], {
          env,
          input: request,
          timeout: 60_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { ok: true as const, answerMs: Date.now() - started, room };
      } catch (error) {
        return { ok: false as const, detail: String(error), room };
      } finally {
        try {
          execFileSync(LK, ["room", "delete", room], { env, timeout: 10_000, stdio: "ignore" });
        } catch {
          // Best-effort cleanup.
        }
      }
    });

    if (result.ok) {
      if (result.answerMs > 30_000) {
        await step.run("warn-slow-answer", async () =>
          gateway?.notify("voice.synthetic.slow", {
            prompt: `Synthetic voice call answered slowly: ${result.answerMs}ms (limit 30000ms).`,
            priority: "normal",
          }),
        );
      }
      return result;
    }

    const balance = await step.run("fetch-telnyx-balance", async () => {
      try {
        return { ok: true as const, ...(await getTelnyxBalance()) };
      } catch (error) {
        return { ok: false as const, detail: String(error) };
      }
    });
    const cause =
      balance.ok && balance.availableCredit < 10
        ? "telnyx_balance_lapsed"
        : "synthetic_call_failed";
    const note = cause === "telnyx_balance_lapsed" ? " — this is how the old number died" : "";
    const balanceDetail = balance.ok
      ? `$${balance.availableCredit.toFixed(2)}`
      : `unavailable (${balance.detail})`;
    const message = `Voice synthetic call FAILED: cause=${cause}; detail=${result.detail}; Telnyx balance=${balanceDetail}${note}`;
    await step.sendEvent("page-joel", {
      name: "notification/call.requested",
      data: { message },
    });
    await step.run("notify-gateway-urgent", async () =>
      gateway?.notify("voice.synthetic.failed", { prompt: message, priority: "urgent" }),
    );
    return { ...result, cause, balance };
  },
);
