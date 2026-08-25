import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AcceptedRunDeltaV1Schema,
  AdmissionCommandV1Schema,
  acceptedRunDeltaV1MatchesAcceptance,
  decodeDomain,
  RuntimeKindSchema,
} from "@joelclaw-memory/domain";
import { describe, expect, it } from "vitest";

import type { TrustedAdmissionConfigV1 } from "../src/admission-builder.js";
import {
  buildOpenCodeCandidate,
  type OpenCodeAcceptedTailV1,
  type OpenCodeAdmissionAuthority,
  reconcileOpenCodeSnapshot,
} from "../src/opencode-producer.js";
import {
  OPENCODE_ENCODER_VERSION,
  OPENCODE_SOURCE_SCHEMA_VERSION,
  type OpenCodeSourceSnapshotV1,
  type OpenCodeSourceStreamV1,
  SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
} from "../src/opencode-source.js";
import { makeTrustedAdmissionWriter } from "../src/trusted-admission.js";

const encoder = new TextEncoder();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const record = (input: {
  readonly messageId: string;
  readonly occurredAt: number;
  readonly partId: string;
  readonly role: "assistant" | "user";
  readonly sessionRef: string;
  readonly text: string;
}) =>
  `${JSON.stringify({
    schemaVersion: 1,
    sessionRef: input.sessionRef,
    messageId: input.messageId,
    role: input.role,
    occurredAt: input.occurredAt,
    parts: [{ partId: input.partId, text: input.text }],
  })}\n`;

const stream = (input: {
  readonly createdAt?: number;
  readonly id?: string;
  readonly parent?: string;
  readonly records: readonly string[];
}): OpenCodeSourceStreamV1 => {
  const id = input.id ?? "session-hash-a";
  const canonicalBytes = encoder.encode(input.records.join(""));
  const hash = sha256(canonicalBytes);
  return {
    byteCount: canonicalBytes.byteLength,
    canonicalBytes,
    eligibleMessageCount: input.records.length,
    finality: "open",
    ...(input.parent === undefined ? {} : { parentSessionIdentityHash: input.parent }),
    prefixHash: hash,
    segmentHash: hash,
    sessionIdentityHash: sha256(`session:${id}`),
    sourceCreatedAt: input.createdAt ?? 1_700_000_000_000,
    sourceDirectory: "/private/path/DO_NOT_LEAK_DIRECTORY",
    streamIdentityHash: sha256(`stream:${id}`),
  };
};

const snapshot = (streams: readonly OpenCodeSourceStreamV1[]): OpenCodeSourceSnapshotV1 => ({
  adapterInstanceIdentityHash: "a".repeat(64),
  databaseUserVersion: 0,
  encoderVersion: OPENCODE_ENCODER_VERSION,
  inventory: {
    childSessionCount: streams.filter((item) => item.parentSessionIdentityHash !== undefined)
      .length,
    eligibleMessageCount: streams.reduce((sum, item) => sum + item.eligibleMessageCount, 0),
    messageCount: streams.reduce((sum, item) => sum + item.eligibleMessageCount, 0),
    partCount: streams.reduce((sum, item) => sum + item.eligibleMessageCount, 0),
    rootSessionCount: streams.filter((item) => item.parentSessionIdentityHash === undefined).length,
    sessionCount: streams.length,
    sessionMessageCount: 0,
    streamCount: streams.length,
  },
  schemaFingerprint: SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
  schemaVersion: OPENCODE_SOURCE_SCHEMA_VERSION,
  streams,
});

const config = (privacy: "private" | "sensitive" = "private"): TrustedAdmissionConfigV1 => ({
  adapterInstanceIdHash: "a".repeat(64),
  canonicalRepository: "github.com/joelclaw/fleet",
  principalIdHash: "b".repeat(64),
  privacy,
  project: "joelclaw-fleet",
  projection: privacy === "sensitive" ? "disabled" : "enabled",
  repositoryHost: "github.com",
  repositoryName: "fleet",
  repositoryOwner: "joelclaw",
  scopeFallbackReason: "no-repository",
  scopeResolution: "fleetFallback",
  workstream: "default",
});

class FakeAuthority implements OpenCodeAdmissionAuthority {
  readonly tails = new Map<string, OpenCodeAcceptedTailV1>();
  readonly commands: unknown[] = [];
  preflightResult = { migrationCompatible: true, runtimeCompatible: true, writable: true };
  throwAfterCommitOnce = false;

  readonly preflight = async () => this.preflightResult;

  readonly readTail = async (sourceStreamId: string) => this.tails.get(sourceStreamId);

  readonly admit = async (raw: unknown) => {
    const command = decodeDomain(AdmissionCommandV1Schema)(raw);
    this.commands.push(raw);
    if (command._tag !== "accept") throw new Error("unexpected-command");
    const acceptance = command.acceptance;
    this.tails.set(acceptance.source.sourceStreamId, {
      factId: acceptance.acceptanceId,
      privacy: acceptance.privacy.tier,
      project: acceptance.scope.scope.project,
      sourcePrefixHash: acceptance.source.sourcePrefixHash,
      sourceStreamId: acceptance.source.sourceStreamId,
      toByteExclusive: acceptance.source.toByteExclusive,
      toTurn: acceptance.toTurn,
      transcriptHash: acceptance.transcriptHash,
      workstream: acceptance.scope.scope.workstream,
    });
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false;
      throw new Error("synthetic-acknowledgement-loss");
    }
    return {
      captureEventId: acceptance.eventId,
      commandFingerprint: "c".repeat(64),
      disposition: "admitted",
      invocationId: "d".repeat(64),
      schemaVersion: 1,
      sourceStreamId: acceptance.source.sourceStreamId,
      windowSeq: this.commands.length,
    } as never;
  };
}

const firstRecord = record({
  messageId: "raw-message-private-marker-1",
  occurredAt: 1_700_000_000_001,
  partId: "raw-part-private-marker-1",
  role: "user",
  sessionRef: "raw-session-private-marker",
  text: "first visible turn",
});
const secondRecord = record({
  messageId: "raw-message-private-marker-2",
  occurredAt: 1_700_000_000_002,
  partId: "raw-part-private-marker-2",
  role: "assistant",
  sessionRef: "raw-session-private-marker",
  text: "second visible turn",
});

const harness = async (streams: readonly OpenCodeSourceStreamV1[]) => {
  const evidenceDirectory = await mkdtemp(path.join(tmpdir(), "opencode-producer-evidence-"));
  const authority = new FakeAuthority();
  const writer = makeTrustedAdmissionWriter({ evidenceDirectory, ledger: authority });
  return {
    authority,
    dependencies: {
      authority,
      resolveConfig: async () => config(),
      writer,
    },
    evidenceDirectory,
    snapshot: snapshot(streams),
  };
};

describe("OpenCode accepted producer", () => {
  it("constructs deterministic open OpenCode candidates through the six-runtime contract", () => {
    const source = stream({ records: [firstRecord] });
    const first = buildOpenCodeCandidate({ config: config(), stream: source });
    const second = buildOpenCodeCandidate({ config: config(), stream: source });
    expect(first).toEqual(second);
    expect(first?.built.acceptedRun).toMatchObject({
      isFinal: false,
      runtime: "opencode",
      scope: { project: "joelclaw-fleet", workstream: "default" },
    });
    expect(
      ["pi", "claude", "codex", "cursor", "grok", "opencode"].map((runtime) =>
        decodeDomain(RuntimeKindSchema)(runtime),
      ),
    ).toEqual(["pi", "claude", "codex", "cursor", "grok", "opencode"]);
  });

  it("appends an exact suffix, resumes the open stream, then emits no fact on replay", async () => {
    const first = stream({ records: [firstRecord] });
    const run = await harness([first]);
    const initial = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { apply: true, confirmed: true, maxSessions: 1 },
      run.dependencies,
    );
    expect(initial.counts.settled).toBe(1);

    const resumed = stream({ records: [firstRecord, secondRecord] });
    const resumedReceipt = await reconcileOpenCodeSnapshot(
      snapshot([resumed]),
      { apply: true, confirmed: true, maxSessions: 1 },
      run.dependencies,
    );
    expect(resumedReceipt.streams[0]).toMatchObject({
      _tag: "settled",
      fromByte: first.byteCount,
      toByteExclusive: resumed.byteCount,
    });
    expect(run.authority.commands).toHaveLength(2);

    const replay = await reconcileOpenCodeSnapshot(
      snapshot([resumed]),
      { apply: true, confirmed: true, maxSessions: 1 },
      run.dependencies,
    );
    expect(replay.counts.noChange).toBe(1);
    expect(run.authority.commands).toHaveLength(2);
  });

  it("blocks a changed accepted prefix without stopping a later safe session", async () => {
    const changed = stream({ id: "changed", records: [firstRecord] });
    const safe = stream({
      createdAt: changed.sourceCreatedAt + 1,
      id: "safe",
      records: [secondRecord],
    });
    const run = await harness([changed, safe]);
    const candidate = buildOpenCodeCandidate({ config: config(), stream: changed });
    if (candidate === undefined) throw new Error("expected candidate");
    run.authority.tails.set(candidate.sourceStreamId, {
      factId: "e".repeat(64),
      privacy: "private",
      project: "joelclaw-fleet",
      sourcePrefixHash: "f".repeat(64),
      sourceStreamId: candidate.sourceStreamId,
      toByteExclusive: changed.byteCount,
      toTurn: 0,
      transcriptHash: "1".repeat(64),
      workstream: "default",
    });
    const receipt = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { maxSessions: 2 },
      run.dependencies,
    );
    expect(receipt.streams.map((item) => item._tag)).toEqual(["blocked", "candidate"]);
    expect(receipt.streams[0]).toMatchObject({ code: "source-prefix-mismatch" });
  });

  it("processes backfill sessions oldest first", async () => {
    const newer = stream({ createdAt: 200, id: "newer", records: [secondRecord] });
    const older = stream({ createdAt: 100, id: "older", records: [firstRecord] });
    const run = await harness([newer, older]);
    const receipt = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { maxSessions: 2 },
      run.dependencies,
    );
    expect(receipt.streams.map((item) => item.sessionIdentityHash)).toEqual([
      older.sessionIdentityHash,
      newer.sessionIdentityHash,
    ]);
  });

  it("keeps fallback scope private and redacts secrets before accepted evidence", () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");
    const source = stream({
      records: [
        record({
          messageId: "message-secret",
          occurredAt: 1_700_000_000_010,
          partId: "part-secret",
          role: "user",
          sessionRef: "session-secret",
          text: `do not keep ${token}`,
        }),
      ],
    });
    const candidate = buildOpenCodeCandidate({ config: config(), stream: source });
    const accepted = candidate?.built.acceptedRun;
    expect(accepted?.privacy).toBe("private");
    expect(accepted?.scope).toEqual({
      _tag: "ProjectWorkstream",
      project: "joelclaw-fleet",
      workstream: "default",
    });
    expect(accepted?.redaction).toMatchObject({ _tag: "redacted", redactionCount: 1 });
    expect(accepted?.turns[0]?.text).toContain("[REDACTED]");
    expect(accepted?.turns[0]?.text).not.toContain(token);
  });

  it("raises privacy to the accepted tail and never lowers it", () => {
    const source = stream({ records: [firstRecord, secondRecord] });
    const first = stream({ records: [firstRecord] });
    const prior = buildOpenCodeCandidate({ config: config("sensitive"), stream: first });
    if (prior?.built.command._tag !== "exclude") throw new Error("expected prior exclusion");
    const tail: OpenCodeAcceptedTailV1 = {
      factId: prior.built.command.receipt.exclusionId,
      privacy: "sensitive",
      project: "joelclaw-fleet",
      sourcePrefixHash: first.prefixHash,
      sourceStreamId: prior.sourceStreamId,
      toByteExclusive: first.byteCount,
      workstream: "default",
    };
    const resumed = buildOpenCodeCandidate({ config: config("private"), stream: source, tail });
    expect(resumed?.built.acceptedRun).toBeUndefined();
    if (resumed?.built.command._tag !== "exclude") throw new Error("expected exclusion");
    expect(resumed.built.command.receipt.privacy.tier).toBe("sensitive");
    expect(resumed.built.command.receipt.projection.decision).toBe("disabled");
  });

  it("isolates a malformed session but globally stops on an unsafe preflight", async () => {
    const malformed = stream({ records: ['{"schemaVersion":1}\n'] });
    const safe = stream({
      createdAt: malformed.sourceCreatedAt + 1,
      id: "safe-two",
      records: [firstRecord],
    });
    const run = await harness([malformed, safe]);
    const receipt = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { maxSessions: 2 },
      run.dependencies,
    );
    expect(receipt.streams.map((item) => item._tag)).toEqual(["failed", "candidate"]);

    run.authority.preflightResult = {
      migrationCompatible: false,
      runtimeCompatible: true,
      writable: true,
    };
    await expect(
      reconcileOpenCodeSnapshot(run.snapshot, { maxSessions: 2 }, run.dependencies),
    ).rejects.toMatchObject({ code: "migration-incompatible" });
  });

  it("pre-reads every authority tail before apply so an unsafe failure writes nothing", async () => {
    const first = stream({ createdAt: 100, id: "tail-first", records: [firstRecord] });
    const second = stream({ createdAt: 200, id: "tail-second", records: [secondRecord] });
    const run = await harness([first, second]);
    let tailReads = 0;
    let writes = 0;
    await expect(
      reconcileOpenCodeSnapshot(
        run.snapshot,
        { apply: true, confirmed: true, maxSessions: 2 },
        {
          ...run.dependencies,
          authority: {
            ...run.authority,
            readTail: async () => {
              tailReads += 1;
              if (tailReads === 2) throw new Error("unsafe-authority-failure");
              return undefined;
            },
          },
          writer: {
            admitBuilt: async () => {
              writes += 1;
              throw new Error("unexpected-write");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "authority-tail-unavailable" });
    expect(writes).toBe(0);
  });

  it("replays safely after acknowledgement loss and keeps body and fact hash-bound", async () => {
    const source = stream({ records: [firstRecord] });
    const run = await harness([source]);
    run.authority.throwAfterCommitOnce = true;
    const lost = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { apply: true, confirmed: true, maxSessions: 1 },
      run.dependencies,
    );
    expect(lost.counts.failed).toBe(1);
    const retried = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { apply: true, confirmed: true, maxSessions: 1 },
      run.dependencies,
    );
    expect(retried.counts.noChange).toBe(1);

    const encodedCommand = run.authority.commands[0];
    const command = decodeDomain(AdmissionCommandV1Schema)(encodedCommand);
    if (command._tag !== "accept") throw new Error("expected accept");
    const files = await readdir(run.evidenceDirectory);
    expect(files).toHaveLength(1);
    const body = JSON.parse(
      await readFile(path.join(run.evidenceDirectory, files[0] ?? "missing"), "utf8"),
    ) as unknown;
    const accepted = decodeDomain(AcceptedRunDeltaV1Schema)(body);
    expect(acceptedRunDeltaV1MatchesAcceptance(command.acceptance, accepted)).toBe(true);
  });

  it("keeps dry-run mutation-free and requires an explicit apply confirmation", async () => {
    const source = stream({ records: [firstRecord] });
    const run = await harness([source]);
    let writes = 0;
    const receipt = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { maxSessions: 1 },
      {
        ...run.dependencies,
        writer: {
          admitBuilt: async () => {
            writes += 1;
            throw new Error("dry-run-wrote");
          },
        },
      },
    );
    expect(receipt.counts.candidates).toBe(1);
    expect(writes).toBe(0);
    await expect(
      reconcileOpenCodeSnapshot(run.snapshot, { apply: true, maxSessions: 1 }, run.dependencies),
    ).rejects.toMatchObject({ code: "apply-confirmation-required" });
    await expect(
      reconcileOpenCodeSnapshot(run.snapshot, { maxSessions: 1_001 }, run.dependencies),
    ).rejects.toMatchObject({ code: "invalid-max-sessions" });
  });

  it("emits metadata-only receipts and preserves only the hashed parent edge", async () => {
    const parent = sha256("parent-private-marker");
    const source = stream({ parent, records: [firstRecord] });
    const run = await harness([source]);
    const receipt = await reconcileOpenCodeSnapshot(
      run.snapshot,
      { maxSessions: 1 },
      run.dependencies,
    );
    const output = JSON.stringify(receipt);
    expect(output).toContain(parent);
    expect(output).not.toMatch(
      /raw-session-private-marker|raw-message-private-marker|raw-part-private-marker|DO_NOT_LEAK_DIRECTORY|joelclaw-fleet|first visible turn|postgres(?:ql)?:\/\//u,
    );
  });
});
