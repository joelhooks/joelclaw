import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Assessment, sha256 } from "../src/domain.js";
import type { FoundReceipt, SaveReceipt, SupermemoryPort } from "../src/executor-client.js";
import { runDelivery } from "../src/machine.js";
import { ForwarderStateStore } from "../src/state-store.js";

const stores: ForwarderStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const makeStore = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supermemory-forwarder-"));
  const store = new ForwarderStateStore(path.join(root, "state.db"));
  stores.push(store);
  const boundary = { commitCreatedAt: "2026-09-09 00:00:00+00", commitId: sha256("zero") };
  store.initializeBaseline(boundary, [boundary.commitId]);
  const payload = `Status: current\nSource reference: flowing-record:${sha256("record:1")}`;
  const assessment: Assessment = {
    _tag: "Eligible",
    memory: {
      commitCreatedAt: "2026-09-09 00:00:01+00",
      commitId: sha256("one"),
      contentHash: sha256("content"),
      marker: `flowing-record:${sha256("record:1")}`,
      payload,
      payloadHash: sha256(payload),
      privacy: "public",
      recordId: "record:1",
      scopeProject: "example.project",
      scopeWorkstream: "main",
      supersedes: [],
    },
  };
  store.ingest([assessment], [
    { commitCreatedAt: "2026-09-09 00:00:01+00", commitId: sha256("one") },
  ]);
  return store;
};

class FakeRemote implements SupermemoryPort {
  findResult: FoundReceipt | null = null;
  findError = false;
  saveError = false;
  saves = 0;

  async find(): Promise<FoundReceipt | null> {
    if (this.findError) throw new Error("offline");
    return this.findResult;
  }
  async save(): Promise<SaveReceipt> {
    this.saves += 1;
    if (this.saveError) throw new Error("timeout");
    return { documentId: "doc-1", status: "queued" };
  }
  async verifySpace(): Promise<void> {}
}

const run = (store: ForwarderStateStore, remote: FakeRemote) => {
  const delivery = store.pendingDeliveries(3)[0];
  if (!delivery) throw new Error("missing delivery");
  return runDelivery({ delivery, maxReconcileAttempts: 3, remote, store });
};

describe("delivery lifecycle", () => {
  it("keeps queued saves accepted until the exact source marker is searchable", async () => {
    const store = await makeStore();
    const remote = new FakeRemote();
    expect(await run(store, remote)).toBe("accepted");
    expect(store.counts()).toEqual({ accepted: 1 });
    expect(remote.saves).toBe(1);

    expect(await run(store, remote)).toBe("accepted");
    expect(store.counts()).toEqual({ accepted: 1 });
    expect(remote.saves).toBe(1);

    remote.findResult = { memoryId: "memory-1" };
    expect(await run(store, remote)).toBe("delivered");
    expect(store.counts()).toEqual({ delivered: 1 });
    expect(remote.saves).toBe(1);
  });

  it("never blindly retries an indeterminate send", async () => {
    const store = await makeStore();
    const remote = new FakeRemote();
    remote.saveError = true;
    expect(await run(store, remote)).toBe("indeterminate");
    expect(remote.saves).toBe(1);

    remote.saveError = false;
    expect(await run(store, remote)).toBe("indeterminate");
    expect(remote.saves).toBe(1);
  });

  it("recovers an indeterminate send when reconciliation finds the marker", async () => {
    const store = await makeStore();
    const remote = new FakeRemote();
    remote.saveError = true;
    await run(store, remote);

    remote.findResult = { memoryId: "memory-recovered" };
    expect(await run(store, remote)).toBe("delivered");
    expect(store.counts()).toEqual({ delivered: 1 });
  });

  it("withholds after bounded pre-send reconciliation failures", async () => {
    const store = await makeStore();
    const remote = new FakeRemote();
    remote.findError = true;
    expect(await run(store, remote)).toBe("deferred");
    expect(await run(store, remote)).toBe("deferred");
    expect(await run(store, remote)).toBe("withheld");
    expect(remote.saves).toBe(0);
    expect(store.counts()).toEqual({ withheld: 1 });
  });

  it("uses a durable compare-and-set so concurrent runners cannot both send", async () => {
    const store = await makeStore();
    const remote = new FakeRemote();
    const stalePending = store.pendingDeliveries(3)[0];
    if (!stalePending) throw new Error("missing delivery");
    expect(store.markSending(stalePending.deliveryId)).toBe(true);
    expect(
      await runDelivery({ delivery: stalePending, maxReconcileAttempts: 3, remote, store }),
    ).toBe("deferred");
    expect(remote.saves).toBe(0);
  });
});
