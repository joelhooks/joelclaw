import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

export const heartbeatCron = inngest.createFunction(
  {
    id: "system-heartbeat",
  },
  [{ cron: "* * * * *" }],
  async ({ step }) => {
    await step.run("push-gateway-event", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);

export const heartbeatWake = inngest.createFunction(
  {
    id: "system-heartbeat-wake",
  },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    await step.run("push-gateway-event", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);
