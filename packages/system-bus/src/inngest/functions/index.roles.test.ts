import { expect, test } from "bun:test";
import { clusterFunctionIds } from "./index.cluster";
import { hostFunctionIds } from "./index.host";
import { memoryIndexerFunctionIds } from "./index.memory-indexer";
import { findUnexpectedDuplicateIds, INTENTIONAL_DUAL_ROLE_IDS } from "./role-contract";
import { capturePrefixGrowthAlert } from "./typesense-recovery-alerts";

/**
 * Functions deliberately registered in more than one worker role.
 *
 * Cluster-only registration silently never runs on flagg — the Front incident
 * proved that the expensive way (commit 2810c4d6). Dual registration is the
 * fix for those, so the uniqueness rule has to allow it by name rather than
 * being deleted, which would stop catching the accidental duplicates it exists
 * for. Adding an id here is a deliberate act; leaving one out is the bug.
 */
test("worker role function ids are unique across host, cluster, and memory indexer", () => {
  expect(
    findUnexpectedDuplicateIds([
      ...hostFunctionIds,
      ...clusterFunctionIds,
      ...memoryIndexerFunctionIds,
    ]),
  ).toEqual([]);
});

test("memory indexer owns the blocking session and transcript indexers", () => {
  for (const id of ["memory-run-captured-v3", "meeting-transcript-index", "transcript-index-web"]) {
    expect(memoryIndexerFunctionIds).toContain(id);
    expect(hostFunctionIds).not.toContain(id);
    expect(clusterFunctionIds).not.toContain(id);
  }
});

test("memory indexer owns session-database search monitors", () => {
  for (const id of ["search/capture-prefix-growth-alert", "search/typesense-startup-budget"]) {
    expect(memoryIndexerFunctionIds).toContain(id);
    expect(hostFunctionIds).not.toContain(id);
    expect(clusterFunctionIds).not.toContain(id);
  }
});

test("capture-growth alerts have a global cap of two and a per-source cap of one", () => {
  expect(capturePrefixGrowthAlert.opts.concurrency).toEqual([
    { scope: "fn", limit: 2 },
    { limit: 1, key: "event.data.source_identity" },
  ]);
});

test("duplicate detector only suppresses intentional dual-role ids", () => {
  expect(
    findUnexpectedDuplicateIds([
      "webhook-subscription-dispatch-generic",
      "webhook-subscription-dispatch-generic",
      "accidental-duplicate",
      "accidental-duplicate",
    ]),
  ).toEqual(["accidental-duplicate"]);
});

test("every intentional dual-role id is actually registered in both roles", () => {
  // Keeps the allowlist honest: an entry that stops being dual-registered is
  // stale permission, and stale permission is how the next accident hides.
  for (const id of INTENTIONAL_DUAL_ROLE_IDS) {
    expect(hostFunctionIds).toContain(id);
    expect(clusterFunctionIds).toContain(id);
  }
});

test("retired observation producers and maintenance are not registered", () => {
  const registered = new Set([
    ...hostFunctionIds,
    ...clusterFunctionIds,
    ...memoryIndexerFunctionIds,
  ]);
  for (const retiredId of [
    "memory/observe-session",
    "observe-session-noted",
    "memory/backfill-observe",
    "memory/friction-analysis",
    "system/memory-nightly-maintenance",
    "system/memory-weekly-maintenance-summary",
    "memory/echo-fizzle",
  ]) {
    expect(registered.has(retiredId)).toBe(false);
  }
});

test("host role registers only the thin joelclaw-video client", () => {
  expect(hostFunctionIds).toContain("joelclaw-video-publish");
  expect(hostFunctionIds).not.toContain("joelclaw-video-hello");
  expect(hostFunctionIds).not.toContain("joelclaw-video-mux-webhook");
});
