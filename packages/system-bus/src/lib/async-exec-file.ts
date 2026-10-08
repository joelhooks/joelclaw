import { execFile } from "node:child_process";

export type RunExecFileResult =
  | { status: "success"; stdout: string; stderr: string }
  | {
      status: "failure";
      reason: "exit" | "timeout" | "spawn" | "output-limit";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      error: Error;
    };

export type RunExecFileOptions = {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
};

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  return value?.toString("utf8") ?? "";
}

/** Run one bounded child command without blocking the worker's event loop. */
export function runExecFile(
  file: string,
  args: readonly string[],
  options: RunExecFileOptions,
): Promise<RunExecFileResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 1_048_576,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = outputText(stdout);
        const errorOutput = outputText(stderr);

        if (!error) {
          resolve({ status: "success", stdout: output, stderr: errorOutput });
          return;
        }

        const code = error.code;
        const reason =
          code === "ETIMEDOUT" || error.killed === true
            ? "timeout"
            : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "output-limit"
              : typeof code === "number"
                ? "exit"
                : "spawn";
        resolve({
          status: "failure",
          reason,
          exitCode: typeof code === "number" ? code : null,
          stdout: output,
          stderr: errorOutput,
          error,
        });
      },
    );
  });
}
