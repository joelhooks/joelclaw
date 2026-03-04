import * as restate from "@restatedev/restate-sdk";
import { services } from "./services";

restate.serve({
  services,
  port: 9080,
});
