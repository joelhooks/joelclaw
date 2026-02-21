import type { AutoFixHandler } from "./index";

function trimOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output == null) return "";
  return String(output).trim();
}

export const restartWorker: AutoFixHandler = async () => {
  try {
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
