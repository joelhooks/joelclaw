import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcceptedRunDeltaV1Schema, decodeDomain } from "@joelclaw-memory/domain";
import { describe, expect, it } from "vitest";

import {
  buildTrustedAdmissionV1,
  type TrustedAdmissionConfigV1,
} from "../src/admission-builder.js";
import {
  type ImmutableEvidenceStage,
  makeTrustedAdmissionWriter,
  persistImmutableEvidence,
} from "../src/trusted-admission.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const encoder = new TextEncoder();

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

const built = () => {
  const canonical = `${JSON.stringify({
    schemaVersion: 1,
    sessionRef: "session",
    messageId: "message",
    role: "user",
    occurredAt: 1_700_000_000_000,
    parts: [{ partId: "part", text: "durable evidence" }],
  })}\n`;
  const bytes = encoder.encode(canonical);
  return buildTrustedAdmissionV1(
    {
      fromByte: 0,
      prefixBytes: bytes,
      segmentBytes: bytes,
      toByteExclusive: bytes.byteLength,
      wake: {
        close: false,
        eventId: sha256("evidence-event"),
        eventName: "opencode.reconcile",
        incarnationId: "opencode:test",
        occurredAt: new Date(1_700_000_000_000).toISOString(),
        runtime: "opencode",
        schemaVersion: 1,
        sessionId: sha256("session"),
      },
    },
    config,
  );
};

const result = {
  captureEventId: sha256("capture"),
  commandFingerprint: "c".repeat(64),
  disposition: "admitted",
  invocationId: "d".repeat(64),
  schemaVersion: 1,
  sourceStreamId: "e".repeat(64),
  windowSeq: 1,
} as never;

describe("immutable accepted evidence persistence", () => {
  it("installs complete 0600 bodies atomically and accepts concurrent identical retries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-atomic-"));
    const target = path.join(directory, "run.accepted-run-v1.json");
    const bytes = encoder.encode('{"complete":true}\n');
    await Promise.all([
      persistImmutableEvidence(target, bytes),
      persistImmutableEvidence(target, bytes),
      persistImmutableEvidence(target, bytes),
    ]);
    expect(await readFile(target)).toEqual(Buffer.from(bytes));
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("blocks an immutable identity conflict without replacing the first body", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-conflict-"));
    const target = path.join(directory, "run.accepted-run-v1.json");
    const first = encoder.encode('{"version":1}\n');
    await persistImmutableEvidence(target, first);
    await expect(
      persistImmutableEvidence(target, encoder.encode('{"version":2}\n')),
    ).rejects.toThrow("immutable-evidence-identity-conflict");
    expect(await readFile(target)).toEqual(Buffer.from(first));
  });

  it.each(["preinstall", "postinstall", "prefact"] as const)(
    "survives a %s throw without a partial body or fact without body",
    async (stage: ImmutableEvidenceStage) => {
      const directory = await mkdtemp(path.join(tmpdir(), `evidence-${stage}-`));
      const admission = built();
      if (admission.acceptedRun === undefined) throw new Error("expected accepted body");
      const target = path.join(directory, `${admission.acceptedRun.runId}.accepted-run-v1.json`);
      let ledgerWrites = 0;
      const writer = makeTrustedAdmissionWriter({
        evidenceDirectory: directory,
        evidenceHooks: {
          onStage: (current) => {
            if (current === stage) throw new Error(`synthetic-${stage}`);
          },
        },
        ledger: {
          admit: async () => {
            ledgerWrites += 1;
            return result;
          },
        },
      });

      await expect(writer.admitBuilt(admission)).rejects.toThrow(`synthetic-${stage}`);
      expect(ledgerWrites).toBe(0);
      const files = await readdir(directory);
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      if (stage === "preinstall") {
        await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const body = decodeDomain(AcceptedRunDeltaV1Schema)(
          JSON.parse(await readFile(target, "utf8")) as unknown,
        );
        expect(body.runId).toBe(admission.acceptedRun.runId);
      }

      const retry = makeTrustedAdmissionWriter({
        evidenceDirectory: directory,
        ledger: {
          admit: async () => {
            const body = decodeDomain(AcceptedRunDeltaV1Schema)(
              JSON.parse(await readFile(target, "utf8")) as unknown,
            );
            expect(body.runId).toBe(admission.acceptedRun?.runId);
            ledgerWrites += 1;
            return result;
          },
        },
      });
      await expect(retry.admitBuilt(admission)).resolves.toMatchObject({
        disposition: "admitted",
      });
      expect(ledgerWrites).toBe(1);
    },
  );
});
