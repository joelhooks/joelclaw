/**
 * Pi extension: Worker Heartbeat
 * 
 * Touches a heartbeat file on every turn and tool call.
 * Prevents Restate inactivity timeout by proving the agent is working.
 * Also provides observability into agent activity within DAG nodes.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HEARTBEAT_DIR = process.env.JOELCLAW_WORKER_HEARTBEAT_DIR || "/tmp/joelclaw-worker-heartbeat";
const HEARTBEAT_FILE = join(HEARTBEAT_DIR, "last-activity");
const LOG_FILE = join(HEARTBEAT_DIR, "activity.log");

let turnCount = 0;
let toolCallCount = 0;

function touchHeartbeat(event: string) {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    const now = Date.now();
    writeFileSync(HEARTBEAT_FILE, `${now}\n`);
    writeFileSync(LOG_FILE, `${new Date(now).toISOString()} ${event} turns=${turnCount} tools=${toolCallCount}\n`, { flag: "a" });
  } catch {
    // non-fatal
  }
}

export default function workerHeartbeat(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    turnCount = 0;
    toolCallCount = 0;
    touchHeartbeat("session_start");
  });

  pi.on("turn_start", () => {
    turnCount++;
    touchHeartbeat("turn_start");
  });

  pi.on("turn_end", () => {
    touchHeartbeat("turn_end");
  });

  pi.on("tool_call", () => {
    toolCallCount++;
    touchHeartbeat("tool_call");
  });

  pi.on("tool_result", () => {
    touchHeartbeat("tool_result");
  });

  pi.on("session_shutdown", () => {
    touchHeartbeat("session_shutdown");
  });
}
