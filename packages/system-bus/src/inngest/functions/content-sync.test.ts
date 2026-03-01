import { describe, expect, test } from "bun:test";
import {
  adrExtraResourceIdsFromGaps,
  type ContentGapResult,
  isCanonicalAdrFilename,
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

describe("ADR filename guard", () => {
  test("allows canonical ADR filenames", () => {
    expect(isCanonicalAdrFilename("0182-node-0-fleet-contract-and-localhost-resilience.md")).toBe(true);
  });

  test("rejects review notes and non-canonical files", () => {
    expect(isCanonicalAdrFilename("review-0182-pdf-brain-codex.md")).toBe(false);
    expect(isCanonicalAdrFilename("REVIEW-2026-02-25.md")).toBe(false);
    expect(isCanonicalAdrFilename("README.md")).toBe(false);
  });
});

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
