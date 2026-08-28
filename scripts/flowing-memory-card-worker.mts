import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
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

const writeReceipt = async (target: string, encoded: unknown) => {
  const body = `${JSON.stringify(encoded, null, 2)}\n`;
  await writeFile(target, body, { flag: "wx", mode: 0o600 });
  return { bytes: Buffer.byteLength(body), path: target, sha256: sha256(body) };
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
  await requireDaemonStopped();
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
  if (activate) {
    const confirmation = requireValue(arguments_, "--confirm-activation");
    if (confirmation !== activation.activationId) {
      throw new Error("activation confirmation does not match artifact identity");
    }
  }
  if (activate) {
    const output = await withCardRuntime(
      Effect.gen(function* activateCard() {
        const runtime = yield* ReviewedCardRuntime;
        return yield* runtime.activate(activation, authority);
      }),
    );
    const { CardActivationReceiptV1Schema } = await import("@joelclaw-memory/domain");
    return writeReceipt(receiptPath, Schema.encodeSync(CardActivationReceiptV1Schema)(output));
  }
  const output = await withCardRuntime(
    Effect.gen(function* previewCard() {
      const runtime = yield* ReviewedCardRuntime;
      return yield* runtime.preview(activation, authority);
    }),
  );
  const { ReflectionV2Schema } = await import("@joelclaw-memory/domain");
  return writeReceipt(receiptPath, Schema.encodeSync(ReflectionV2Schema)(output));
};

const runWithdrawal = async (arguments_: readonly string[]) => {
  await requireDaemonStopped();
  const withdrawalPath = requireValue(arguments_, "--withdrawal");
  const withdrawalSha = requireValue(arguments_, "--withdrawal-sha256");
  const receiptPath = requireValue(arguments_, "--receipt");
  const withdrawal = Schema.decodeUnknownSync(CardWithdrawalV1Schema)(
    await readPrivateJsonFile(withdrawalPath, withdrawalSha),
  );
  if (requireValue(arguments_, "--confirm-withdrawal") !== withdrawal.withdrawalId) {
    throw new Error("withdrawal confirmation does not match artifact identity");
  }
  const receipt = await withCardRuntime(
    Effect.gen(function* withdrawCard() {
      const runtime = yield* ReviewedCardRuntime;
      return yield* runtime.withdraw(withdrawal);
    }),
  );
  const { CardWithdrawalReceiptV1Schema } = await import("@joelclaw-memory/domain");
  return writeReceipt(receiptPath, Schema.encodeSync(CardWithdrawalReceiptV1Schema)(receipt));
};

const runCardMigration = async (arguments_: readonly string[]) => {
  if (requireValue(arguments_, "--confirm-card-schema") !== "reviewed-memory-cards-v1") {
    throw new Error("card schema confirmation is invalid");
  }
  return Effect.runPromise(
    Effect.scoped(installReviewedCardSchema.pipe(Effect.provide(PostgresMigrationClientLive))),
  );
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
    case "withdraw":
      receipt = await runWithdrawal(arguments_);
      break;
    case "migrate-cards":
      receipt = await runCardMigration(arguments_);
      break;
    default:
      throw new Error(
        "usage: flowing-memory-host worker <run|preview|activate|withdraw|migrate-cards>",
      );
  }
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
};

await runWorkerCommand(process.argv.slice(2));
