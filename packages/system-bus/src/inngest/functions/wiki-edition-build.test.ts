import { describe, expect, test } from "bun:test";
import { __wikiEditionBuildTestUtils } from "./wiki-edition-build";

const { blockedSourceRuns, buildNotification, parseEditionBuild } = __wikiEditionBuildTestUtils;

describe("wiki edition build", () => {
  test("parses edition state and blocked source runs", () => {
    const result = parseEditionBuild(JSON.stringify({
      state: {
        editionId: "2026-07-15",
        written: 4,
        loopCount: 3,
        observationCount: 12,
        sourceRuns: [{ status: "complete" }, { status: "blocked", id: "run-2" }],
      },
    }));

    expect(result.editionId).toBe("2026-07-15");
    expect(blockedSourceRuns(result.sourceRuns)).toEqual([{ status: "blocked", id: "run-2" }]);
  });

  test("rejects invalid JSON instead of reporting a successful build", () => {
    expect(() => parseEditionBuild("not json")).toThrow();
  });

  test("builds a bounded failure receipt", () => {
    expect(buildNotification({
      buildEdition: { ok: false, phase: "build-edition", error: "boom" },
      blockedCount: 0,
    })).toBe("wiki edition build receipt\nfailed: build-edition\nblocked source runs: 0");
  });
});
