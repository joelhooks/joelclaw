import { describe, expect, test } from "bun:test";
import { runExecFile } from "./async-exec-file";

describe("runExecFile", () => {
  test("keeps the event loop responsive while a child runs", async () => {
    let childSettled = false;
    const child = runExecFile(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('child finished'), 150)"],
      { timeoutMs: 1_000 },
    ).then((result) => {
      childSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(childSettled).toBe(false);
    expect(await child).toEqual({
      status: "success",
      stdout: "child finished",
      stderr: "",
    });
  });

  test("returns a typed failure when the command exits nonzero", async () => {
    const result = await runExecFile(
      process.execPath,
      ["-e", "process.stderr.write('bad'); process.exit(7)"],
      { timeoutMs: 1_000 },
    );

    expect(result).toMatchObject({
      status: "failure",
      reason: "exit",
      exitCode: 7,
      stdout: "",
      stderr: "bad",
    });
  });

  test("kills a command that exceeds its timeout", async () => {
    const result = await runExecFile(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      timeoutMs: 30,
    });

    expect(result).toMatchObject({
      status: "failure",
      reason: "timeout",
    });
  });
});
