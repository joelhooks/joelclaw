import { writeSync } from "node:fs";

import { WorkerOwnershipError } from "./worker-ownership.mjs";

export const runWorkerMain = async (run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    const code = error instanceof WorkerOwnershipError ? error.code : "worker-command-failed";
    const message = error instanceof Error ? error.message : "worker command failed";
    writeSync(process.stderr.fd, `${JSON.stringify({ ok: false, error: code, message })}\n`);
    process.exit(1);
  }
};
