import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AutoFixHandler } from "./index";

const RESTART_STAMP_PATH = "/tmp/joelclaw/o11y-restart-worker.last";
const RESTART_COOLDOWN_MS = Number.parseInt(
  process.env.O11Y_RESTART_COOLDOWN_MS ?? "600000",
  10
);

function trimOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output == null) return "";
  return String(output).trim();
}

function readLastRestartMs(): number | null {
  try {
    const raw = readFileSync(RESTART_STAMP_PATH, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastRestartMs(value: number): void {
  try {
    mkdirSync(dirname(RESTART_STAMP_PATH), { recursive: true });
    writeFileSync(RESTART_STAMP_PATH, String(value), "utf8");
  } catch {
    // best-effort; cooldown stamp is advisory
  }
}

function formatMs(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

export const restartWorker: AutoFixHandler = async () => {
  try {
    if (RESTART_COOLDOWN_MS > 0) {
      const now = Date.now();
      const lastRestartMs = readLastRestartMs();
      if (lastRestartMs != null) {
        const elapsed = now - lastRestartMs;
        const remaining = RESTART_COOLDOWN_MS - elapsed;
        if (remaining > 0) {
          return {
            fixed: true,
            detail: `restart suppressed by cooldown (${formatMs(remaining)} remaining)`,
          };
        }
      }
    }

    const restart = await Bun.$`launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
      .quiet()
      .nothrow();
    if (restart.exitCode !== 0) {
      const stderr = trimOutput(restart.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0 ? `restart failed: ${stderr}` : `restart failed (exit ${restart.exitCode})`,
      };
    }

    await Bun.sleep(5000);

    const health = await Bun.$`curl -s http://127.0.0.1:3111/`.quiet().nothrow();
    if (health.exitCode !== 0) {
      const stderr = trimOutput(health.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0 ? `health check failed: ${stderr}` : `health check failed (exit ${health.exitCode})`,
      };
    }

    const body = trimOutput(health.stdout);
    if (body.length === 0) {
      return {
        fixed: false,
        detail: "health check failed: empty response from worker",
      };
    }

    writeLastRestartMs(Date.now());

    return {
      fixed: true,
      detail: "worker restarted and health endpoint responded",
    };
  } catch (error) {
    return {
      fixed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
