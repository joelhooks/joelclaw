import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AtomicSlimTransportLockClaim,
  assertNoLiveSlimTransportOwner,
  claimSlimTransportOwnership,
  SlimTransportOwnerConflictError,
} from "./slim-transport-ownership";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "gateway-owner-test-"));
  roots.push(root);
  return {
    root,
    pidFile: join(root, "gateway.pid"),
    lockFile: join(root, "gateway.transport.lock"),
    heartbeatFile: join(root, "last-heartbeat.ts"),
    readinessFile: join(root, "gateway.ready.json"),
  };
}

function successfulTestClaim(): AtomicSlimTransportLockClaim {
  return async ({ lockFile, pid }) => {
    await writeFile(lockFile, `${pid}\n`, "utf8");
    return { acquired: true };
  };
}

const macOsTest = process.platform === "darwin" ? test : test.skip;

describe("slim transport ownership", () => {
  test("rejects a live owner without deleting its evidence", async () => {
    const paths = await harness();
    await Promise.all([
      writeFile(paths.pidFile, "4242\n", "utf8"),
      writeFile(paths.heartbeatFile, "heartbeat-owner-4242\n", "utf8"),
      writeFile(paths.readinessFile, "ready-owner-4242\n", "utf8"),
    ]);

    await expect(claimSlimTransportOwnership({
      currentPid: 9000,
      pidFile: paths.pidFile,
      lockFile: paths.lockFile,
      isProcessAlive: (pid) => pid === 4242,
    })).rejects.toBeInstanceOf(SlimTransportOwnerConflictError);

    expect(await readFile(paths.pidFile, "utf8")).toBe("4242\n");
    expect(await readFile(paths.heartbeatFile, "utf8")).toBe("heartbeat-owner-4242\n");
    expect(await readFile(paths.readinessFile, "utf8")).toBe("ready-owner-4242\n");
  });

  test("rejects a live lock owner even when PID evidence is absent", async () => {
    const paths = await harness();
    await writeFile(paths.lockFile, "4242\n", "utf8");

    await expect(claimSlimTransportOwnership({
      currentPid: 9000,
      pidFile: paths.pidFile,
      lockFile: paths.lockFile,
      isProcessAlive: (pid) => pid === 4242,
      atomicLockClaim: async () => ({ acquired: false }),
    })).rejects.toMatchObject({ ownerPid: 4242, evidence: "lock" });

    expect(await readFile(paths.lockFile, "utf8")).toBe("4242\n");
  });

  test("clears stale evidence only after an exclusive ownership claim", async () => {
    const paths = await harness();
    await Promise.all([
      writeFile(paths.pidFile, "3333\n", "utf8"),
      writeFile(paths.lockFile, "3333\n", "utf8"),
      writeFile(paths.heartbeatFile, "stale-heartbeat\n", "utf8"),
      writeFile(paths.readinessFile, "stale-ready\n", "utf8"),
    ]);

    const lease = await claimSlimTransportOwnership({
      currentPid: 9000,
      pidFile: paths.pidFile,
      lockFile: paths.lockFile,
      isProcessAlive: () => false,
      atomicLockClaim: successfulTestClaim(),
    });
    await lease.clearStaleEvidence([
      paths.pidFile,
      paths.heartbeatFile,
      paths.readinessFile,
    ]);

    expect(await readFile(paths.lockFile, "utf8")).toBe("9000\n");
    await expect(readFile(paths.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(paths.heartbeatFile, "utf8")).rejects.toThrow();
    await expect(readFile(paths.readinessFile, "utf8")).rejects.toThrow();

    await lease.release();
    await expect(readFile(paths.lockFile, "utf8")).rejects.toThrow();
  });

  test("does not clear stale evidence when the atomic claim fails", async () => {
    const paths = await harness();
    await Promise.all([
      writeFile(paths.pidFile, "3333\n", "utf8"),
      writeFile(paths.heartbeatFile, "stale-heartbeat\n", "utf8"),
      writeFile(paths.readinessFile, "stale-ready\n", "utf8"),
    ]);

    await expect(claimSlimTransportOwnership({
      currentPid: 9000,
      pidFile: paths.pidFile,
      lockFile: paths.lockFile,
      isProcessAlive: () => false,
      atomicLockClaim: async () => ({ acquired: false, detail: "contended" }),
    })).rejects.toThrow("Atomic slim gateway transport lock claim failed: contended");

    expect(await readFile(paths.pidFile, "utf8")).toBe("3333\n");
    expect(await readFile(paths.heartbeatFile, "utf8")).toBe("stale-heartbeat\n");
    expect(await readFile(paths.readinessFile, "utf8")).toBe("stale-ready\n");
  });

  test("release removes only a PID-matched lock", async () => {
    const paths = await harness();
    const lease = await claimSlimTransportOwnership({
      currentPid: 9000,
      pidFile: paths.pidFile,
      lockFile: paths.lockFile,
      isProcessAlive: () => false,
      atomicLockClaim: successfulTestClaim(),
    });
    await writeFile(paths.lockFile, "7777\n", "utf8");

    await lease.release();

    expect(await readFile(paths.lockFile, "utf8")).toBe("7777\n");
  });

  test("read-only preflight guard rejects a live legacy owner", async () => {
    const paths = await harness();
    await writeFile(paths.pidFile, "4242\n", "utf8");

    await expect(assertNoLiveSlimTransportOwner({
      currentPid: 9000,
      pidFile: paths.pidFile,
      isProcessAlive: (pid) => pid === 4242,
    })).rejects.toMatchObject({ ownerPid: 4242, evidence: "pid" });
  });

  macOsTest("shlock grants exactly one lease across 2000 concurrent stale claims", async () => {
    const paths = await harness();
    const staleLockFiles = Array.from(
      { length: 2000 },
      (_, index) => join(paths.root, `stale-${index}.lock`),
    );
    for (let index = 0; index < staleLockFiles.length; index += 100) {
      await Promise.all(
        staleLockFiles.slice(index, index + 100).map((lockFile) => (
          writeFile(lockFile, "999999\n", "utf8")
        )),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const helper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      helper.once("spawn", resolve);
      helper.once("error", reject);
    });
    const helperPid = helper.pid;
    if (!helperPid) throw new Error("sleep helper has no PID");

    try {
      for (const lockFile of staleLockFiles) {
        const claims = await Promise.allSettled([
          claimSlimTransportOwnership({
            currentPid: process.pid,
            pidFile: paths.pidFile,
            lockFile,
          }),
          claimSlimTransportOwnership({
            currentPid: helperPid,
            pidFile: paths.pidFile,
            lockFile,
          }),
        ]);
        const leases = claims.flatMap((claim) => claim.status === "fulfilled" ? [claim.value] : []);
        expect(leases).toHaveLength(1);
        await leases[0]?.release();
      }
    } finally {
      helper.kill("SIGTERM");
    }
  }, 60_000);
});
