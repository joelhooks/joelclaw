import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIntakeHandler } from "../src/intake/server";
import { openIntake } from "../src/intake/store";

const root = process.argv[2]!;
const store = openIntake(root);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: createIntakeHandler({
    store,
    ingestToken: "ingest",
    pullToken: "pull",
    principal: { user_id: "test" },
    beforeBlobSync: () => {
      writeFileSync(join(root, "crash-boundary"), "before-fsync");
      process.kill(process.pid, "SIGKILL");
    },
  }),
});
console.log(JSON.stringify({ port: server.port }));
await new Promise(() => undefined);
