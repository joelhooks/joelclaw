import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function runFake(source: string, timeoutMs = 2_000) {
  return runAgentSessionBackup({
    command: [process.execPath, "-e", source],
    cwd: process.cwd(),
    lockPath: await fixturePath("backup.lock"),
    timeoutMs,
    lockPollMs: 20,
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
      runAgentSessionBackup({
        command: ["/missing-fixture-executable"],
        cwd: process.cwd(),
        lockPath: await fixturePath("backup.lock"),
      }),
    ).rejects.toThrow();
    await expect(runFake("", 0)).rejects.toThrow("Invalid agent session audit backup timeout");
  });
});

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

async function writeLock(lock: {
  ownerPid: number;
  pid: number | null;
  startedAt?: number;
  deadlineAt: number;
}) {
  await writeFile(
    await fixturePath("backup.lock"),
    JSON.stringify({ token: "previous-worker", startedAt: Date.now(), ...lock }),
  );
}

// Fake audit that logs when it starts and ends.
async function loggingAudit(name: string, holdMs: number) {
  const log = await fixturePath("order.log");
  return `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}:start\n`)});
    setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}:end\n`)}), ${holdMs});
  `;
}

describe("agent session backup single-flight lock", () => {
  test("a concurrent second call waits for the first audit instead of overlapping it", async () => {
    const first = runFake(await loggingAudit("first", 300));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = runFake(await loggingAudit("second", 50));
    await Promise.all([first, second]);
    const log = await readFile(await fixturePath("order.log"), "utf8");
    expect(log.trim().split("\n")).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(existsSync(await fixturePath("backup.lock"))).toBe(false);
  });

  test("records the audit process group in the lock while it runs", async () => {
    const lockPath = await fixturePath("backup.lock");
    const seen = await fixturePath("seen.json");
    await runFake(`
      const fs = require('node:fs');
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ self: process.pid, lock: JSON.parse(fs.readFileSync(${JSON.stringify(lockPath)}, 'utf8')) }));
      }, 150);
    `);
    const { self, lock } = JSON.parse(await readFile(seen, "utf8"));
    expect(lock.pid).toBe(self);
    expect(lock.ownerPid).toBe(process.pid);
  });

  test("reclaims stale locks from dead audits and dead workers", async () => {
    const dead = await deadPid();
    for (const stale of [
      { ownerPid: dead, pid: dead, deadlineAt: Date.now() + 60_000 },
      { ownerPid: dead, pid: null, deadlineAt: Date.now() + 60_000 },
    ]) {
      await writeLock(stale);
      const start = Date.now();
      await runFake("");
      expect(Date.now() - start).toBeLessThan(1_000);
      expect(existsSync(await fixturePath("backup.lock"))).toBe(false);
    }
  });

  test("waits for a live orphan audit group left by a previous worker", async () => {
    const log = await fixturePath("order.log");
    const orphan = Bun.spawn([process.execPath, "-e", await loggingAudit("orphan", 300)], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    ownedPids.push(orphan.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeLock({
      ownerPid: await deadPid(),
      pid: orphan.pid,
      deadlineAt: Date.now() + 60_000,
    });
    await runFake(await loggingAudit("retry", 10));
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "orphan:start",
      "orphan:end",
      "retry:start",
      "retry:end",
    ]);
  });

  test("kills an orphan audit group that outlived its recorded deadline", async () => {
    const pidFile = await fixturePath("orphan-pids.json");
    const orphan = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          const { spawn } = require('node:child_process');
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
          setInterval(() => {}, 1000);
        `,
      ],
      { detached: true, stdout: "ignore", stderr: "ignore" },
    );
    ownedPids.push(orphan.pid);
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    const pids: number[] = JSON.parse(await readFile(pidFile, "utf8"));
    ownedPids.push(...pids);
    await writeLock({
      ownerPid: await deadPid(),
      pid: orphan.pid,
      startedAt: Date.now() - 1_000,
      deadlineAt: Date.now() + 100,
    });
    await runFake("");
    await orphan.exited;
    for (const pid of pids) {
      expect(await isRunning(pid)).toBe(false);
    }
    expect(existsSync(await fixturePath("backup.lock"))).toBe(false);
  });

  test("releases the lock on success, failure and timeout", async () => {
    const lockPath = await fixturePath("backup.lock");
    await runFake("");
    expect(existsSync(lockPath)).toBe(false);
    await expect(runFake("process.exit(3)")).rejects.toThrow("failed (3)");
    expect(existsSync(lockPath)).toBe(false);
    await expect(runFake("setInterval(() => {}, 1000)", 200)).rejects.toThrow(
      "timeout after 200ms",
    );
    expect(existsSync(lockPath)).toBe(false);
    await expect(
      runAgentSessionBackup({
        command: ["/missing-fixture-executable"],
        cwd: process.cwd(),
        lockPath,
      }),
    ).rejects.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });
});
