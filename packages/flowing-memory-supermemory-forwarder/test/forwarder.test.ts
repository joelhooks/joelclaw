import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assessRecord, type ForwarderPolicy, type SourceRecord, sha256 } from "../src/domain.js";
import type { FoundReceipt, SaveReceipt, SupermemoryPort } from "../src/executor-client.js";
import { SupermemoryForwarder } from "../src/forwarder.js";
import type {
  EligibilityCounts,
  FlowingMemorySource,
  SourceBaseline,
  SourceBatch,
} from "../src/source.js";
import { ForwarderStateStore } from "../src/state-store.js";

const policy: ForwarderPolicy = {
  allowedPrivacy: ["public", "private"],
  allowedScopes: [{ project: "example.project", workstream: "main" }],
  containerTag: "private_space_key",
  destinationVisibility: "private",
  executorUrl: "http://127.0.0.1:4789/mcp",
  maxPayloadBytes: 4_000,
  maxReconcileAttempts: 3,
  pollIntervalMs: 30_000,
  schemaVersion: 1,
  supermemoryConnection: "supermemory_mcp.org.privateConnection",
};

const boundary = (name: string, createdAt: string) => ({
  commitCreatedAt: createdAt,
  commitId: sha256(name),
});

const sourceRecord = (name: string, commit: ReturnType<typeof boundary>): SourceRecord => ({
  body: {
    createdAt: "2026-09-09T00:00:00Z",
    decisions: [
      { claimId: `claim:${name}`, evidenceIds: [`evidence:${name}`], text: `Public fact ${name}` },
    ],
    evidence: [
      {
        _tag: "AcceptedRun",
        evidenceId: `evidence:${name}`,
        privacy: "public",
        scope: {
          _tag: "ProjectWorkstream",
          project: "example.project",
          workstream: "main",
        },
      },
    ],
    gist: { claimId: `claim:${name}`, evidenceIds: [`evidence:${name}`], text: `Public fact ${name}` },
    observationId: `observation:${name}`,
    observations: [],
    openQuestions: [],
    privacy: "public",
    schemaVersion: 2,
    scope: {
      _tag: "ProjectWorkstream",
      project: "example.project",
      workstream: "main",
    },
    type: "observation",
  },
  commitCreatedAt: commit.commitCreatedAt,
  commitId: commit.commitId,
  contentHash: sha256(`content:${name}`),
  kind: "observation",
  ordinal: 1,
  privacy: "public",
  recordId: `observation:${name}`,
  schemaVersion: 2,
  scopeProject: "example.project",
  scopeWorkstream: "main",
});

class FakeSource implements FlowingMemorySource {
  readonly baseline: SourceBaseline;
  commits: ReturnType<typeof boundary>[] = [];
  records: SourceRecord[] = [];
  active = new Set<string>();
  listCalls = 0;

  constructor() {
    const first = boundary("baseline", "2026-09-09 00:00:10+00");
    this.baseline = { boundary: first, commitIds: [first.commitId] };
  }
  async initialBaseline(): Promise<SourceBaseline> {
    return this.baseline;
  }
  async listUnseenCommits(seen: readonly string[], limit: number): Promise<SourceBatch> {
    this.listCalls += 1;
    const selected = this.commits.filter((item) => !seen.includes(item.commitId)).slice(0, limit);
    const selectedIds = new Set(selected.map((item) => item.commitId));
    return {
      commits: selected,
      candidates: this.records.filter((record) => selectedIds.has(record.commitId)),
    };
  }
  async activeCommittedRecords(ids: readonly string[]): Promise<readonly SourceRecord[]> {
    return this.records.filter((record) => ids.includes(record.recordId) && this.active.has(record.recordId));
  }
  async eligibilityCounts(): Promise<EligibilityCounts> {
    return {
      allowedScope: 0,
      currentTotal: 0,
      exportEligibleUpperBound: 0,
      exportableEvidence: 0,
      privateRows: 0,
      projectionLinked: 0,
      publicRows: 0,
      schemaSupported: 0,
      sensitiveRows: 0,
      strictEligible: 0,
      strictExcluded: 0,
    };
  }
  async close(): Promise<void> {}
}

class FakeRemote implements SupermemoryPort {
  findError = false;
  saves = 0;
  async find(): Promise<FoundReceipt | null> {
    if (this.findError) throw new Error("offline");
    return null;
  }
  async save(): Promise<SaveReceipt> {
    this.saves += 1;
    return { documentId: `doc-${this.saves}`, status: "queued" };
  }
  async verifySpace(): Promise<void> {}
}

const stores: ForwarderStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forwarder-integration-"));
  const state = new ForwarderStateStore(path.join(root, "state.db"));
  stores.push(state);
  const source = new FakeSource();
  const remote = new FakeRemote();
  const forwarder = new SupermemoryForwarder({ policy, remote, source, state });
  await forwarder.initializeBoundary();
  return { forwarder, remote, source, state };
};

describe("forwarder authority and discovery", () => {
  it("withholds a record already inactive when its commit is discovered", async () => {
    const { forwarder, remote, source, state } = await fixture();
    const commit = boundary("inactive", "2026-09-09 00:00:11+00");
    source.commits.push(commit);
    source.records.push(sourceRecord("inactive", commit));
    const receipt = await forwarder.runPass();
    expect(receipt.outcomes.withheld).toBe(1);
    expect(remote.saves).toBe(0);
    expect(state.counts()).toEqual({ withheld: 1 });
  });

  it("revalidates a pending first save after withdrawal before retry", async () => {
    const { forwarder, remote, source, state } = await fixture();
    const commit = boundary("withdrawn", "2026-09-09 00:00:11+00");
    const record = sourceRecord("withdrawn", commit);
    source.commits.push(commit);
    source.records.push(record);
    source.active.add(record.recordId);
    remote.findError = true;
    await forwarder.runPass();
    expect(state.counts()).toEqual({ pending: 1 });

    source.active.delete(record.recordId);
    remote.findError = false;
    const receipt = await forwarder.runPass();
    expect(receipt.outcomes.withheld).toBe(1);
    expect(remote.saves).toBe(0);
    expect(state.counts()).toEqual({ withheld: 1 });
  });

  it("revalidates current export policy before a pending first save", async () => {
    const { forwarder, remote, source, state } = await fixture();
    const commit = boundary("policy-change", "2026-09-09 00:00:11+00");
    const record = sourceRecord("policy-change", commit);
    source.commits.push(commit);
    source.records.push(record);
    source.active.add(record.recordId);
    remote.findError = true;
    await forwarder.runPass();

    remote.findError = false;
    const narrowed = new SupermemoryForwarder({
      policy: {
        ...policy,
        allowedScopes: [{ project: "example.project", workstream: "other" }],
      },
      remote,
      source,
      state,
    });
    const receipt = await narrowed.runPass();
    expect(receipt.outcomes.withheld).toBe(1);
    expect(remote.saves).toBe(0);
  });

  it("does not apply current-authority cancellation to corrective deliveries", async () => {
    const { forwarder, remote, source, state } = await fixture();
    const commit = boundary("withdrawn-correction", "2026-09-09 00:00:11+00");
    const record = sourceRecord("withdrawn-correction", commit);
    source.records.push(record);
    const assessment = assessRecord(record, policy);
    state.ingest([assessment], [commit]);
    state.markDelivered(`save:${record.recordId}`, "memory-original");

    const receipt = await forwarder.runPass();
    expect(receipt.outcomes.accepted).toBe(1);
    expect(remote.saves).toBe(1);
    expect(state.counts()).toEqual({ accepted: 1, delivered: 1 });
  });

  it("runs an exact queued canary without discovering commit siblings", async () => {
    const { forwarder, remote, source, state } = await fixture();
    const commit = boundary("canary-with-sibling", "2026-09-09 00:00:11+00");
    const canary = sourceRecord("canary", commit);
    const sibling = sourceRecord("sibling", commit);
    source.commits.push(commit);
    source.records.push(canary, sibling);
    source.active.add(canary.recordId);
    source.active.add(sibling.recordId);
    const assessment = assessRecord(canary, policy);
    state.ingest([assessment], [commit]);

    expect(await forwarder.runCanary(canary.recordId)).toBe("accepted");
    expect(remote.saves).toBe(1);
    expect(state.counts()).toEqual({ accepted: 1 });
    expect(state.delivery(`save:${sibling.recordId}`)).toBeNull();
  });

  it("discovers a late-visible commit even when its created_at precedes the baseline", async () => {
    const { forwarder, source, state } = await fixture();
    const late = boundary("late-visible", "2026-09-09 00:00:01+00");
    source.commits.push(late);
    await forwarder.runPass();
    expect(state.seenCommitIds()).toContain(late.commitId);
  });

  it("drains more than 50 no-change commits and records every commit ID", async () => {
    const { forwarder, source, state } = await fixture();
    source.commits.push(
      ...Array.from({ length: 52 }, (_, index) =>
        boundary(`no-change-${index}`, `2026-09-09 00:01:${String(index).padStart(2, "0")}+00`),
      ),
    );
    const receipt = await forwarder.runPass();
    expect(receipt).toMatchObject({ commitsSeen: 52, discovered: 0 });
    expect(source.listCalls).toBe(2);
    expect(state.seenCommitIds()).toHaveLength(53);
  });
});
