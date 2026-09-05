import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const sweepScript = path.join(repositoryRoot, "scripts", "capture-native-sessions.sh");

test("native capture sweep rejects an unknown mode before running any runtime", async () => {
  const process = Bun.spawn(["bash", sweepScript], {
    cwd: repositoryRoot,
    env: {
      ...Bun.env,
      BUN_BIN: "/fixture/missing-bun",
      JOELCLAW_CAPTURE_MODE: "aplpy",
      JOELCLAW_REPO_ROOT: repositoryRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain('"error":"config-invalid"');
});

test("native capture sweep continues after one runtime fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "native-capture-sweep-"));
  const bin = path.join(home, "bin");
  const callsPath = path.join(home, "calls.txt");
  const fakeBun = path.join(bin, "bun");
  await mkdir(bin, { recursive: true });
  await writeFile(
    fakeBun,
    `#!/usr/bin/env bash
set -u
runtime=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--runtime" ]]; then runtime="$2"; shift 2; else shift; fi
done
printf '%s\\n' "$runtime" >> "$CALLS_PATH"
if [[ "$runtime" == "cursor" ]]; then exit 23; fi
printf '%s\\n' '{"ok":true}'
`,
  );
  await chmod(fakeBun, 0o755);

  try {
    const process = Bun.spawn(["bash", sweepScript], {
      cwd: repositoryRoot,
      env: {
        ...Bun.env,
        BUN_BIN: fakeBun,
        CALLS_PATH: callsPath,
        HOME: home,
        JOELCLAW_CAPTURE_MODE: "dry-run",
        JOELCLAW_CAPTURE_RUNTIMES: "cursor grok",
        JOELCLAW_REPO_ROOT: repositoryRoot,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toEqual([
      "cursor",
      "grok",
    ]);
    expect(stdout).toContain('"runtime":"grok"');
    expect(stderr).toContain('"runtime":"cursor"');
    expect(stderr).toContain('"error":"runtime-failed"');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
