import { createHash } from "node:crypto";

import {
  AdmissionCommandFactV1Schema,
  AdmissionWakeV1Schema,
  decodeDomain,
  encodeDomain,
  RawCaptureSourceCoordinatesV1Schema,
  RuntimeIdentityV1Schema,
} from "@joelclaw-memory/domain";
import { encodedJsonHash } from "@joelclaw-memory/postgres";
import { describe, expect, it } from "vitest";

import type { TrustedAdmissionConfigV1 } from "../src/admission-builder.js";
import {
  decodeOpenCodeTailRow,
  OpenCodeAuthorityCorruptTailError,
  type OpenCodeTailRowV1,
} from "../src/opencode-authority.js";
import { buildOpenCodeCandidate } from "../src/opencode-producer.js";
import type { OpenCodeSourceStreamV1 } from "../src/opencode-source.js";

const encoder = new TextEncoder();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const config: TrustedAdmissionConfigV1 = {
  adapterInstanceIdHash: "a".repeat(64),
  canonicalRepository: "github.com/joelclaw/fleet",
  principalIdHash: "b".repeat(64),
  privacy: "private",
  project: "joelclaw-fleet",
  projection: "enabled",
  repositoryHost: "github.com",
  repositoryName: "fleet",
  repositoryOwner: "joelclaw",
  scopeFallbackReason: "no-repository",
  scopeResolution: "fleetFallback",
  workstream: "default",
};

const stream = (): OpenCodeSourceStreamV1 => {
  const canonicalBytes = encoder.encode(
    `${JSON.stringify({
      schemaVersion: 1,
      sessionRef: "session",
      messageId: "message",
      role: "user",
      occurredAt: 1_700_000_000_000,
      parts: [{ partId: "part", text: "authority tail" }],
    })}\n`,
  );
  const hash = sha256(canonicalBytes);
  return {
    byteCount: canonicalBytes.byteLength,
    canonicalBytes,
    eligibleMessageCount: 1,
    finality: "open",
    prefixHash: hash,
    segmentHash: hash,
    sessionIdentityHash: sha256("session"),
    sourceCreatedAt: 1_700_000_000_000,
    sourceDirectory: "/synthetic",
    sourceWorkstream: "default",
    streamIdentityHash: sha256("stream"),
  };
};

const canonicalRow = (): OpenCodeTailRowV1 => {
  const candidate = buildOpenCodeCandidate({ config, stream: stream() });
  if (candidate?.built.command._tag !== "accept") throw new Error("expected acceptance");
  const acceptance = candidate.built.command.acceptance;
  const command = encodeDomain(AdmissionCommandFactV1Schema)({
    _tag: "accept",
    acceptance,
    schemaVersion: 1,
  });
  const source = encodeDomain(RawCaptureSourceCoordinatesV1Schema)(acceptance.source);
  const runtime = encodeDomain(RuntimeIdentityV1Schema)(acceptance.runtime);
  const outbox = encodeDomain(AdmissionWakeV1Schema)(
    decodeDomain(AdmissionWakeV1Schema)({
      _tag: "acceptedRun",
      captureEventId: acceptance.acceptanceId,
      schemaVersion: 1,
      sourceStreamId: acceptance.source.sourceStreamId,
    }),
  );
  return {
    adapter_stream_id_hash: acceptance.source.adapterStreamIdHash,
    admission_seq: "1",
    capture_event_id: acceptance.acceptanceId,
    command,
    command_fingerprint: encodedJsonHash(["admission-command:v1", command]),
    command_hash: encodedJsonHash(command),
    command_kind: "accept",
    conversation_id: acceptance.runtime.conversationId,
    current_privacy: "private",
    current_tail_window_seq: "1",
    disabled_from_byte: null,
    disposition: "admitted",
    from_byte: "0",
    outbox_admission_seq: "1",
    outbox_payload: outbox,
    outbox_payload_hash: encodedJsonHash(outbox),
    outbox_source_stream_id: acceptance.source.sourceStreamId,
    outbox_topic: "accepted-run.v1",
    outbox_wake_key: encodedJsonHash([
      "admission-wake:v1",
      "accepted-run.v1",
      acceptance.source.sourceStreamId,
      acceptance.acceptanceId,
    ]),
    outbox_window_seq: "1",
    predecessor_prefix_hash: null,
    predecessor_to_byte_exclusive: null,
    previous_prefix_hash: null,
    raw_segment_hash: acceptance.source.rawSegmentHash,
    runtime: "opencode",
    runtime_identity: runtime,
    runtime_identity_hash: encodedJsonHash(runtime),
    runtime_identity_proof_hash: acceptance.runtime.identityProofHash,
    scope_project: acceptance.scope.scope.project,
    scope_workstream: acceptance.scope.scope.workstream,
    source,
    source_hash: encodedJsonHash(source),
    source_prefix_hash: acceptance.source.sourcePrefixHash,
    source_stream_id: acceptance.source.sourceStreamId,
    to_byte_exclusive: String(acceptance.source.toByteExclusive),
    window_seq: "1",
  };
};

const corruptions: ReadonlyArray<readonly [string, (row: OpenCodeTailRowV1) => OpenCodeTailRowV1]> =
  [
    ["runtime", (row) => ({ ...row, runtime: "pi" })],
    ["runtime hash", (row) => ({ ...row, runtime_identity_hash: "0".repeat(64) })],
    ["runtime proof alias", (row) => ({ ...row, runtime_identity_proof_hash: "0".repeat(64) })],
    ["conversation alias", (row) => ({ ...row, conversation_id: "other" })],
    ["source stream alias", (row) => ({ ...row, source_stream_id: "0".repeat(64) })],
    ["scope", (row) => ({ ...row, scope_workstream: "other" })],
    ["source hash", (row) => ({ ...row, source_hash: "0".repeat(64) })],
    ["source prefix alias", (row) => ({ ...row, source_prefix_hash: "0".repeat(64) })],
    ["continuity", (row) => ({ ...row, predecessor_prefix_hash: "0".repeat(64) })],
    ["tail alias", (row) => ({ ...row, current_tail_window_seq: "2" })],
    ["projection disable state", (row) => ({ ...row, disabled_from_byte: "0" })],
    ["command hash", (row) => ({ ...row, command_hash: "0".repeat(64) })],
    ["command fingerprint", (row) => ({ ...row, command_fingerprint: "0".repeat(64) })],
    ["command kind", (row) => ({ ...row, command_kind: "exclude" })],
    ["capture fact", (row) => ({ ...row, capture_event_id: "0".repeat(64) })],
    ["missing outbox payload", (row) => ({ ...row, outbox_payload: null })],
    ["outbox payload hash", (row) => ({ ...row, outbox_payload_hash: "0".repeat(64) })],
    ["outbox topic", (row) => ({ ...row, outbox_topic: "semantic-excluded.v1" })],
    ["outbox key", (row) => ({ ...row, outbox_wake_key: "0".repeat(64) })],
    ["outbox admission", (row) => ({ ...row, outbox_admission_seq: "2" })],
    ["outbox window", (row) => ({ ...row, outbox_window_seq: "2" })],
  ];

describe("OpenCode authority tail", () => {
  it("decodes one canonical OpenCode tail with its accepted outbox fact", () => {
    expect(decodeOpenCodeTailRow(canonicalRow())).toMatchObject({
      privacy: "private",
      projection: "enabled",
      project: "joelclaw-fleet",
      workstream: "default",
    });
  });

  it.each(corruptions)("globally rejects corrupt %s", (_label, corrupt) => {
    expect(() => decodeOpenCodeTailRow(corrupt(canonicalRow()))).toThrow(
      OpenCodeAuthorityCorruptTailError,
    );
  });
});
