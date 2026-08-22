import { execFileSync } from "node:child_process";

import type { InstallableRuntime } from "./installer.js";

const runtimeProcessPattern: Record<InstallableRuntime, RegExp> = {
  claude: /(?:^|[\\/ ])claude(?:$|[ /])/iu,
  codex: /(?:^|[\\/ ])codex(?:$|[ /])/iu,
  cursor: /Cursor Agent|cursor-agent/iu,
  grok: /(?:^|[\\/ ])grok(?:$|[ /])/iu,
  pi: /(?:^|[\\/ ])pi(?:$|[ /])/iu,
};

export const runtimeProcessIsIdle = (
  runtime: InstallableRuntime,
  processes?: string,
  currentPid = process.pid,
): boolean => {
  try {
    const output =
      processes ??
      execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    return output.split(/\r?\n/u).every((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/u);
      const command = match?.[2] ?? "";
      return (
        match === null ||
        Number(match[1]) === currentPid ||
        command.includes("flowing-memory-host") ||
        command.includes("dist/cli.js") ||
        !runtimeProcessPattern[runtime].test(command.split(/\s+/u)[0] ?? "")
      );
    });
  } catch {
    return false;
  }
};
