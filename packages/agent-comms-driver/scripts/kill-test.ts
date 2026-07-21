import { resolve } from "node:path";

import { runKillDrill } from "../src/kill-test";
import { makeLiveKillDrillPorts } from "../src/kill-test-live";

const LIVE_CONFIRMATION = "--confirm-live-gateway-kill";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (!process.argv.includes(LIVE_CONFIRMATION)) {
  console.error([
    "Refusing to run the real gateway kill drill without explicit confirmation.",
    "This script closes the configured gateway pane and sends a real Telegram DM.",
    `Run again with ${LIVE_CONFIRMATION} during the supervised cutover sitting.`,
  ].join("\n"));
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
const ports = makeLiveKillDrillPorts({
  agentTarget: required("GATEWAY_AGENT_TARGET"),
  successorBriefPath: resolve(required("GATEWAY_SUCCESSOR_BRIEF_PATH")),
  redisUrl: process.env.REDIS_URL?.trim(),
  heartbeatKey: process.env.GATEWAY_HEARTBEAT_KEY?.trim(),
  receiptPath: process.env.GATEWAY_KILL_DRILL_RECEIPT_PATH?.trim()
    ?? "/tmp/joelclaw/agent-comms-kill-drill.jsonl",
});

try {
  const result = await runKillDrill(ports, {
    date,
    heartbeatTtlMs: Number(process.env.GATEWAY_HEARTBEAT_TTL_MS ?? 60_000),
    assertionTimeoutMs: Number(process.env.GATEWAY_KILL_DRILL_TIMEOUT_MS ?? 120_000),
    pollIntervalMs: Number(process.env.GATEWAY_KILL_DRILL_POLL_MS ?? 1_000),
  });
  console.log(JSON.stringify({ ok: true, command: "agent-comms kill-drill", result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    command: "agent-comms kill-drill",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await ports.close();
}
