import {
  launchAgentState,
  probeWorkerDispatch,
  readCanaryState,
  writeCanaryState,
} from "../../lib/voice-canary";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

const COOLDOWN_MS = 30 * 60 * 1000;

export const voiceWorkerCanary = inngest.createFunction(
  { id: "voice-worker-canary", concurrency: { limit: 1 }, retries: 0 },
  { cron: "*/5 * * * *" },
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;
    const result = await step.run("probe-worker-dispatch", () => probeWorkerDispatch());
    const state = await step.run("read-canary-state", () => readCanaryState());

    if (result.ok) {
      if (state.lastOk === false) {
        await step.run("notify-recovery", async () =>
          gateway?.notify("voice.worker.recovered", {
            prompt: `Voice worker recovered; LiveKit dispatched it in ${result.joinMs}ms.`,
            priority: "normal",
          }),
        );
      }
      await step.run("write-healthy-state", () =>
        writeCanaryState({ ...state, lastOk: true, lastCause: undefined }),
      );
      return result;
    }

    const launchState = await step.run("inspect-launch-agent", () =>
      launchAgentState("com.joel.voice-agent"),
    );
    const message = `Voice worker canary FAILED: cause=${result.cause}; detail=${result.detail}; launchAgent=${launchState}; restart: launchctl kickstart -k gui/501/com.joel.voice-agent`;
    const now = Date.now();
    const coolingDown =
      state.lastCause === result.cause &&
      typeof state.lastPageAt === "number" &&
      now - state.lastPageAt < COOLDOWN_MS;

    if (!coolingDown) {
      await step.sendEvent("page-joel", {
        name: "notification/call.requested",
        data: { message },
      });
      await step.run("notify-gateway-urgent", async () =>
        gateway?.notify("voice.worker.failed", { prompt: message, priority: "urgent" }),
      );
    }

    await step.run("write-failed-state", () =>
      writeCanaryState({
        ...state,
        lastOk: false,
        lastCause: result.cause,
        lastPageAt: coolingDown ? state.lastPageAt : now,
      }),
    );
    return { ...result, launchState, paged: !coolingDown };
  },
);
