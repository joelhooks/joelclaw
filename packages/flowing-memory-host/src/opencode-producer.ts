import { createHash } from "node:crypto";

import type { PrivacyTier } from "@joelclaw-memory/domain";

import {
  type BuiltAdmissionV1,
  buildTrustedAdmissionV1,
  type TrustedAdmissionConfigV1,
  type TrustedAdmissionWakeV1,
  trustedAdmissionIdentityV1,
} from "./admission-builder.js";
import {
  OPENCODE_ENCODER_VERSION,
  type OpenCodeSourceSnapshotV1,
  type OpenCodeSourceStreamV1,
} from "./opencode-source.js";
import type { AdmissionLedgerClient, TrustedAdmissionWriter } from "./trusted-admission.js";

const MAX_RECONCILE_SESSIONS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const safeCode = (error: unknown, fallback: string) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9-]{1,80}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
};

export interface OpenCodeAcceptedTailV1 {
  readonly factId: string;
  readonly privacy: PrivacyTier;
  readonly project: string;
  readonly sourcePrefixHash: string;
  readonly sourceStreamId: string;
  readonly toByteExclusive: number;
  readonly toTurn?: number;
  readonly transcriptHash?: string;
  readonly workstream: string;
}

export interface OpenCodeAuthorityPreflightV1 {
  readonly migrationCompatible: boolean;
  readonly runtimeCompatible: boolean;
  readonly writable: boolean;
}

export interface OpenCodeAdmissionAuthority extends AdmissionLedgerClient {
  readonly preflight: (input: {
    readonly requireWrite: boolean;
  }) => Promise<OpenCodeAuthorityPreflightV1>;
  readonly readTail: (sourceStreamId: string) => Promise<OpenCodeAcceptedTailV1 | undefined>;
}

export type OpenCodeSessionFailureCode =
  | "admission-failed"
  | "candidate-invalid"
  | "scope-mismatch"
  | "scope-unavailable"
  | "source-prefix-mismatch"
  | "source-shrank"
  | "tail-coordinate-mismatch";

export class OpenCodeSessionBlockedError extends Error {
  readonly _tag = "OpenCodeSessionBlockedError";

  constructor(
    readonly code: OpenCodeSessionFailureCode,
    readonly sessionIdentityHash: string,
  ) {
    super("OpenCode session reconciliation blocked");
  }
}

export type OpenCodeGlobalFailureCode =
  | "apply-confirmation-required"
  | "authority-preflight-failed"
  | "authority-tail-unavailable"
  | "invalid-max-sessions"
  | "migration-incompatible"
  | "runtime-incompatible"
  | "runtime-write-unavailable";

export class OpenCodeGlobalStopError extends Error {
  readonly _tag = "OpenCodeGlobalStopError";

  constructor(readonly code: OpenCodeGlobalFailureCode) {
    super("OpenCode reconciliation stopped before mutation");
  }
}

export interface OpenCodeCandidateV1 {
  readonly built: BuiltAdmissionV1;
  readonly factId: string;
  readonly fromByte: number;
  readonly parentSessionIdentityHash?: string;
  readonly prefixHash: string;
  readonly runId?: string;
  readonly segmentHash: string;
  readonly sessionIdentityHash: string;
  readonly sourceStreamId: string;
  readonly toByteExclusive: number;
}

export type OpenCodeReconcileStreamReceiptV1 =
  | {
      readonly _tag: "candidate";
      readonly factId: string;
      readonly fromByte: number;
      readonly parentSessionIdentityHash?: string;
      readonly prefixHash: string;
      readonly runId?: string;
      readonly segmentHash: string;
      readonly sessionIdentityHash: string;
      readonly sourceStreamId: string;
      readonly toByteExclusive: number;
    }
  | {
      readonly _tag: "no-change";
      readonly prefixHash: string;
      readonly sessionIdentityHash: string;
      readonly sourceStreamId: string;
      readonly toByteExclusive: number;
    }
  | {
      readonly _tag: "settled";
      readonly disposition:
        | "admitted"
        | "deferred"
        | "excluded"
        | "finalized"
        | "quarantined"
        | "replay";
      readonly factId: string;
      readonly fromByte: number;
      readonly parentSessionIdentityHash?: string;
      readonly prefixHash: string;
      readonly runId?: string;
      readonly segmentHash: string;
      readonly sessionIdentityHash: string;
      readonly sourceStreamId: string;
      readonly toByteExclusive: number;
    }
  | {
      readonly _tag: "blocked" | "failed";
      readonly code: OpenCodeSessionFailureCode | string;
      readonly sessionIdentityHash: string;
    };

export interface OpenCodeReconcileReceiptV1 {
  readonly apply: boolean;
  readonly counts: {
    readonly blocked: number;
    readonly candidates: number;
    readonly failed: number;
    readonly noChange: number;
    readonly selected: number;
    readonly settled: number;
  };
  readonly encoderVersion: typeof OPENCODE_ENCODER_VERSION;
  readonly receiptVersion: 1;
  readonly streams: readonly OpenCodeReconcileStreamReceiptV1[];
}

export interface ReconcileOpenCodeOptionsV1 {
  readonly apply?: boolean;
  readonly confirmed?: boolean;
  readonly maxSessions: number;
}

export interface ReconcileOpenCodeDependenciesV1 {
  readonly authority: OpenCodeAdmissionAuthority;
  readonly resolveConfig: (
    stream: OpenCodeSourceStreamV1,
    snapshot: OpenCodeSourceSnapshotV1,
  ) => Promise<TrustedAdmissionConfigV1 | undefined>;
  readonly writer: TrustedAdmissionWriter;
}

const privacyRank: Readonly<Record<PrivacyTier, number>> = {
  private: 1,
  public: 0,
  sensitive: 2,
};

const preservePrivacy = (
  config: TrustedAdmissionConfigV1,
  tail: OpenCodeAcceptedTailV1 | undefined,
): TrustedAdmissionConfigV1 => {
  if (tail === undefined || privacyRank[config.privacy] >= privacyRank[tail.privacy]) {
    return config;
  }
  return { ...config, privacy: tail.privacy, projection: "disabled" };
};

const canonicalRecords = (bytes: Uint8Array): readonly Readonly<Record<string, unknown>>[] => {
  const records: Readonly<Record<string, unknown>>[] = [];
  for (const line of decoder.decode(bytes).split("\n")) {
    if (line.length === 0) continue;
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("opencode-canonical-record-invalid");
    }
    records.push(Object.fromEntries(Object.entries(value)));
  }
  return records;
};

const recordCount = (bytes: Uint8Array) => canonicalRecords(bytes).length;

const lastOccurredAt = (bytes: Uint8Array) => {
  const value = canonicalRecords(bytes).at(-1)?.occurredAt;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("opencode-canonical-record-invalid");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("opencode-canonical-record-invalid");
  return date.toISOString();
};

const eventIdFor = (input: {
  readonly fromByte: number;
  readonly prefixHash: string;
  readonly segmentHash: string;
  readonly sessionIdentityHash: string;
  readonly streamIdentityHash: string;
  readonly toByteExclusive: number;
}) =>
  sha256(
    JSON.stringify([
      "opencode-accepted-event:v1",
      OPENCODE_ENCODER_VERSION,
      input.sessionIdentityHash,
      input.streamIdentityHash,
      input.fromByte,
      input.toByteExclusive,
      input.segmentHash,
      input.prefixHash,
    ]),
  );

const wakeFor = (
  stream: OpenCodeSourceStreamV1,
  input: {
    readonly eventId: string;
    readonly occurredAt: string;
  },
): TrustedAdmissionWakeV1 => ({
  close: false,
  eventId: input.eventId,
  eventName: "opencode.reconcile",
  incarnationId: `${OPENCODE_ENCODER_VERSION}:${stream.streamIdentityHash}`,
  occurredAt: input.occurredAt,
  runtime: "opencode",
  schemaVersion: 1,
  sessionId: stream.sessionIdentityHash,
});

const requireTailContinuity = (stream: OpenCodeSourceStreamV1, tail: OpenCodeAcceptedTailV1) => {
  if (tail.toByteExclusive > stream.byteCount) {
    throw new OpenCodeSessionBlockedError("source-shrank", stream.sessionIdentityHash);
  }
  if (
    tail.toByteExclusive > 0 &&
    stream.canonicalBytes[tail.toByteExclusive - 1] !== encoder.encode("\n")[0]
  ) {
    throw new OpenCodeSessionBlockedError("tail-coordinate-mismatch", stream.sessionIdentityHash);
  }
  const acceptedPrefix = stream.canonicalBytes.subarray(0, tail.toByteExclusive);
  if (sha256(acceptedPrefix) !== tail.sourcePrefixHash) {
    throw new OpenCodeSessionBlockedError("source-prefix-mismatch", stream.sessionIdentityHash);
  }
  if (tail.toTurn !== undefined && recordCount(acceptedPrefix) !== tail.toTurn + 1) {
    throw new OpenCodeSessionBlockedError("tail-coordinate-mismatch", stream.sessionIdentityHash);
  }
};

export const buildOpenCodeCandidate = (input: {
  readonly config: TrustedAdmissionConfigV1;
  readonly stream: OpenCodeSourceStreamV1;
  readonly tail?: OpenCodeAcceptedTailV1;
}): OpenCodeCandidateV1 | undefined => {
  if (
    input.stream.byteCount !== input.stream.canonicalBytes.byteLength ||
    sha256(input.stream.canonicalBytes) !== input.stream.prefixHash ||
    input.stream.segmentHash !== input.stream.prefixHash
  ) {
    throw new OpenCodeSessionBlockedError("candidate-invalid", input.stream.sessionIdentityHash);
  }
  const config = preservePrivacy(input.config, input.tail);
  const identityWake = wakeFor(input.stream, {
    eventId: sha256(
      JSON.stringify([
        "opencode-stream-identity:v1",
        OPENCODE_ENCODER_VERSION,
        input.stream.sessionIdentityHash,
        input.stream.streamIdentityHash,
      ]),
    ),
    occurredAt: new Date(input.stream.sourceCreatedAt).toISOString(),
  });
  const identity = trustedAdmissionIdentityV1({ wake: identityWake }, config);
  const tail = input.tail;
  if (tail !== undefined) {
    if (tail.sourceStreamId !== identity.sourceStreamId) {
      throw new OpenCodeSessionBlockedError(
        "tail-coordinate-mismatch",
        input.stream.sessionIdentityHash,
      );
    }
    if (tail.project !== config.project || tail.workstream !== config.workstream) {
      throw new OpenCodeSessionBlockedError("scope-mismatch", input.stream.sessionIdentityHash);
    }
    requireTailContinuity(input.stream, tail);
    if (tail.toByteExclusive === input.stream.byteCount) return undefined;
  } else if (input.stream.byteCount === 0) {
    return undefined;
  }

  const fromByte = tail?.toByteExclusive ?? 0;
  const segmentBytes = input.stream.canonicalBytes.subarray(fromByte);
  if (segmentBytes.byteLength === 0) return undefined;
  const segmentHash = sha256(segmentBytes);
  const eventId = eventIdFor({
    fromByte,
    prefixHash: input.stream.prefixHash,
    segmentHash,
    sessionIdentityHash: input.stream.sessionIdentityHash,
    streamIdentityHash: input.stream.streamIdentityHash,
    toByteExclusive: input.stream.byteCount,
  });
  const wake = wakeFor(input.stream, { eventId, occurredAt: lastOccurredAt(segmentBytes) });
  const built = buildTrustedAdmissionV1(
    {
      fromByte,
      prefixBytes: input.stream.canonicalBytes,
      ...(tail?.transcriptHash === undefined || tail.toTurn === undefined
        ? {}
        : {
            previousTranscriptHash: tail.transcriptHash,
            priorTurnCount: tail.toTurn + 1,
          }),
      segmentBytes,
      toByteExclusive: input.stream.byteCount,
      wake,
    },
    config,
  );
  const acceptedRun = built.acceptedRun;
  const factId =
    built.command._tag === "accept"
      ? acceptedRun?.runId
      : built.command._tag === "exclude"
        ? built.command.receipt.exclusionId
        : undefined;
  if (
    factId === undefined ||
    (built.command._tag === "accept" &&
      (acceptedRun === undefined || acceptedRun.runtime !== "opencode" || acceptedRun.isFinal)) ||
    (built.command._tag === "exclude" && acceptedRun !== undefined)
  ) {
    throw new OpenCodeSessionBlockedError("candidate-invalid", input.stream.sessionIdentityHash);
  }
  return {
    built,
    factId,
    fromByte,
    ...(input.stream.parentSessionIdentityHash === undefined
      ? {}
      : { parentSessionIdentityHash: input.stream.parentSessionIdentityHash }),
    prefixHash: input.stream.prefixHash,
    ...(acceptedRun === undefined ? {} : { runId: acceptedRun.runId }),
    segmentHash,
    sessionIdentityHash: input.stream.sessionIdentityHash,
    sourceStreamId: identity.sourceStreamId,
    toByteExclusive: input.stream.byteCount,
  };
};

const countReceipts = (
  receipts: readonly OpenCodeReconcileStreamReceiptV1[],
): OpenCodeReconcileReceiptV1["counts"] => ({
  blocked: receipts.filter((receipt) => receipt._tag === "blocked").length,
  candidates: receipts.filter((receipt) => receipt._tag === "candidate").length,
  failed: receipts.filter((receipt) => receipt._tag === "failed").length,
  noChange: receipts.filter((receipt) => receipt._tag === "no-change").length,
  selected: receipts.length,
  settled: receipts.filter((receipt) => receipt._tag === "settled").length,
});

const candidateReceipt = (candidate: OpenCodeCandidateV1): OpenCodeReconcileStreamReceiptV1 => ({
  _tag: "candidate",
  factId: candidate.factId,
  fromByte: candidate.fromByte,
  ...(candidate.parentSessionIdentityHash === undefined
    ? {}
    : { parentSessionIdentityHash: candidate.parentSessionIdentityHash }),
  prefixHash: candidate.prefixHash,
  ...(candidate.runId === undefined ? {} : { runId: candidate.runId }),
  segmentHash: candidate.segmentHash,
  sessionIdentityHash: candidate.sessionIdentityHash,
  sourceStreamId: candidate.sourceStreamId,
  toByteExclusive: candidate.toByteExclusive,
});

export const reconcileOpenCodeSnapshot = async (
  snapshot: OpenCodeSourceSnapshotV1,
  options: ReconcileOpenCodeOptionsV1,
  dependencies: ReconcileOpenCodeDependenciesV1,
): Promise<OpenCodeReconcileReceiptV1> => {
  const apply = options.apply === true;
  if (
    !Number.isSafeInteger(options.maxSessions) ||
    options.maxSessions < 1 ||
    options.maxSessions > MAX_RECONCILE_SESSIONS
  ) {
    throw new OpenCodeGlobalStopError("invalid-max-sessions");
  }
  if (apply && options.confirmed !== true) {
    throw new OpenCodeGlobalStopError("apply-confirmation-required");
  }

  let preflight: OpenCodeAuthorityPreflightV1;
  try {
    preflight = await dependencies.authority.preflight({ requireWrite: apply });
  } catch {
    throw new OpenCodeGlobalStopError("authority-preflight-failed");
  }
  if (!preflight.migrationCompatible) {
    throw new OpenCodeGlobalStopError("migration-incompatible");
  }
  if (!preflight.runtimeCompatible) {
    throw new OpenCodeGlobalStopError("runtime-incompatible");
  }
  if (apply && !preflight.writable) {
    throw new OpenCodeGlobalStopError("runtime-write-unavailable");
  }

  const selected = snapshot.streams
    .toSorted(
      (left, right) =>
        left.sourceCreatedAt - right.sourceCreatedAt ||
        left.sessionIdentityHash.localeCompare(right.sessionIdentityHash),
    )
    .slice(0, options.maxSessions);
  const planned: Array<
    | { readonly candidate: OpenCodeCandidateV1 }
    | { readonly receipt: OpenCodeReconcileStreamReceiptV1 }
  > = [];

  for (const stream of selected) {
    try {
      const unresolvedConfig = await dependencies.resolveConfig(stream, snapshot);
      if (unresolvedConfig === undefined) {
        planned.push({
          receipt: {
            _tag: "failed",
            code: "scope-unavailable",
            sessionIdentityHash: stream.sessionIdentityHash,
          },
        });
        continue;
      }
      const identityWake = wakeFor(stream, {
        eventId: sha256(
          JSON.stringify([
            "opencode-stream-identity:v1",
            OPENCODE_ENCODER_VERSION,
            stream.sessionIdentityHash,
            stream.streamIdentityHash,
          ]),
        ),
        occurredAt: new Date(stream.sourceCreatedAt).toISOString(),
      });
      const sourceStreamId = trustedAdmissionIdentityV1(
        { wake: identityWake },
        unresolvedConfig,
      ).sourceStreamId;
      let tail: OpenCodeAcceptedTailV1 | undefined;
      try {
        tail = await dependencies.authority.readTail(sourceStreamId);
      } catch (error) {
        if (error instanceof OpenCodeSessionBlockedError) throw error;
        throw new OpenCodeGlobalStopError("authority-tail-unavailable");
      }
      const candidate = buildOpenCodeCandidate({
        config: unresolvedConfig,
        stream,
        ...(tail === undefined ? {} : { tail }),
      });
      planned.push(
        candidate === undefined
          ? {
              receipt: {
                _tag: "no-change",
                prefixHash: stream.prefixHash,
                sessionIdentityHash: stream.sessionIdentityHash,
                sourceStreamId,
                toByteExclusive: stream.byteCount,
              },
            }
          : { candidate },
      );
    } catch (error) {
      if (error instanceof OpenCodeGlobalStopError) throw error;
      planned.push({
        receipt:
          error instanceof OpenCodeSessionBlockedError
            ? {
                _tag: "blocked",
                code: error.code,
                sessionIdentityHash: error.sessionIdentityHash,
              }
            : {
                _tag: "failed",
                code: safeCode(error, "candidate-invalid"),
                sessionIdentityHash: stream.sessionIdentityHash,
              },
      });
    }
  }

  const receipts: OpenCodeReconcileStreamReceiptV1[] = [];
  for (const plan of planned) {
    if ("receipt" in plan) {
      receipts.push(plan.receipt);
      continue;
    }
    const candidate = plan.candidate;
    if (!apply) {
      receipts.push(candidateReceipt(candidate));
      continue;
    }
    try {
      const result = await dependencies.writer.admitBuilt(candidate.built);
      receipts.push({
        _tag: "settled",
        disposition: result.disposition,
        factId: candidate.factId,
        fromByte: candidate.fromByte,
        ...(candidate.parentSessionIdentityHash === undefined
          ? {}
          : { parentSessionIdentityHash: candidate.parentSessionIdentityHash }),
        prefixHash: candidate.prefixHash,
        ...(candidate.runId === undefined ? {} : { runId: candidate.runId }),
        segmentHash: candidate.segmentHash,
        sessionIdentityHash: candidate.sessionIdentityHash,
        sourceStreamId: candidate.sourceStreamId,
        toByteExclusive: candidate.toByteExclusive,
      });
    } catch (error) {
      receipts.push({
        _tag: "failed",
        code: safeCode(error, "admission-failed"),
        sessionIdentityHash: candidate.sessionIdentityHash,
      });
    }
  }

  return {
    apply,
    counts: countReceipts(receipts),
    encoderVersion: OPENCODE_ENCODER_VERSION,
    receiptVersion: 1,
    streams: receipts,
  };
};
