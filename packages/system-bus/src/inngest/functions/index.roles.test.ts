import { expect, test } from "bun:test";
import { clusterFunctionIds } from "./index.cluster";
import { hostFunctionIds } from "./index.host";

/**
 * Functions deliberately registered in BOTH worker roles.
 *
 * Cluster-only registration silently never runs on flagg — the Front incident
 * proved that the expensive way (commit 2810c4d6). Dual registration is the
 * fix for those, so the uniqueness rule has to allow it by name rather than
 * being deleted, which would stop catching the accidental duplicates it exists
 * for. Adding an id here is a deliberate act; leaving one out is the bug.
 */
const INTENTIONAL_DUAL_ROLE_IDS = new Set<string>([
  "webhook-subscription-dispatch-generic",
]);

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

test("worker role function ids are unique across host and cluster", () => {
  const repeated = duplicates([...hostFunctionIds, ...clusterFunctionIds]);
  const unexpected = repeated.filter((id) => !INTENTIONAL_DUAL_ROLE_IDS.has(id));
  expect(unexpected).toEqual([]);
});

test("every intentional dual-role id is actually registered in both roles", () => {
  // Keeps the allowlist honest: an entry that stops being dual-registered is
  // stale permission, and stale permission is how the next accident hides.
  for (const id of INTENTIONAL_DUAL_ROLE_IDS) {
    expect(hostFunctionIds).toContain(id);
    expect(clusterFunctionIds).toContain(id);
  }
});

test("host role registers only the thin joelclaw-video client", () => {
  expect(hostFunctionIds).toContain("joelclaw-video-publish");
  expect(hostFunctionIds).not.toContain("joelclaw-video-hello");
  expect(hostFunctionIds).not.toContain("joelclaw-video-mux-webhook");
});
