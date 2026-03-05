import * as restate from "@restatedev/restate-sdk";
import { services } from "./services";

const port = Number(process.env.RESTATE_PILOT_PORT ?? 9080);

restate.serve({
  services,
  port,
});
