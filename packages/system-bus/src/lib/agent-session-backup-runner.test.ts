import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSessionBackup } from "./agent-session-backup-runner";

let fixtureRoot: string | undefined;
const ownedPids: number[] = [];
afterEach(async () => {
  for (const pid of ownedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function runFake(source: string, timeoutMs = 2_000) {
  return runAgentSessionBackup({
    command: [process.execPath, "-e", source],
    cwd: process.cwd(),
    timeoutMs,
  });
}

async function fixturePath(name: string) {
  fixtureRoot ??= await mkdtemp(join(tmpdir(), "backup-runner-test-"));
  return join(fixtureRoot, name);
}

async function isRunning(pid: number): Promise<boolean> {
  const child = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const status = (await new Response(child.stdout).text()).trim();
  await child.exited;
  return status !== "" && !status.startsWith("Z");
}

describe("agent session backup runner", () => {
  test("serves health and timers while a slow fake audit waits, preserving its receipt", async () => {
    const receipt = await fixturePath("receipt.json");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    let finished = false;
    const run = runFake(
      `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(receipt)}, '{"ok":true}'); }, 600)`,
    ).then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const path of ["/", "/api/inngest"]) {
        const response = await fetch(new URL(path, server.url));
        expect(response.status).toBe(200);
        expect(finished).toBe(false);
      }
      await run;
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ ok: true });
    } finally {
      server.stop(true);
      await run;
    }
  });

  test("preserves non-zero exit category and prefers stderr", async () => {
    await expect(
      runFake("console.log('fallback'); console.error('fixture failure'); process.exit(7)"),
    ).rejects.toThrow("agent session audit backup failed (7): fixture failure");
  });

  test("falls back to stdout on failure", async () => {
    await expect(runFake("console.log('fixture stdout'); process.exit(8)")).rejects.toThrow(
      "agent session audit backup failed (8): fixture stdout",
    );
  });

  test("deadline kills the audit and its grandchild without removing partial receipts", async () => {
    const receipt = await fixturePath("partial.json");
    const pidFile = join(fixtureRoot!, "pids.json");
    const source = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
      fs.writeFileSync(${JSON.stringify(receipt)}, '{"partial":true}');
      console.error('partial audit');
      setInterval(() => {}, 1000);
    `;
    await expect(runFake(source, 500)).rejects.toThrow(
      "agent session audit backup failed (timeout after 500ms): partial audit",
    );
    const pids: number[] = JSON.parse(await readFile(pidFile, "utf8"));
    ownedPids.push(...pids);
    for (const pid of pids) {
      expect(await isRunning(pid)).toBe(false);
    }
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ partial: true });
  });

  test("finishes on parent exit while an orphan retains stderr", async () => {
    const pidFile = await fixturePath("orphan.pid");
    const source = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => console.error("orphan"), 1000)'], { stdio: ['ignore', 'ignore', 2] });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      process.exit(0);
    `;
    const start = Date.now();
    await runFake(source, 1_500);
    const pid = Number(await readFile(pidFile, "utf8"));
    ownedPids.push(pid);
    expect(await isRunning(pid)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_200);
  });

  test("reports spawn errors and rejects invalid deadlines", async () => {
    await expect(
      runAgentSessionBackup({ command: ["/missing-fixture-executable"], cwd: process.cwd() }),
    ).rejects.toThrow();
    await expect(runFake("", 0)).rejects.toThrow("Invalid agent session audit backup timeout");
  });
});
