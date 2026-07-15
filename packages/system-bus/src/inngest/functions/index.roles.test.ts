import { expect, test } from "bun:test";
import { clusterFunctionIds } from "./index.cluster";
import { hostFunctionIds } from "./index.host";

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
  expect(repeated).toEqual([]);
});

test("host role registers only the thin joelclaw-video client", () => {
  expect(hostFunctionIds).toContain("joelclaw-video-publish");
  expect(hostFunctionIds).not.toContain("joelclaw-video-hello");
  expect(hostFunctionIds).not.toContain("joelclaw-video-mux-webhook");
});
