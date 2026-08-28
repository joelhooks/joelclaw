import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type FileHandle, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CardRestorationV1Schema,
  CardReviewAuthorityV1Schema,
  CardWithdrawalV1Schema,
  ReviewedCardActivationV1Schema,
} from "@joelclaw-memory/domain";
import { createFlowingMemoryWorkerMachine } from "@joelclaw-memory/machines";
import { FlowingMemoryRuntime, ReviewedCardRuntime } from "@joelclaw-memory/ports";
import {
  installReviewedCardSchema,
  PostgresMigrationClientLive,
  PostgresProjectionStoreLive,
  PostgresReviewedCardStoreLive,
  PostgresRuntimeClientLive,
} from "@joelclaw-memory/postgres";
import {
  makeFileEvidenceAdapter,
  makeFlowingMemoryRuntimeLayer,
  makePiLunaInference,
  makeReviewedCardRuntimeLayer,
} from "@joelclaw-memory/runtime";
import { Config, Effect, Layer, Schema } from "effect";
import { createActor, toPromise } from "xstate";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const defaultPidPath = path.join(homedir(), ".joelclaw", "flowing-memory", "worker.pid");

const valueAfter = (arguments_: readonly string[], name: string) => {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
};

const requireValue = (arguments_: readonly string[], name: string) => {
  const value = valueAfter(arguments_, name);
  if (!value) throw new Error(`missing required ${name}`);
  return value;
};

const fileDigest = async (file: string) => sha256(await readFile(file));

const requirePrivateRegularFile = async (file: string) => {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("reviewed-card input must be a private regular file");
  }
};

const readPrivateJsonFile = async (file: string, expectedDigest: string): Promise<unknown> => {
  await requirePrivateRegularFile(file);
  const bytes = await readFile(file);
  if (sha256(bytes) !== expectedDigest) {
    throw new Error("reviewed-card input digest mismatch");
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
};

interface ApprovedCardOperation {
  readonly activationId: string;
  readonly artifactSha256: string;
  readonly authoritySha256: string;
  readonly restorationId: string;
  readonly restorationSha256: string;
  readonly withdrawalId: string;
  readonly withdrawalSha256: string;
}

const approvalFile = fileURLToPath(new URL("./approved-card-activations.json", import.meta.url));

const approvedOperations = async (): Promise<readonly ApprovedCardOperation[]> => {
  const [file, directory] = await Promise.all([
    stat(approvalFile),
    stat(path.dirname(approvalFile)),
  ]);
  if (
    !file.isFile() ||
    (file.mode & 0o222) !== 0 ||
    !directory.isDirectory() ||
    (directory.mode & 0o222) !== 0
  ) {
    throw new Error("approved card operations are not in a sealed release");
  }
  const value: unknown = JSON.parse(await readFile(approvalFile, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("operations" in value) ||
    !Array.isArray(value.operations)
  ) {
    throw new Error("approved card operations file is invalid");
  }
  return value.operations.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("activationId" in entry) ||
      typeof entry.activationId !== "string" ||
      !("artifactSha256" in entry) ||
      typeof entry.artifactSha256 !== "string" ||
      !("authoritySha256" in entry) ||
      typeof entry.authoritySha256 !== "string" ||
      !("restorationId" in entry) ||
      typeof entry.restorationId !== "string" ||
      !("restorationSha256" in entry) ||
      typeof entry.restorationSha256 !== "string" ||
      !("withdrawalId" in entry) ||
      typeof entry.withdrawalId !== "string" ||
      !("withdrawalSha256" in entry) ||
      typeof entry.withdrawalSha256 !== "string"
    ) {
      throw new Error("approved card operation entry is invalid");
    }
    return {
      activationId: entry.activationId,
      artifactSha256: entry.artifactSha256,
      authoritySha256: entry.authoritySha256,
      restorationId: entry.restorationId,
      restorationSha256: entry.restorationSha256,
      withdrawalId: entry.withdrawalId,
      withdrawalSha256: entry.withdrawalSha256,
    };
  });
};

interface PreparedReceipt {
  readonly identity: string;
  readonly operation: string;
  readonly path: string;
  readonly targetHandle: FileHandle;
  readonly temporaryHandle: FileHandle;
  readonly temporaryPath: string;
}

const prepareReceipt = async (
  target: string,
  operation: string,
  identity: string,
): Promise<PreparedReceipt> => {
  const prepared = `${JSON.stringify({
    _tag: "ReviewedCardReceiptPreparedV1",
    identity,
    operation,
    schemaVersion: 1,
  })}\n`;
  let targetHandle: FileHandle;
  try {
    targetHandle = await open(target, "wx+", 0o600);
    await targetHandle.write(prepared, 0, "utf8");
    await targetHandle.sync();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    await requirePrivateRegularFile(target);
    const existing: unknown = JSON.parse(await readFile(target, "utf8"));
    if (
      typeof existing !== "object" ||
      existing === null ||
      !("_tag" in existing) ||
      existing._tag !== "ReviewedCardReceiptPreparedV1" ||
      !("identity" in existing) ||
      existing.identity !== identity ||
      !("operation" in existing) ||
      existing.operation !== operation
    ) {
      throw new Error("reviewed-card receipt target already contains other evidence");
    }
    targetHandle = await open(target, "r+");
  }
  const temporaryPath = `${target}.final-${identity}.tmp`;
  let temporaryHandle: FileHandle;
  try {
    temporaryHandle = await open(temporaryPath, "wx+", 0o600);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      await targetHandle.close();
      throw error;
    }
    await requirePrivateRegularFile(temporaryPath);
    temporaryHandle = await open(temporaryPath, "r+");
    await temporaryHandle.truncate(0);
  }
  return {
    identity,
    operation,
    path: target,
    targetHandle,
    temporaryHandle,
    temporaryPath,
  };
};

const closePreparedReceipt = async (prepared: PreparedReceipt) => {
  await Promise.allSettled([prepared.targetHandle.close(), prepared.temporaryHandle.close()]);
};

const finalizeReceipt = async (prepared: PreparedReceipt, encoded: unknown) => {
  const body = `${JSON.stringify(encoded, null, 2)}\n`;
  await prepared.temporaryHandle.truncate(0);
  await prepared.temporaryHandle.write(body, 0, "utf8");
  await prepared.temporaryHandle.sync();
  await prepared.temporaryHandle.close();
  await prepared.targetHandle.close();
  await rename(prepared.temporaryPath, prepared.path);
  return {
    bytes: Buffer.byteLength(body),
    path: prepared.path,
    sha256: sha256(body),
  };
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const workerPidPath = () => process.env.JOELCLAW_MEMORY_WORKER_PID_PATH ?? defaultPidPath;

const semanticWorkerProcesses = async () =>
  new Promise<readonly string[]>((resolve, reject) => {
    execFile("/bin/ps", ["-Ao", "pid=,command="], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) =>
              line.length > 0 &&
              !line.startsWith(`${process.pid} `) &&
              (/prototype-worker\.ts/u.test(line) ||
                /flowing-memory-card-worker\.mjs\s+run(?:\s|$)/u.test(line) ||
                /flowing-memory-host.*worker\s+run(?:\s|$)/u.test(line)),
          ),
      );
    });
  });

const requireDaemonStopped = async () => {
  const processes = await semanticWorkerProcesses();
  if (processes.length > 0) {
    throw new Error("a flowing-memory semantic worker process is still running");
  }
  try {
    const pid = Number.parseInt((await readFile(workerPidPath(), "utf8")).trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
      throw new Error("flowing-memory worker daemon is still running");
    }
    throw new Error("flowing-memory worker pid receipt is stale");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const semanticWorkerLaunchAgentIsLoaded = async () =>
  new Promise<boolean>((resolve) => {
    execFile(
      "/bin/launchctl",
      ["print", `gui/${process.getuid?.() ?? 0}/com.joelclaw.flowing-memory-worker`],
      (error) => resolve(error === null),
    );
  });

const requireActivationWindow = async () => {
  await requireDaemonStopped();
  if (await semanticWorkerLaunchAgentIsLoaded()) {
    throw new Error("flowing-memory worker LaunchAgent is still loaded");
  }
};

const makeWorkerRuntimeLayer = Effect.gen(function* makeWorkerRuntimeLayer() {
  const evidenceDirectory = yield* Config.string("JOELCLAW_MEMORY_EVIDENCE_DIRECTORY");
  const inference = yield* makePiLunaInference;
  const storeLayer = PostgresProjectionStoreLive.pipe(Layer.provide(PostgresRuntimeClientLive));
  return makeFlowingMemoryRuntimeLayer({
    evidence: makeFileEvidenceAdapter(evidenceDirectory),
    inference,
  }).pipe(Layer.provide(storeLayer));
});

const makeCardRuntimeLayer = () => {
  const storeLayer = PostgresReviewedCardStoreLive.pipe(Layer.provide(PostgresRuntimeClientLive));
  return makeReviewedCardRuntimeLayer().pipe(Layer.provide(storeLayer));
};

const runDaemon = async () => {
  await requireDaemonStopped();
  const pidPath = workerPidPath();
  const pidFile = await open(pidPath, "wx", 0o600);
  await pidFile.writeFile(`${process.pid}\n`);
  await pidFile.sync();
  await pidFile.close();
  try {
    await Effect.runPromise(
      Effect.scoped(
        makeWorkerRuntimeLayer.pipe(
          Effect.flatMap((layer) =>
            Effect.gen(function* runWorker() {
              const runtime = yield* FlowingMemoryRuntime;
              yield* Effect.promise(async () => {
                let timer: NodeJS.Timeout | undefined;
                let activeRun: Promise<unknown> | null = null;
                const actor = createActor(
                  createFlowingMemoryWorkerMachine({
                    runOnce: (signal) => {
                      const run = Effect.runPromise(runtime.runOnce(signal), {
                        signal,
                      });
                      activeRun = run;
                      return run;
                    },
                  }),
                  { input: { backoffMs: 1000, blockedRetryMs: 30_000 } },
                );
                actor.subscribe((snapshot) => {
                  if (timer !== undefined) clearTimeout(timer);
                  timer = undefined;
                  if (snapshot.value === "idle") {
                    timer = setTimeout(() => actor.send({ type: "TICK" }), 500);
                  }
                });
                let stopping = false;
                const stop = () => {
                  if (stopping) return;
                  stopping = true;
                  actor.send({ type: "STOP" });
                };
                process.once("SIGINT", stop);
                process.once("SIGTERM", stop);
                actor.start();
                actor.send({ type: "START" });
                try {
                  await toPromise(actor);
                  if (activeRun !== null) await Promise.resolve(activeRun).catch(() => undefined);
                } finally {
                  process.removeListener("SIGINT", stop);
                  process.removeListener("SIGTERM", stop);
                  if (timer !== undefined) clearTimeout(timer);
                  actor.stop();
                }
              });
            }).pipe(Effect.provide(layer)),
          ),
        ),
      ),
    );
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
};

const withCardRuntime = <A, E>(effect: Effect.Effect<A, E, ReviewedCardRuntime>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(makeCardRuntimeLayer()))));

const runPreviewOrActivation = async (arguments_: readonly string[], activate: boolean) => {
  await requireActivationWindow();
  const artifactPath = requireValue(arguments_, "--artifact");
  const artifactSha = requireValue(arguments_, "--artifact-sha256");
  const authorityPath = requireValue(arguments_, "--authority");
  const authoritySha = requireValue(arguments_, "--authority-sha256");
  const receiptPath = requireValue(arguments_, "--receipt");
  const activation = Schema.decodeUnknownSync(ReviewedCardActivationV1Schema)(
    await readPrivateJsonFile(artifactPath, artifactSha),
  );
  const authority = Schema.decodeUnknownSync(CardReviewAuthorityV1Schema)(
    await readPrivateJsonFile(authorityPath, authoritySha),
  );
  const approval = (await approvedOperations()).find(
    (entry) => entry.activationId === activation.activationId,
  );
  if (
    approval === undefined ||
    approval.artifactSha256 !== artifactSha ||
    approval.authoritySha256 !== authoritySha
  ) {
    throw new Error("card activation is not pinned by the sealed worker release");
  }
  if (activate) {
    const confirmation = requireValue(arguments_, "--confirm-activation");
    if (confirmation !== activation.activationId) {
      throw new Error("activation confirmation does not match artifact identity");
    }
  }
  const operation = activate ? "activate" : "preview";
  const prepared = await prepareReceipt(receiptPath, operation, activation.activationId);
  try {
    if (activate) {
      const output = await withCardRuntime(
        Effect.gen(function* activateCard() {
          const runtime = yield* ReviewedCardRuntime;
          return yield* runtime.activate(activation, authority);
        }),
      );
      const { CardActivationReceiptV1Schema } = await import("@joelclaw-memory/domain");
      return await finalizeReceipt(
        prepared,
        Schema.encodeSync(CardActivationReceiptV1Schema)(output),
      );
    }
    const output = await withCardRuntime(
      Effect.gen(function* previewCard() {
        const runtime = yield* ReviewedCardRuntime;
        return yield* runtime.preview(activation, authority);
      }),
    );
    const { ReflectionV2Schema } = await import("@joelclaw-memory/domain");
    return await finalizeReceipt(prepared, Schema.encodeSync(ReflectionV2Schema)(output));
  } catch (error) {
    await closePreparedReceipt(prepared);
    throw error;
  }
};

const runWithdrawal = async (arguments_: readonly string[]) => {
  await requireActivationWindow();
  const withdrawalPath = requireValue(arguments_, "--withdrawal");
  const withdrawalSha = requireValue(arguments_, "--withdrawal-sha256");
  const receiptPath = requireValue(arguments_, "--receipt");
  const withdrawal = Schema.decodeUnknownSync(CardWithdrawalV1Schema)(
    await readPrivateJsonFile(withdrawalPath, withdrawalSha),
  );
  const approval = (await approvedOperations()).find(
    (entry) => entry.withdrawalId === withdrawal.withdrawalId,
  );
  if (
    approval === undefined ||
    approval.withdrawalSha256 !== withdrawalSha ||
    approval.activationId !== withdrawal.activationId
  ) {
    throw new Error("card withdrawal is not pinned by the sealed worker release");
  }
  if (requireValue(arguments_, "--confirm-withdrawal") !== withdrawal.withdrawalId) {
    throw new Error("withdrawal confirmation does not match artifact identity");
  }
  const prepared = await prepareReceipt(receiptPath, "withdraw", withdrawal.withdrawalId);
  try {
    const receipt = await withCardRuntime(
      Effect.gen(function* withdrawCard() {
        const runtime = yield* ReviewedCardRuntime;
        return yield* runtime.withdraw(withdrawal);
      }),
    );
    const { CardWithdrawalReceiptV1Schema } = await import("@joelclaw-memory/domain");
    return await finalizeReceipt(
      prepared,
      Schema.encodeSync(CardWithdrawalReceiptV1Schema)(receipt),
    );
  } catch (error) {
    await closePreparedReceipt(prepared);
    throw error;
  }
};

const runRestoration = async (arguments_: readonly string[]) => {
  await requireActivationWindow();
  const restorationPath = requireValue(arguments_, "--restoration");
  const restorationSha = requireValue(arguments_, "--restoration-sha256");
  const receiptPath = requireValue(arguments_, "--receipt");
  const restoration = Schema.decodeUnknownSync(CardRestorationV1Schema)(
    await readPrivateJsonFile(restorationPath, restorationSha),
  );
  const approval = (await approvedOperations()).find(
    (entry) => entry.restorationId === restoration.restorationId,
  );
  if (
    approval === undefined ||
    approval.restorationSha256 !== restorationSha ||
    approval.activationId !== restoration.activationId
  ) {
    throw new Error("card restoration is not pinned by the sealed worker release");
  }
  if (requireValue(arguments_, "--confirm-restoration") !== restoration.restorationId) {
    throw new Error("restoration confirmation does not match artifact identity");
  }
  const prepared = await prepareReceipt(receiptPath, "restore", restoration.restorationId);
  try {
    const receipt = await withCardRuntime(
      Effect.gen(function* restoreCard() {
        const runtime = yield* ReviewedCardRuntime;
        return yield* runtime.restore(restoration);
      }),
    );
    const { CardRestorationReceiptV1Schema } = await import("@joelclaw-memory/domain");
    return await finalizeReceipt(
      prepared,
      Schema.encodeSync(CardRestorationReceiptV1Schema)(receipt),
    );
  } catch (error) {
    await closePreparedReceipt(prepared);
    throw error;
  }
};

const runCardMigration = async (arguments_: readonly string[]) => {
  await requireActivationWindow();
  if (requireValue(arguments_, "--confirm-card-schema") !== "reviewed-memory-cards-v1") {
    throw new Error("card schema confirmation is invalid");
  }
  const prepared = await prepareReceipt(
    requireValue(arguments_, "--receipt"),
    "migrate-cards",
    "reviewed-memory-cards-v1",
  );
  try {
    const result = await Effect.runPromise(
      Effect.scoped(installReviewedCardSchema.pipe(Effect.provide(PostgresMigrationClientLive))),
    );
    return await finalizeReceipt(prepared, {
      _tag: "ReviewedCardSchemaMigrationReceiptV1",
      ...result,
      schemaVersion: 1,
    });
  } catch (error) {
    await closePreparedReceipt(prepared);
    throw error;
  }
};

export const runWorkerCommand = async (arguments_: readonly string[]) => {
  const action = arguments_[0];
  let receipt: unknown;
  switch (action) {
    case "run":
      await runDaemon();
      return;
    case "preview":
      receipt = await runPreviewOrActivation(arguments_, false);
      break;
    case "activate":
      receipt = await runPreviewOrActivation(arguments_, true);
      break;
    case "restore":
      receipt = await runRestoration(arguments_);
      break;
    case "withdraw":
      receipt = await runWithdrawal(arguments_);
      break;
    case "migrate-cards":
      receipt = await runCardMigration(arguments_);
      break;
    default:
      throw new Error(
        "usage: flowing-memory-card-worker <run|preview|activate|withdraw|restore|migrate-cards>",
      );
  }
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
};

await runWorkerCommand(process.argv.slice(2));
