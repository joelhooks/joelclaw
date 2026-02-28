import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("langfuse-cost optional dependency loading", () => {
  test("module import does not crash when langfuse is unavailable", () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
    const script = `
      import(${JSON.stringify(moduleUrl)})
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(error?.stack || error?.message || String(error));
          process.exit(1);
        });
    `;

    const run = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: "",
        LANGFUSE_SECRET_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(run.stderr);

    expect(run.exitCode).toBe(0);
    expect(stderr).not.toContain("Cannot find package 'langfuse'");
    expect(stderr).not.toContain("Cannot find module 'langfuse'");
  });
});
