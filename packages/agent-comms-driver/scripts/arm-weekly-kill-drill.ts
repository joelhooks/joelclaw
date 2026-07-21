import { resolve } from "node:path";

import { scheduleWeeklyKillDrill } from "../src/kill-test-live";

const repoRoot = resolve(import.meta.dir, "../../..");

try {
  const result = await scheduleWeeklyKillDrill(repoRoot);
  console.log(JSON.stringify({
    ok: true,
    command: "agent-comms arm-weekly-kill-drill",
    result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    command: "agent-comms arm-weekly-kill-drill",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
