import { expect, test } from "bun:test";
import { hostFunctionIds } from "./index.host";
import { clusterFunctionIds } from "./index.cluster";

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

test("host role keeps the active function registry during transition", () => {
  expect(hostFunctionIds.length).toBeGreaterThan(0);
});
