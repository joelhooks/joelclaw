/**
 * Pi extension for DAG worker sessions.
 * 
 * Emits a heartbeat file on every turn so the shell handler
 * can detect activity (prevents Restate inactivity timeout).
 * Also writes OTEL-compatible events for observability.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HEARTBEAT_DIR = process.env.JOELCLAW_WORKER_HEARTBEAT_DIR || "/tmp/joelclaw-worker-heartbeat";
const HEARTBEAT_FILE = join(HEARTBEAT_DIR, "last-activity");

function touchHeartbeat() {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    writeFileSync(HEARTBEAT_FILE, `${Date.now()}\n`);
  } catch {
    // non-fatal — heartbeat is observability, not control flow
  }
}

export default function workerHeartbeat(pi: any) {
  // Heartbeat on session start
  pi.on("session_start", () => {
    touchHeartbeat();
  });

  // Heartbeat on every turn (agent thinking/responding)
  pi.on("turn_start", () => {
    touchHeartbeat();
  });

  pi.on("turn_end", () => {
    touchHeartbeat();
  });

  // Heartbeat on tool calls (file reads, writes, bash)
  pi.on("tool_call", () => {
    touchHeartbeat();
  });

  pi.on("tool_result", () => {
    touchHeartbeat();
  });
}
