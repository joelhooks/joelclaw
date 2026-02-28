import { describe, expect, test } from "bun:test";
import {
  adrExtraResourceIdsFromGaps,
  type ContentGapResult,
  isContentVerifyHealthy,
} from "./content-sync";

function gap(overrides: Partial<ContentGapResult>): ContentGapResult {
  return {
    name: "adrs",
    vaultCount: 0,
    convexCount: 0,
    missingInConvex: [],
    extraInConvex: [],
    ...overrides,
  };
}

describe("content verify health logic", () => {
  test("is healthy when no gaps exist", () => {
    expect(
      isContentVerifyHealthy([
        gap({ name: "adrs" }),
        gap({ name: "posts" }),
      ]),
    ).toBe(true);
  });

  test("treats ADR extras in Convex as unhealthy", () => {
    expect(
      isContentVerifyHealthy([
        gap({ name: "adrs", extraInConvex: ["0168-convex-canonical-content-lifecycle"] }),
      ]),
    ).toBe(false);
  });
});

describe("content prune targeting", () => {
  test("maps ADR extras to resource ids", () => {
    expect(
      adrExtraResourceIdsFromGaps([
        gap({ name: "adrs", extraInConvex: ["0168-convex-canonical-content-lifecycle", "0169-capability-adapters"] }),
      ]),
    ).toEqual([
      "adr:0168-convex-canonical-content-lifecycle",
      "adr:0169-capability-adapters",
    ]);
  });
});
