import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Assessment, sha256 } from "../src/domain.js";
import { ForwarderStateStore } from "../src/state-store.js";

const stores: ForwarderStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const eligible = (recordId: string, commitId: string, supersedes: readonly string[] = []): Assessment => {
  const marker = `flowing-record:${sha256(recordId)}`;
  const payload = `Status: current\nSource reference: ${marker}`;
  return {
    _tag: "Eligible",
    memory: {
      commitCreatedAt: "2026-09-09 00:00:01+00",
      commitId,
      contentHash: sha256(recordId),
      marker,
      payload,
      payloadHash: sha256(payload),
      privacy: "public",
      recordId,
      scopeProject: "example.project",
      scopeWorkstream: "main",
      supersedes,
    },
  };
};

describe("durable delivery state", () => {
  it("tracks baseline and newly seen commits by identity, not timestamp cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forwarder-state-"));
    const store = new ForwarderStateStore(path.join(root, "state.db"));
    stores.push(store);
    const initial = { commitCreatedAt: "2026-09-09 00:00:10+00", commitId: sha256("baseline") };
    const late = { commitCreatedAt: "2026-09-09 00:00:01+00", commitId: sha256("late") };
    store.initializeBaseline(initial, [initial.commitId]);
    store.ingest([eligible("record:1", late.commitId)], [late]);
    expect(store.boundary()).toEqual(initial);
    expect(store.seenCommitIds()).toEqual([initial.commitId, late.commitId].sort());
  });

  it("queues immutable correction notices after replacement authority is searchable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forwarder-state-"));
    const store = new ForwarderStateStore(path.join(root, "state.db"));
    stores.push(store);
    const boundary = { commitCreatedAt: "2026-09-09 00:00:00+00", commitId: sha256("zero") };
    const commit = { commitCreatedAt: "2026-09-09 00:00:01+00", commitId: sha256("batch") };
    store.initializeBaseline(boundary, [boundary.commitId]);
    store.ingest(
      [eligible("reflection:old", commit.commitId), eligible("reflection:new", commit.commitId, ["reflection:old"])],
      [commit],
    );
    for (const delivery of store.pendingDeliveries(10)) {
      store.markAccepted(delivery.deliveryId, `doc-${delivery.recordId}`, "queued");
      store.markDelivered(delivery.deliveryId, `memory-${delivery.recordId}`);
    }
    expect(store.queueReadySupersessionCorrections()).toBe(1);
    const correction = store.pendingDeliveries(10)[0];
    expect(correction?.deliveryId).toBe("correction:superseded:reflection:old");
    expect(correction?.payload).toContain("Reason: superseded");
    expect(correction?.payload).toContain("Corrects: flowing-record:");
    expect(correction?.payload).not.toContain(
      `Source reference: flowing-record:${sha256("reflection:old")}`,
    );
  });
});
