import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireWorkerPidReceipt,
  assertWorkerPidAvailable,
  type ProcessIdentityProbe,
  probeProcessIdentity,
  releaseOwnedReceipt,
  withWorkerOperationLease,
} from "../src/worker-ownership.mts";

const roots: string[] = [];

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowing-memory-worker-ownership-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const identity = (character: string) => character.repeat(64);

const probeFor = (
  entries: Readonly<Record<number, Awaited<ReturnType<ProcessIdentityProbe>>>>,
): ProcessIdentityProbe =>
  async (pid) =>
    entries[pid] ?? {
      _tag: "Uncertain",
      reason: "synthetic-unmapped-pid",
    };

const operationReceipt = (input: {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly token: string;
}) =>
  `${JSON.stringify({
    _tag: "FlowingMemoryWorkerOwnershipV2",
    kind: "operation",
    operation: "run",
    pid: input.pid,
    processStartIdentity: input.processStartIdentity,
    schemaVersion: 2,
    token: input.token,
  })}\n`;

const pidReceipt = (input: {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly token: string;
}) =>
  `${JSON.stringify({
    _tag: "FlowingMemoryWorkerOwnershipV2",
    kind: "daemon",
    pid: input.pid,
    processStartIdentity: input.processStartIdentity,
    schemaVersion: 2,
    token: input.token,
  })}\n`;

describe("worker operation ownership", () => {
  it("fails closed on a positively identified live owner", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const original = operationReceipt({
      pid: 4101,
      processStartIdentity: identity("a"),
      token: "live-owner-token",
    });
    await writeFile(lockPath, original, { mode: 0o600 });

    await expect(
      withWorkerOperationLease(
        {
          lockPath,
          operation: "run",
          pid: 5101,
          probe: probeFor({
            4101: { _tag: "Alive", processStartIdentity: identity("a") },
            5101: { _tag: "Alive", processStartIdentity: identity("b") },
          }),
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "owner-live" });
    expect(await readFile(lockPath, "utf8")).toBe(original);
  });

  it("preserves a dead legacy owner byte-for-byte before taking ownership", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const original = '{"operation":"run","pid":4102,"schemaVersion":1,"token":"legacy-token"}\n';
    await writeFile(lockPath, original, { mode: 0o600 });
    let observedSchemaVersion: unknown;

    await withWorkerOperationLease(
      {
        lockPath,
        operation: "run",
        pid: 5102,
        probe: probeFor({
          4102: { _tag: "Dead" },
          5102: { _tag: "Alive", processStartIdentity: identity("b") },
        }),
      },
      async () => {
        observedSchemaVersion = JSON.parse(await readFile(lockPath, "utf8")).schemaVersion;
      },
    );

    expect(observedSchemaVersion).toBe(2);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const preimages = (await readdir(root)).filter((name) => name.includes(".stale-") && name.endsWith(".preimage"));
    expect(preimages).toHaveLength(1);
    expect(await readFile(path.join(root, preimages[0]!), "utf8")).toBe(original);
  });

  it("rejects malformed and symlink operation receipts without changing them", async () => {
    const root = await makeRoot();
    const malformedPath = path.join(root, "malformed.lock");
    await writeFile(malformedPath, "{not-json\n", { mode: 0o600 });
    const options = {
      operation: "run" as const,
      pid: 5103,
      probe: probeFor({
        5103: { _tag: "Alive" as const, processStartIdentity: identity("b") },
      }),
    };

    await expect(
      withWorkerOperationLease({ ...options, lockPath: malformedPath }, async () => undefined),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "receipt-malformed" });
    expect(await readFile(malformedPath, "utf8")).toBe("{not-json\n");

    const targetPath = path.join(root, "target.lock");
    const symlinkPath = path.join(root, "symlink.lock");
    await writeFile(targetPath, operationReceipt({
      pid: 4103,
      processStartIdentity: identity("a"),
      token: "target-token",
    }), { mode: 0o600 });
    await symlink(targetPath, symlinkPath);

    await expect(
      withWorkerOperationLease({ ...options, lockPath: symlinkPath }, async () => undefined),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "receipt-unsafe" });
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
  });

  it("does not unlink a successor when cleanup no longer owns the inode and token", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const successor = operationReceipt({
      pid: 6104,
      processStartIdentity: identity("c"),
      token: "successor-token",
    });

    await expect(
      withWorkerOperationLease(
        {
          lockPath,
          operation: "run",
          pid: 5104,
          probe: probeFor({
            5104: { _tag: "Alive", processStartIdentity: identity("b") },
          }),
        },
        async () => {
          const replacement = path.join(root, "successor.tmp");
          await writeFile(replacement, successor, { mode: 0o600 });
          await rename(replacement, lockPath);
        },
      ),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "ownership-lost" });
    expect(await readFile(lockPath, "utf8")).toBe(successor);
  });

  it("does not remove a same-inode receipt whose ownership token changed", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const changed = operationReceipt({
      pid: 6107,
      processStartIdentity: identity("c"),
      token: "changed-token",
    });

    await expect(
      withWorkerOperationLease(
        {
          lockPath,
          operation: "run",
          pid: 5107,
          probe: probeFor({
            5107: { _tag: "Alive", processStartIdentity: identity("b") },
          }),
        },
        async () => {
          await writeFile(lockPath, changed, { mode: 0o600 });
        },
      ),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "ownership-lost" });
    expect(await readFile(lockPath, "utf8")).toBe(changed);
  });

  it("serializes simultaneous stale contenders so the loser cannot unlink the winner", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    await writeFile(
      lockPath,
      '{"operation":"run","pid":4105,"schemaVersion":1,"token":"dead-owner"}\n',
      { mode: 0o600 },
    );
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const commonProbe = probeFor({
      4105: { _tag: "Dead" },
      5105: { _tag: "Alive", processStartIdentity: identity("b") },
      6105: { _tag: "Alive", processStartIdentity: identity("c") },
    });

    const first = withWorkerOperationLease(
      { lockPath, operation: "run", pid: 5105, probe: commonProbe },
      async () => {
        firstEntered();
        await firstCanFinish;
      },
    );
    await firstDidEnter;
    const winningBytes = await readFile(lockPath, "utf8");

    await expect(
      withWorkerOperationLease(
        { lockPath, operation: "run", pid: 6105, probe: commonProbe },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "lease-contended" });
    expect(await readFile(lockPath, "utf8")).toBe(winningBytes);

    releaseFirst();
    await first;
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases ownership after cancellation and permits a later owner", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const controller = new AbortController();
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const probe = probeFor({
      5106: { _tag: "Alive", processStartIdentity: identity("b") },
      6106: { _tag: "Alive", processStartIdentity: identity("c") },
    });
    const cancelled = withWorkerOperationLease(
      { lockPath, operation: "run", pid: 5106, probe },
      async () =>
        await new Promise<void>((_resolve, reject) => {
          entered();
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    await didEnter;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await withWorkerOperationLease(
      { lockPath, operation: "run", pid: 6106, probe },
      async () => undefined,
    );
  });
});

describe("worker pid receipts", () => {
  it("recovers a versioned receipt only after positively observing PID reuse", async () => {
    const root = await makeRoot();
    const receiptPath = path.join(root, "worker.pid");
    const original = pidReceipt({
      pid: 4201,
      processStartIdentity: identity("a"),
      token: "old-daemon-token",
    });
    await writeFile(receiptPath, original, { mode: 0o600 });

    await assertWorkerPidAvailable({
      pidPath: receiptPath,
      probe: probeFor({
        4201: { _tag: "Alive", processStartIdentity: identity("b") },
      }),
    });

    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    const preimage = (await readdir(root)).find((name) => name.includes(".stale-"));
    expect(preimage).toBeDefined();
    expect(await readFile(path.join(root, preimage!), "utf8")).toBe(original);
  });

  it("recovers a definitively dead legacy PID and preserves its exact bytes", async () => {
    const root = await makeRoot();
    const receiptPath = path.join(root, "worker.pid");
    const original = "4205\n";
    await writeFile(receiptPath, original, { mode: 0o600 });

    await assertWorkerPidAvailable({
      pidPath: receiptPath,
      probe: probeFor({ 4205: { _tag: "Dead" } }),
    });

    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    const preimage = (await readdir(root)).find((name) => name.includes(".stale-"));
    expect(preimage).toBeDefined();
    expect(await readFile(path.join(root, preimage!), "utf8")).toBe(original);
  });

  it("keeps legacy-live and uncertain versioned PID receipts in place", async () => {
    const root = await makeRoot();
    const legacyPath = path.join(root, "legacy.pid");
    const uncertainPath = path.join(root, "uncertain.pid");
    await writeFile(legacyPath, "4202\n", { mode: 0o600 });
    const uncertain = pidReceipt({
      pid: 4203,
      processStartIdentity: identity("a"),
      token: "uncertain-token",
    });
    await writeFile(uncertainPath, uncertain, { mode: 0o600 });

    await expect(
      assertWorkerPidAvailable({
        pidPath: legacyPath,
        probe: probeFor({
          4202: { _tag: "Alive", processStartIdentity: identity("b") },
        }),
      }),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "owner-ambiguous" });
    expect(await readFile(legacyPath, "utf8")).toBe("4202\n");

    await expect(
      assertWorkerPidAvailable({
        pidPath: uncertainPath,
        probe: probeFor({
          4203: { _tag: "Uncertain", reason: "synthetic-probe-failure" },
        }),
      }),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "owner-ambiguous" });
    expect(await readFile(uncertainPath, "utf8")).toBe(uncertain);
  });

  it("rejects malformed and symlink PID receipts", async () => {
    const root = await makeRoot();
    const malformedPath = path.join(root, "malformed.pid");
    await writeFile(malformedPath, "not-a-pid\n", { mode: 0o600 });
    await expect(
      assertWorkerPidAvailable({ pidPath: malformedPath, probe: async () => ({ _tag: "Dead" }) }),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "receipt-malformed" });

    const targetPath = path.join(root, "target.pid");
    const symlinkPath = path.join(root, "symlink.pid");
    await writeFile(targetPath, "4204\n", { mode: 0o600 });
    await symlink(targetPath, symlinkPath);
    await expect(
      assertWorkerPidAvailable({ pidPath: symlinkPath, probe: async () => ({ _tag: "Dead" }) }),
    ).rejects.toMatchObject({ name: "WorkerOwnershipError", code: "receipt-unsafe" });
    expect(await readFile(targetPath, "utf8")).toBe("4204\n");
  });

  it("creates and releases a token and inode checked daemon receipt", async () => {
    const root = await makeRoot();
    const pidPath = path.join(root, "worker.pid");
    const owned = await acquireWorkerPidReceipt({
      pidPath,
      pid: 5201,
      probe: probeFor({
        5201: { _tag: "Alive", processStartIdentity: identity("d") },
      }),
    });
    expect(JSON.parse(await readFile(pidPath, "utf8"))).toMatchObject({
      kind: "daemon",
      pid: 5201,
      processStartIdentity: identity("d"),
      schemaVersion: 2,
    });
    await releaseOwnedReceipt(owned);
    await expect(readFile(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("fatal startup", () => {
  it("forces a nonzero process exit when startup ownership fails despite a live handle", async () => {
    const root = await makeRoot();
    const lockPath = path.join(root, "operation.lock");
    const current = await probeProcessIdentity(process.pid);
    if (current._tag !== "Alive") throw new Error("test process identity was unavailable");
    const original = operationReceipt({
      pid: process.pid,
      processStartIdentity: current.processStartIdentity,
      token: randomUUID(),
    });
    await writeFile(lockPath, original, { mode: 0o600 });
    await chmod(lockPath, 0o600);
    const mainUrl = new URL("../src/worker-main.mts", import.meta.url).href;
    const ownershipUrl = new URL("../src/worker-ownership.mts", import.meta.url).href;
    const script = [
      `import { runWorkerMain } from ${JSON.stringify(mainUrl)};`,
      `import { withWorkerOperationLease } from ${JSON.stringify(ownershipUrl)};`,
      "setInterval(() => undefined, 60_000);",
      `await runWorkerMain(() => withWorkerOperationLease({ lockPath: ${JSON.stringify(lockPath)}, operation: \"run\" }, async () => undefined));`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ _tag: "Exited" as const, exitCode })),
      new Promise<{ readonly _tag: "TimedOut" }>((resolve) => {
        setTimeout(() => resolve({ _tag: "TimedOut" }), 5_000);
      }),
    ]);
    if (result._tag === "TimedOut") {
      child.kill();
      throw new Error("worker process stayed alive after fatal startup failure");
    }
    const stderr = await new Response(child.stderr).text();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('"ok":false');
    expect(stderr).toContain("owner-live");
    expect(await readFile(lockPath, "utf8")).toBe(original);
  }, 10_000);
});
