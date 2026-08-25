import { createHash } from "node:crypto";

import {
  AcceptedRunAcceptanceV1Schema,
  type AcceptedRunDeltaV1,
  AcceptedRunDeltaV1Schema,
  type AdmissionCommandV1,
  AdmissionCommandV1Schema,
  acceptedRunSourceRef,
  CanonicalRepositoryIdentityV1Schema,
  CaptureFinalityV1Schema,
  CapturePolicyIdentityV1Schema,
  CaptureSourceCoordinatesV1Schema,
  canonicalCaptureAcceptanceId,
  canonicalRepositoryIdentityHash,
  capturePolicySnapshotId,
  decodeDomain,
  encodeDomain,
  finalityAttestationHash,
  HashSchema,
  PrivacyPolicyAttestationV1Schema,
  PrivacyPolicyLayerV1Schema,
  type PrivacyTier,
  ProjectionPolicyAttestationV1Schema,
  ProjectionPolicyLayerV1Schema,
  privacyPolicyHash,
  projectionPolicyHash,
  RawCaptureSourceCoordinatesV1Schema,
  RedactionAttestationV2Schema,
  RunTurnSchema,
  RuntimeAuthorityV1Schema,
  RuntimeIdentityV1Schema,
  type RuntimeKind,
  runtimeIdentityProofHash,
  ScopeResolutionAttestationV1Schema,
  SemanticExclusionReceiptV1Schema,
  SourceFinalityEventV1Schema,
  semanticExclusionId,
  semanticExclusionPolicySnapshotId,
  sourceFinalityEventId,
  sourceStreamId,
  transcriptPayloadHash,
} from "@joelclaw-memory/domain";

export interface TrustedAdmissionWakeV1 {
  readonly close: boolean;
  readonly cwd?: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly incarnationId: string;
  readonly occurredAt: string;
  readonly runtime: RuntimeKind;
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly transcriptPath?: string;
}

export interface TrustedAdmissionInputV1 {
  readonly fromByte: number;
  readonly prefixBytes: Uint8Array;
  readonly priorTurnCount?: number;
  readonly previousTranscriptHash?: string;
  readonly segmentBytes: Uint8Array;
  readonly toByteExclusive: number;
  readonly wake: TrustedAdmissionWakeV1;
}

export interface TrustedAdmissionConfigV1 {
  readonly adapterInstanceIdHash: string;
  readonly canonicalRepository: string;
  readonly principalIdHash: string;
  readonly privacy: PrivacyTier;
  readonly project: string;
  readonly projection?: "disabled" | "enabled";
  readonly repositoryHost: string;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
  readonly scopeFallbackReason?: "no-repository" | "untrusted-repository";
  readonly scopeResolution?: "fleetFallback" | "repository";
  readonly workstream: string;
}

export interface BuiltAdmissionV1 {
  readonly acceptedRun?: AcceptedRunDeltaV1;
  readonly command: AdmissionCommandV1;
}

interface NativeTurn {
  readonly occurredAt: string;
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly text: string;
}

const hash = (value: string | Uint8Array) =>
  decodeDomain(HashSchema)(createHash("sha256").update(value).digest("hex"));

const jsonObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const contentText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    const object = jsonObject(item);
    const text = object?.text;
    return typeof text === "string" && text.length > 0 ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const occurredAtFor = (rawTime: unknown, fallbackTime: string) => {
  if (typeof rawTime === "string" && !Number.isNaN(Date.parse(rawTime))) {
    return new Date(rawTime).toISOString();
  }
  if (typeof rawTime === "number" && Number.isFinite(rawTime)) {
    const parsed = new Date(rawTime);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallbackTime;
};

const decodeOpenCodeCanonicalTurns = (
  bytes: Uint8Array,
  fallbackTime: string,
): readonly NativeTurn[] => {
  const turns: NativeTurn[] = [];
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("opencode-canonical-record-invalid");
    }
    const entry = jsonObject(parsed);
    const role = entry?.role;
    const parts = entry?.parts;
    if (
      entry?.schemaVersion !== 1 ||
      typeof entry.sessionRef !== "string" ||
      typeof entry.messageId !== "string" ||
      (role !== "assistant" && role !== "user") ||
      !Array.isArray(parts)
    ) {
      throw new Error("opencode-canonical-record-invalid");
    }
    const textParts = parts.map((part) => {
      const value = jsonObject(part);
      if (
        typeof value?.partId !== "string" ||
        typeof value.text !== "string" ||
        value.text.trim().length === 0
      ) {
        throw new Error("opencode-canonical-record-invalid");
      }
      return value.text;
    });
    if (textParts.length === 0) throw new Error("opencode-canonical-record-invalid");
    turns.push({
      occurredAt: occurredAtFor(entry.occurredAt, fallbackTime),
      role,
      text: textParts.join("\n"),
    });
  }
  return turns;
};

const decodeJsonlTurns = (bytes: Uint8Array, fallbackTime: string): readonly NativeTurn[] => {
  const turns: NativeTurn[] = [];
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = jsonObject(parsed);
    const update = jsonObject(jsonObject(entry?.params)?.update);
    const updateKind = update?.sessionUpdate;
    const acpRole =
      updateKind === "user_message_chunk"
        ? "user"
        : updateKind === "agent_message_chunk"
          ? "assistant"
          : undefined;
    if (acpRole !== undefined) {
      const text = contentText(jsonObject(update?.content)?.text);
      if (text !== undefined && text.length > 0) {
        turns.push({
          occurredAt: occurredAtFor(entry?.timestamp, fallbackTime),
          role: acpRole,
          text,
        });
      }
      continue;
    }
    const payload = jsonObject(entry?.payload);
    if (entry?.type === "response_item" && payload?.type === "message") {
      const role = payload.role;
      if (role !== "assistant" && role !== "user") continue;
      const content = Array.isArray(payload.content)
        ? payload.content.flatMap((item) => {
            const part = jsonObject(item);
            const expectedType = role === "user" ? "input_text" : "output_text";
            return part?.type === expectedType && typeof part.text === "string" ? [part.text] : [];
          })
        : [];
      if (role === "user" && content.length !== 1) continue;
      const text = content.join("\n");
      if (text.length > 0) {
        turns.push({ occurredAt: occurredAtFor(entry.timestamp, fallbackTime), role, text });
      }
      continue;
    }
    const rawMessage = entry?.message;
    const message = jsonObject(rawMessage) ?? payload;
    const role = message?.role ?? entry?.role;
    if (role !== "assistant" && role !== "system" && role !== "tool" && role !== "user") {
      continue;
    }
    const text =
      contentText(message?.content) ??
      contentText(entry?.content) ??
      (typeof rawMessage === "string" ? rawMessage : undefined) ??
      (typeof message?.text === "string" ? message.text : undefined);
    if (text === undefined || text.length === 0) continue;
    const rawTime = entry?.timestamp ?? message?.timestamp ?? entry?.created_at;
    turns.push({ occurredAt: occurredAtFor(rawTime, fallbackTime), role, text });
  }
  return turns;
};

const secretPatterns = [
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-(?:ant-[A-Za-z0-9_-]+|proj-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,})\b/gu,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{30,}\b/gu,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu,
  /\bnpm_[A-Za-z0-9]{20,}\b/gu,
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /\bBearer\s+[A-Za-z0-9_./+=-]{20,}/giu,
  /\b(?:api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/giu,
  /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s:/]+:[^\s@]{8,}@[^\s]+/giu,
] as const;

const redact = (text: string) => {
  let output = text;
  let count = 0;
  for (const pattern of secretPatterns) {
    output = output.replace(pattern, () => {
      count += 1;
      return "[REDACTED]";
    });
  }
  return { count, text: output };
};

export const trustedAdmissionIdentityV1 = (
  input: Pick<TrustedAdmissionInputV1, "wake">,
  config: TrustedAdmissionConfigV1,
) => {
  const authority = decodeDomain(RuntimeAuthorityV1Schema)({
    _tag: "hostAsserted",
    producerPrincipalIdHash: config.principalIdHash,
    schemaVersion: 1,
  });
  const conversationId = `native-${hash(`${input.wake.runtime}:${input.wake.sessionId}`).slice(0, 32)}`;
  const identityInput = {
    adapterInstanceIdHash: config.adapterInstanceIdHash,
    adapterName: "joelclaw-flowing-memory-host",
    adapterVersion: "1",
    authority,
    conversationId,
    nativeSessionIdHash: hash(input.wake.sessionId),
    runtime: input.wake.runtime,
    schemaVersion: 1 as const,
  };
  const runtime = decodeDomain(RuntimeIdentityV1Schema)({
    ...identityInput,
    identityProofHash: runtimeIdentityProofHash(identityInput),
  });
  const adapterStreamIdHash = hash(
    JSON.stringify([input.wake.runtime, input.wake.sessionId, input.wake.incarnationId]),
  );
  return {
    adapterStreamIdHash,
    runtime,
    sourceStreamId: sourceStreamId({
      adapterStreamIdHash,
      runtimeIdentityProofHash: runtime.identityProofHash,
    }),
  };
};

const buildPolicies = (
  input: TrustedAdmissionInputV1,
  config: TrustedAdmissionConfigV1,
  identity: ReturnType<typeof trustedAdmissionIdentityV1>,
  resolvedAt: string,
) => {
  const repository = decodeDomain(CanonicalRepositoryIdentityV1Schema)({
    canonical: config.canonicalRepository,
    host: config.repositoryHost,
    name: config.repositoryName,
    owner: config.repositoryOwner,
    schemaVersion: 1,
  });
  const scopeFromByte = input.fromByte === input.toByteExclusive ? 0 : input.fromByte;
  const commonScope = {
    boundary:
      config.scopeResolution === "fleetFallback"
        ? ("fallback-no-repo" as const)
        : scopeFromByte === 0
          ? ("session-start" as const)
          : ("turn-boundary" as const),
    fromByte: scopeFromByte,
    resolvedAt,
    resolverPolicyHash: hash("scope-resolver:flowing-memory-host:v1"),
    schemaVersion: 1 as const,
    scope: {
      _tag: "ProjectWorkstream" as const,
      project: config.project,
      workstream: config.workstream,
    },
    sourceStreamId: identity.sourceStreamId,
    toByteExclusive: input.toByteExclusive,
    trustedInputHash: hash(
      JSON.stringify([
        config.canonicalRepository,
        config.project,
        config.workstream,
        input.wake.sessionId,
      ]),
    ),
  };
  const scope = decodeDomain(ScopeResolutionAttestationV1Schema)(
    config.scopeResolution === "fleetFallback"
      ? {
          _tag: "fleetFallback",
          ...commonScope,
          reason: config.scopeFallbackReason ?? "no-repository",
        }
      : {
          _tag: "repository",
          ...commonScope,
          basis: "canonical-repository",
          repository,
          repositoryIdentityHash: canonicalRepositoryIdentityHash(repository),
        },
  );
  const privacyLayers = [
    decodeDomain(PrivacyPolicyLayerV1Schema)({
      _tag: "fleet",
      policyHash: hash("privacy:flowing-memory-host:v1"),
      privacyFloor: config.privacy,
    }),
  ];
  const privacy = decodeDomain(PrivacyPolicyAttestationV1Schema)({
    effectiveFromByte: input.fromByte,
    layers: privacyLayers,
    policyHash: privacyPolicyHash(privacyLayers),
    resolvedAt,
    schemaVersion: 1,
    tier: config.privacy,
  });
  const projectionDecision = config.projection ?? "enabled";
  const projectionLayers = [
    decodeDomain(ProjectionPolicyLayerV1Schema)({
      _tag: "fleet",
      decision: projectionDecision,
      policyHash: hash("projection:flowing-memory-host:v2"),
    }),
  ];
  const projection = decodeDomain(ProjectionPolicyAttestationV1Schema)({
    decision: projectionDecision,
    disableEffect: projectionDecision === "enabled" ? "none" : "future-windows",
    effectiveFromByte: input.fromByte,
    layers: projectionLayers,
    policyHash: projectionPolicyHash(projectionLayers),
    resolvedAt,
    schemaVersion: 1,
  });
  return { privacy, projection, scope };
};

const invocationId = (eventId: string, kind: string) =>
  hash(JSON.stringify(["host-admission:v1", kind, eventId]));

export const buildTrustedAdmissionV1 = (
  input: TrustedAdmissionInputV1,
  config: TrustedAdmissionConfigV1,
): BuiltAdmissionV1 => {
  const identity = trustedAdmissionIdentityV1(input, config);
  const semanticAcceptedAt = new Date(input.wake.occurredAt).toISOString();
  const rawAcceptedAt = semanticAcceptedAt;
  const policies = buildPolicies(input, config, identity, semanticAcceptedAt);
  const decodeTurns =
    input.wake.runtime === "opencode" ? decodeOpenCodeCanonicalTurns : decodeJsonlTurns;
  const allTurns = decodeTurns(input.prefixBytes, input.wake.occurredAt);
  const priorTurns = decodeTurns(
    input.prefixBytes.subarray(0, input.fromByte),
    input.wake.occurredAt,
  );
  const priorTurnCount = input.priorTurnCount ?? priorTurns.length;
  const priorTurnRecords = priorTurns.map((turn, index) =>
    decodeDomain(RunTurnSchema)({
      occurredAt: turn.occurredAt,
      role: turn.role,
      text: turn.text,
      turn: index,
    }),
  );
  const derivedPreviousTranscriptHash =
    priorTurnCount === 0 ? undefined : transcriptPayloadHash(priorTurnRecords);
  const previousTranscriptHash = input.previousTranscriptHash ?? derivedPreviousTranscriptHash;
  const deltaTurns = allTurns.slice(priorTurnCount);
  const sourcePrefixHash = hash(input.prefixBytes);
  const previousPrefixHash =
    input.fromByte === 0 ? undefined : hash(input.prefixBytes.subarray(0, input.fromByte));

  if (deltaTurns.length === 0) {
    if (!input.wake.close) {
      throw new Error("native-window-has-no-turns");
    }
    const finality = decodeDomain(CaptureFinalityV1Schema)({
      _tag: "final",
      attestationHash: finalityAttestationHash({
        attestedByHash: identity.runtime.adapterInstanceIdHash,
        closeReason: "normal",
        finalByteExclusive: input.toByteExclusive,
        finalPrefixHash: sourcePrefixHash,
        runtimeClosedAt: rawAcceptedAt,
        sourceStreamId: identity.sourceStreamId,
      }),
      attestedByHash: identity.runtime.adapterInstanceIdHash,
      closeReason: "normal",
      finalByteExclusive: input.toByteExclusive,
      finalPrefixHash: sourcePrefixHash,
      runtimeClosedAt: rawAcceptedAt,
      schemaVersion: 1,
      sourceStreamId: identity.sourceStreamId,
    });
    if (finality._tag !== "final") {
      throw new Error("finality-construction-failed");
    }
    const event = decodeDomain(SourceFinalityEventV1Schema)({
      _tag: "SourceFinalityEventV1",
      eventId: input.wake.eventId,
      finality: encodeDomain(CaptureFinalityV1Schema)(finality),
      finalityEventId: sourceFinalityEventId({
        eventId: input.wake.eventId,
        finality,
        runtimeIdentityProofHash: identity.runtime.identityProofHash,
      }),
      runtimeIdentityProofHash: identity.runtime.identityProofHash,
      schemaVersion: 1,
    });
    return {
      command: decodeDomain(AdmissionCommandV1Schema)({
        _tag: "finalize",
        finality: encodeDomain(SourceFinalityEventV1Schema)(event),
        identity: {
          adapterStreamIdHash: identity.adapterStreamIdHash,
          conversationId: identity.runtime.conversationId,
          runtime: encodeDomain(RuntimeIdentityV1Schema)(identity.runtime),
          scope: policies.scope.scope,
          sourceStreamId: identity.sourceStreamId,
        },
        invocationId: invocationId(input.wake.eventId, "finalize"),
        occurredAt: semanticAcceptedAt,
        schemaVersion: 1,
      }),
    };
  }

  const rawSourceInput = {
    adapterStreamIdHash: identity.adapterStreamIdHash,
    coverage: input.fromByte === 0 ? ("prefix" as const) : ("delta" as const),
    fromByte: input.fromByte,
    offsetUnit: "bytes" as const,
    ...(previousPrefixHash === undefined ? {} : { previousPrefixHash }),
    rawByteCount: input.segmentBytes.byteLength,
    rawRunId: `raw-${hash(input.wake.eventId).slice(0, 32)}`,
    rawSegmentHash: hash(input.segmentBytes),
    schemaVersion: 1 as const,
    sourcePrefixHash,
    sourceStreamId: identity.sourceStreamId,
    toByteExclusive: input.toByteExclusive,
  };
  if (policies.projection.decision === "disabled") {
    const source = decodeDomain(RawCaptureSourceCoordinatesV1Schema)(rawSourceInput);
    const policySnapshotId = semanticExclusionPolicySnapshotId({
      privacy: policies.privacy,
      projection: policies.projection,
      scope: policies.scope,
    });
    const receipt = decodeDomain(SemanticExclusionReceiptV1Schema)({
      _tag: "SemanticExclusionReceiptV1",
      eventId: input.wake.eventId,
      exclusionId: semanticExclusionId({
        eventId: input.wake.eventId,
        policySnapshotId,
        rawAcceptedAt,
        runtimeIdentityProofHash: identity.runtime.identityProofHash,
        scope: policies.scope.scope,
        source,
      }),
      policySnapshotId,
      privacy: encodeDomain(PrivacyPolicyAttestationV1Schema)(policies.privacy),
      projection: encodeDomain(ProjectionPolicyAttestationV1Schema)(policies.projection),
      rawAcceptedAt,
      runtime: encodeDomain(RuntimeIdentityV1Schema)(identity.runtime),
      schemaVersion: 1,
      scope: encodeDomain(ScopeResolutionAttestationV1Schema)(policies.scope),
      source: encodeDomain(RawCaptureSourceCoordinatesV1Schema)(source),
    });
    return {
      command: decodeDomain(AdmissionCommandV1Schema)({
        _tag: "exclude",
        invocationId: invocationId(input.wake.eventId, "exclude"),
        occurredAt: semanticAcceptedAt,
        prefixBytes: input.prefixBytes,
        receipt: encodeDomain(SemanticExclusionReceiptV1Schema)(receipt),
        schemaVersion: 1,
        segmentBytes: input.segmentBytes,
      }),
    };
  }

  const redacted = deltaTurns.map((turn) => ({ ...turn, ...redact(turn.text) }));
  const redactionCount = redacted.reduce((sum, turn) => sum + turn.count, 0);
  const fromTurn = priorTurnCount;
  const turns = redacted.map((turn, index) => ({
    occurredAt: turn.occurredAt,
    role: turn.role,
    text: turn.text,
    turn: fromTurn + index,
  }));
  const transcriptHash = transcriptPayloadHash(
    turns.map((turn) => decodeDomain(RunTurnSchema)(turn)),
  );
  const source = decodeDomain(CaptureSourceCoordinatesV1Schema)({
    ...rawSourceInput,
    fromTurn,
    toTurn: turns.at(-1)?.turn,
  });
  const redactionPolicyHash = hash("secret-scan:flowing-memory-host:v2");
  const policySnapshotId = capturePolicySnapshotId({
    privacy: policies.privacy,
    projection: policies.projection,
    redactionPolicyHash,
    scope: policies.scope,
  });
  const redaction = decodeDomain(RedactionAttestationV2Schema)({
    _tag: redactionCount === 0 ? "clean" : "redacted",
    inputSegmentHash: source.rawSegmentHash,
    outputTranscriptHash: transcriptHash,
    policySnapshotId,
    ...(redactionCount === 0 ? {} : { redactionCount }),
    redactionPolicyHash,
    scannedAt: semanticAcceptedAt,
    scannerId: "flowing-memory-secret-scan",
    scannerVersion: "2",
    schemaVersion: 2,
  });
  const finality = input.wake.close
    ? decodeDomain(CaptureFinalityV1Schema)({
        _tag: "final",
        attestationHash: finalityAttestationHash({
          attestedByHash: identity.runtime.adapterInstanceIdHash,
          closeReason: "normal",
          finalByteExclusive: input.toByteExclusive,
          finalPrefixHash: sourcePrefixHash,
          runtimeClosedAt: rawAcceptedAt,
          sourceStreamId: identity.sourceStreamId,
        }),
        attestedByHash: identity.runtime.adapterInstanceIdHash,
        closeReason: "normal",
        finalByteExclusive: input.toByteExclusive,
        finalPrefixHash: sourcePrefixHash,
        runtimeClosedAt: rawAcceptedAt,
        schemaVersion: 1,
        sourceStreamId: identity.sourceStreamId,
      })
    : decodeDomain(CaptureFinalityV1Schema)({
        _tag: "open",
        attestedAt: rawAcceptedAt,
        schemaVersion: 1,
      });
  const policy = decodeDomain(CapturePolicyIdentityV1Schema)({
    policySnapshotId,
    privacyPolicyHash: policies.privacy.policyHash,
    projectionPolicyHash: policies.projection.policyHash,
    redactionPolicyHash,
    schemaVersion: 1,
    scopeResolverPolicyHash: policies.scope.resolverPolicyHash,
  });
  const observedFrom = turns[0]?.occurredAt;
  const observedThrough = turns.at(-1)?.occurredAt;
  if (observedFrom === undefined || observedThrough === undefined) {
    throw new Error("native-window-has-no-turns");
  }
  const base = {
    conversationId: identity.runtime.conversationId,
    eventId: input.wake.eventId,
    finality,
    fromTurn,
    observedFrom,
    observedThrough,
    policy,
    previousTranscriptHash,
    privacy: policies.privacy,
    projection: policies.projection,
    rawAcceptedAt,
    redaction,
    runId: `run-${hash(input.wake.eventId).slice(0, 32)}`,
    runtime: identity.runtime,
    scope: policies.scope,
    semanticAcceptedAt,
    source,
    textByteCount: turns.reduce(
      (sum, turn) => sum + new TextEncoder().encode(turn.text).byteLength,
      0,
    ),
    toTurn: turns.at(-1)?.turn ?? fromTurn,
    transcriptHash,
  };
  const acceptance = decodeDomain(AcceptedRunAcceptanceV1Schema)({
    _tag: "AcceptedRunAcceptanceV1",
    acceptanceId: canonicalCaptureAcceptanceId(base),
    conversationId: base.conversationId,
    eventId: base.eventId,
    finality: encodeDomain(CaptureFinalityV1Schema)(finality),
    fromTurn: base.fromTurn,
    observedFrom,
    observedThrough,
    policy: encodeDomain(CapturePolicyIdentityV1Schema)(policy),
    ...(base.previousTranscriptHash === undefined
      ? {}
      : { previousTranscriptHash: base.previousTranscriptHash }),
    privacy: encodeDomain(PrivacyPolicyAttestationV1Schema)(policies.privacy),
    projection: encodeDomain(ProjectionPolicyAttestationV1Schema)(policies.projection),
    rawAcceptedAt,
    redaction: encodeDomain(RedactionAttestationV2Schema)(redaction),
    runId: base.runId,
    runtime: encodeDomain(RuntimeIdentityV1Schema)(identity.runtime),
    schemaVersion: 1,
    scope: encodeDomain(ScopeResolutionAttestationV1Schema)(policies.scope),
    semanticAcceptedAt,
    source: encodeDomain(CaptureSourceCoordinatesV1Schema)(source),
    textByteCount: base.textByteCount,
    toTurn: base.toTurn,
    transcriptHash,
  });
  const acceptedRun = decodeDomain(AcceptedRunDeltaV1Schema)({
    _tag: "AcceptedRunDeltaV1",
    acceptedAt: semanticAcceptedAt,
    byteCount: base.textByteCount,
    conversationId: base.conversationId,
    fromTurn,
    isFinal: input.wake.close,
    maxBytes: 256_000,
    ...(base.previousTranscriptHash === undefined
      ? {}
      : { previousTranscriptHash: base.previousTranscriptHash }),
    privacy: config.privacy,
    redaction: {
      _tag: redactionCount === 0 ? "clean" : "redacted",
      policyHash: redactionPolicyHash,
      ...(redactionCount === 0 ? {} : { redactionCount }),
      scannedAt: semanticAcceptedAt,
      schemaVersion: 1,
    },
    runId: base.runId,
    runtime: input.wake.runtime,
    schemaVersion: 1,
    scope: policies.scope.scope,
    sourceRef: acceptedRunSourceRef(acceptance.acceptanceId),
    toTurn: base.toTurn,
    transcriptHash,
    turns,
  });
  const command = decodeDomain(AdmissionCommandV1Schema)({
    _tag: "accept",
    acceptance: encodeDomain(AcceptedRunAcceptanceV1Schema)(acceptance),
    invocationId: invocationId(input.wake.eventId, "accept"),
    occurredAt: semanticAcceptedAt,
    prefixBytes: input.prefixBytes,
    schemaVersion: 1,
    segmentBytes: input.segmentBytes,
  });
  return { acceptedRun, command };
};
