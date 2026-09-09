import { describe, expect, it } from "vitest";

import { assessRecord, type ForwarderPolicy, type SourceRecord, sha256 } from "../src/domain.js";

const policy: ForwarderPolicy = {
  allowedPrivacy: ["public", "private"],
  allowedScopes: [{ project: "example.project", workstream: "main" }],
  containerTag: "private_space_key",
  destinationVisibility: "private",
  executorUrl: "http://127.0.0.1:4789/mcp",
  maxPayloadBytes: 4_000,
  maxReconcileAttempts: 20,
  pollIntervalMs: 30_000,
  supermemoryConnection: "supermemory_mcp.org.privateConnection",
  schemaVersion: 1,
};

const hash = (value: string) => sha256(value);
const scope = { _tag: "ProjectWorkstream", project: "example.project", workstream: "main" } as const;
const evidence = { _tag: "AcceptedRun", evidenceId: "evidence:1", privacy: "public", scope } as const;
const claim = { claimId: "claim:1", evidenceIds: ["evidence:1"], text: "Use one stable boundary." } as const;

const observation = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  body: {
    createdAt: "2026-09-09T00:00:00Z",
    decisions: [claim],
    evidence: [evidence],
    gist: claim,
    observationId: "observation:1",
    observations: [],
    openQuestions: [],
    privacy: "public",
    schemaVersion: 2,
    scope,
    type: "observation",
  },
  commitCreatedAt: "2026-09-09 00:00:01+00",
  commitId: hash("commit"),
  contentHash: hash("content"),
  kind: "observation",
  ordinal: 1,
  privacy: "public",
  recordId: "observation:1",
  schemaVersion: 2,
  scopeProject: scope.project,
  scopeWorkstream: scope.workstream,
  ...overrides,
});

describe("export eligibility", () => {
  it("builds a bounded source-marked payload from public semantic claims", () => {
    const result = assessRecord(observation(), policy);
    expect(result._tag).toBe("Eligible");
    if (result._tag === "Eligible") {
      expect(result.memory.payload).toContain("Use one stable boundary.");
      expect(result.memory.payload).toContain(`flowing-record:${hash("observation:1")}`);
      expect(result.memory.payload).not.toContain("evidence:1");
    }
  });

  it("exports private source material only as private-classified derived memory", () => {
    const base = observation();
    const body = base.body as Record<string, unknown>;
    const result = assessRecord(
      observation({
        privacy: "private",
        body: {
          ...body,
          privacy: "private",
          evidence: [{ ...evidence, privacy: "private" }],
        },
      }),
      policy,
    );
    expect(result._tag).toBe("Eligible");
    if (result._tag === "Eligible") {
      expect(result.memory.privacy).toBe("private");
      expect(result.memory.payload).toContain("Source privacy: private");
    }
  });

  it("rejects sensitive rows without reclassification", () => {
    const result = assessRecord(observation({ privacy: "sensitive" }), policy);
    expect(result._tag === "Excluded" && result.reason).toBe("privacy-not-allowed");
  });

  it("rejects sensitive or cross-scope evidence", () => {
    const body = observation().body as Record<string, unknown>;
    for (const rejectedEvidence of [
      { ...evidence, privacy: "sensitive" },
      {
        ...evidence,
        scope: { ...scope, workstream: "other" },
      },
    ]) {
      const result = assessRecord(
        observation({ body: { ...body, evidence: [rejectedEvidence] } }),
        policy,
      );
      expect(result._tag === "Excluded" && result.reason).toBe("evidence-not-exportable");
    }
  });

  it("blocks obvious outbound secrets, email addresses, paths, and topology", () => {
    for (const text of [
      "Email person@example.com",
      "Read /home/user/private.txt",
      "token=abc123456789",
      "Host 10.0.0.7",
    ]) {
      const body = observation().body as Record<string, unknown>;
      const result = assessRecord(
        observation({ body: { ...body, gist: { ...claim, text }, decisions: [] } }),
        policy,
      );
      expect(result._tag === "Excluded" && result.reason).toBe("content-export-guard");
    }
  });

  it("excludes ReflectionV2/reviewed-card authority from v1", () => {
    const result = assessRecord(observation({ kind: "reflection", schemaVersion: 2 }), policy);
    expect(result._tag === "Excluded" && result.reason).toBe("schema-not-supported");
  });
});
