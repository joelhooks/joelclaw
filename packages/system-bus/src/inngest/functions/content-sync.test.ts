import { describe, expect, test } from "bun:test";
import {
  adrExtraResourceIdsFromGaps,
  type ContentGapResult,
  contentSync,
  contentSyncSchedule,
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

describe("content sync scheduling", () => {
  const config = (fn: unknown) => (fn as {
    getConfig: (input: { baseUrl: URL; appPrefix: string }) => Array<{
      triggers?: Array<{ cron?: string; event?: string }>;
      debounce?: { period: string; timeout?: string; key?: string };
    }>;
  }).getConfig({
    baseUrl: new URL("http://localhost:3111/api/inngest"),
    appPrefix: "system-bus-host",
  })[0];

  test("keeps cron scheduling outside the debounced function", () => {
    const schedule = config(contentSyncSchedule);
    const sync = config(contentSync);

    expect(schedule?.triggers).toEqual([{ cron: "0 * * * *" }]);
    expect(schedule?.debounce).toBeUndefined();
    expect(sync?.triggers).not.toContainEqual({ cron: "0 * * * *" });
    expect(sync?.debounce).toEqual({
      period: "45s",
      timeout: "3m",
      key: '"vault-sync"',
    });
  });
});

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
