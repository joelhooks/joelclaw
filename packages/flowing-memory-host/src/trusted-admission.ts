import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import {
  AcceptedRunDeltaV1Schema,
  AdmissionCommandV1Schema,
  type AdmissionResultV1,
  acceptedRunDeltaV1MatchesAcceptance,
  encodeDomain,
} from "@joelclaw-memory/domain";

import {
  type BuiltAdmissionV1,
  buildTrustedAdmissionV1,
  type TrustedAdmissionConfigV1,
  type TrustedAdmissionInputV1,
} from "./admission-builder.js";
import type { NativeAdmissionPort, NativeAdmissionResultV1 } from "./collector.js";

export interface AdmissionLedgerClient {
  readonly admit: (command: unknown) => Promise<AdmissionResultV1>;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type ImmutableEvidenceStage = "postinstall" | "prefact" | "preinstall";

export interface ImmutableEvidenceHooks {
  readonly onStage?: (stage: ImmutableEvidenceStage) => Promise<void> | void;
}

const syncDirectory = async (directory: string) => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const requireExistingExact = async (target: string, bytes: Uint8Array) => {
  const existing = await readFile(target);
  if (sha(existing) !== sha(bytes)) {
    throw new Error("immutable-evidence-identity-conflict");
  }
};

/**
 * Persist one immutable evidence body before its ledger fact is admitted.
 * The hard-link install is atomic and refuses to replace an existing body.
 */
export const persistImmutableEvidence = async (
  target: string,
  bytes: Uint8Array,
  hooks: ImmutableEvidenceHooks = {},
) => {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await hooks.onStage?.("preinstall");
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await requireExistingExact(target, bytes);
    }
    await hooks.onStage?.("postinstall");
    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(directory);
    await hooks.onStage?.("prefact");
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
};

export interface TrustedAdmissionWriter {
  readonly admitBuilt: (built: BuiltAdmissionV1) => Promise<NativeAdmissionResultV1>;
}

export const makeTrustedAdmissionWriter = (input: {
  readonly evidenceDirectory: string;
  readonly evidenceHooks?: ImmutableEvidenceHooks;
  readonly ledger: AdmissionLedgerClient;
}): TrustedAdmissionWriter => ({
  admitBuilt: async (built) => {
    if (built.acceptedRun !== undefined) {
      const acceptance = built.command._tag === "accept" ? built.command.acceptance : undefined;
      if (acceptance === undefined) {
        throw new Error("accepted-run-without-acceptance");
      }
      if (
        acceptance.projection.decision === "enabled" &&
        !acceptedRunDeltaV1MatchesAcceptance(acceptance, built.acceptedRun)
      ) {
        throw new Error("accepted-run-acceptance-mismatch");
      }
      const encoded = encodeDomain(AcceptedRunDeltaV1Schema)(built.acceptedRun);
      await persistImmutableEvidence(
        path.join(input.evidenceDirectory, `${built.acceptedRun.runId}.accepted-run-v1.json`),
        new TextEncoder().encode(`${JSON.stringify(encoded)}\n`),
        input.evidenceHooks,
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

const buildNativeAdmission = (
  nativeInput: TrustedAdmissionInputV1,
  config: TrustedAdmissionConfigV1,
): BuiltAdmissionV1 | undefined => {
  try {
    return buildTrustedAdmissionV1(nativeInput, config);
  } catch (error) {
    const schemaRejected =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "SchemaError";
    if (
      schemaRejected ||
      (error instanceof Error && error.message === "native-window-has-no-turns")
    ) {
      return undefined;
    }
    throw error;
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
}): NativeAdmissionPort => {
  const writer = makeTrustedAdmissionWriter(input);
  return {
    admit: async (nativeInput) => {
      const config =
        typeof input.config === "function" ? await input.config(nativeInput) : input.config;
      if (config === undefined) return { disposition: "deferred" };
      const built = buildNativeAdmission(nativeInput, config);
      if (built === undefined) return { disposition: "excluded" };
      return writer.admitBuilt(built);
    },
  };
};
