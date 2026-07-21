import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function runJson(command, args, options = {}) {
  const result = await execFile(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${command} returned non-JSON output: ${text.slice(0, 500)}`, { cause: error });
  }
}
