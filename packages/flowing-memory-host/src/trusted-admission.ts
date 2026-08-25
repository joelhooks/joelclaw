import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  AcceptedRunDeltaV1Schema,
  AdmissionCommandV1Schema,
  type AdmissionResultV1,
  encodeDomain,
} from "@joelclaw-memory/domain";

import { buildTrustedAdmissionV1, type TrustedAdmissionConfigV1 } from "./admission-builder.js";
import type { NativeAdmissionPort } from "./collector.js";

export interface AdmissionLedgerClient {
  readonly admit: (command: unknown) => Promise<AdmissionResultV1>;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const writeImmutable = async (target: string, bytes: Uint8Array) => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (sha(existing) !== sha(bytes)) {
      throw new Error("immutable-evidence-identity-conflict");
    }
  }
};

export const makeTrustedNativeAdmissionPort = (input: {
  readonly config:
    | TrustedAdmissionConfigV1
    | ((
        nativeInput: Parameters<NativeAdmissionPort["admit"]>[0],
      ) => Promise<TrustedAdmissionConfigV1 | undefined> | TrustedAdmissionConfigV1 | undefined);
  readonly evidenceDirectory: string;
  readonly ledger: AdmissionLedgerClient;
}): NativeAdmissionPort => ({
  admit: async (nativeInput) => {
    const config =
      typeof input.config === "function" ? await input.config(nativeInput) : input.config;
    if (config === undefined) return { disposition: "deferred" };
    let built: ReturnType<typeof buildTrustedAdmissionV1>;
    try {
      built = buildTrustedAdmissionV1(nativeInput, config);
    } catch (error) {
      if (error instanceof Error && error.message === "native-window-has-no-turns") {
        return { disposition: "excluded" };
      }
      throw error;
    }
    if (built.acceptedRun !== undefined) {
      const acceptance = built.command._tag === "accept" ? built.command.acceptance : undefined;
      if (acceptance === undefined) {
        throw new Error("accepted-run-without-acceptance");
      }
      const encoded = encodeDomain(AcceptedRunDeltaV1Schema)(built.acceptedRun);
      await writeImmutable(
        path.join(input.evidenceDirectory, `${built.acceptedRun.runId}.accepted-run-v1.json`),
        new TextEncoder().encode(`${JSON.stringify(encoded)}\n`),
      );
    }
    const result = await input.ledger.admit(encodeDomain(AdmissionCommandV1Schema)(built.command));
    return {
      ...(built.acceptedRun?.toTurn === undefined
        ? {}
        : { acceptedToTurn: built.acceptedRun.toTurn }),
      ...(built.acceptedRun?.transcriptHash === undefined
        ? {}
        : { acceptedTranscriptHash: built.acceptedRun.transcriptHash }),
      disposition: result.disposition,
    };
  },
});
