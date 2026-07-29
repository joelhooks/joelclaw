import { scheduleMorningDigest } from "../src/morning-digest-schedule";

try {
  const result = await scheduleMorningDigest();
  console.log(JSON.stringify({
    ok: true,
    command: "agent-comms arm-morning-digest",
    result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    command: "agent-comms arm-morning-digest",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
