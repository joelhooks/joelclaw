// Operator script: compose the fixture digest and print the exact Telegram
// payload for review. Sends nothing. Run: bun run scripts/print-digest-payload.ts
import Redis from "ioredis";
import { composeFixtureDigestPrototype } from "../src/digest-gateway";

const redis = new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: true });

async function main() {
  await redis.connect();
  const prototype = await composeFixtureDigestPrototype(redis as never);
  if (prototype.result.kind !== "ready") {
    console.log("digest result:", prototype.result.kind, "— nothing to send");
    return;
  }
  console.log("[digest:telegram-payload]");
  console.log(JSON.stringify(prototype.result.payload, null, 2));
}

main()
  .catch((error) => {
    console.error("failed:", error);
    process.exitCode = 1;
  })
  .finally(() => redis.disconnect());
