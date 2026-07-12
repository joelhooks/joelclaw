import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LK = "/opt/homebrew/bin/lk";
const STATE_PATH = join(homedir(), ".joelclaw/state/voice-canary.json");

export const OUTBOUND_TRUNK_ID = "ST_KAQ9ZS6xW6Fo"; // must match call-joel.sh

export type CanaryState = {
  lastPageAt?: number;
  lastCause?: string;
  lastOk?: boolean;
};

export function leaseSecretStrict(name: string): string {
  const value = execFileSync("secrets", ["lease", name, "--ttl", "5m"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!value || value.startsWith("{")) throw new Error(`invalid lease for ${name}`);
  return value;
}

export function livekitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LIVEKIT_URL: leaseSecretStrict("livekit_url"),
    LIVEKIT_API_KEY: leaseSecretStrict("livekit_api_key"),
    LIVEKIT_API_SECRET: leaseSecretStrict("livekit_api_secret"),
  };
}

export type WorkerDispatchResult =
  | { ok: true; joinMs: number }
  | { ok: false; cause: "lease_failed" | "livekit_unreachable" | "worker_not_dispatched"; detail: string };

export function probeWorkerDispatch(): WorkerDispatchResult {
  let env: NodeJS.ProcessEnv;
  try {
    env = livekitEnv();
  } catch (error) {
    return { ok: false, cause: "lease_failed", detail: String(error) };
  }

  const room = `canary-worker-${Date.now()}`;
  try {
    try {
      execFileSync(LK, ["room", "create", room], { env, timeout: 15_000, stdio: "pipe" });
    } catch (error) {
      return { ok: false, cause: "livekit_unreachable", detail: String(error) };
    }

    const started = Date.now();
    while (Date.now() - started < 20_000) {
      try {
        const output = execFileSync(LK, ["room", "participants", "list", room], {
          env,
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (/agent-[\w-]+/.test(output)) return { ok: true, joinMs: Date.now() - started };
      } catch {
        // Room exists; a participant may not have joined yet.
      }
      execFileSync("sleep", ["2"]);
    }
    return { ok: false, cause: "worker_not_dispatched", detail: "no agent-* participant within 20s" };
  } finally {
    try {
      execFileSync(LK, ["room", "delete", room], { env, timeout: 10_000, stdio: "ignore" });
    } catch {
      // Best-effort cleanup.
    }
  }
}

export function launchAgentState(label: string): "running" | "not-running" | "not-loaded" {
  try {
    const output = execFileSync("launchctl", ["print", `gui/501/${label}`], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /state\s*=\s*running/.test(output) ? "running" : "not-running";
  } catch {
    return "not-loaded";
  }
}

export function readCanaryState(): CanaryState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as CanaryState;
  } catch {
    return {};
  }
}

export function writeCanaryState(state: CanaryState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
