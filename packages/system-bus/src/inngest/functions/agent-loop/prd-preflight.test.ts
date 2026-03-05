import { describe, expect, test } from "bun:test";
import { normalizePrdOrThrow } from "./utils";

describe("normalizePrdOrThrow", () => {
  test("normalizes legacy acceptance to acceptance_criteria", () => {
    const input = {
      title: "Legacy PRD",
      stories: [
        {
          id: "S1",
          title: "Story",
          description: "Do it",
          acceptance: ["works"],
        },
      ],
    };

    const { prd, fixes } = normalizePrdOrThrow(input, "prd.json");
    expect(prd.stories[0]?.acceptance_criteria).toEqual(["works"]);
    expect(prd.stories[0]?.passes).toBe(false);
    expect(prd.stories[0]?.priority).toBe(1);
    expect(fixes.some((f) => f.includes("acceptance -> acceptance_criteria"))).toBe(true);
  });

  test("normalizes camelCase acceptanceCriteria alias", () => {
    const input = {
      title: "Camel PRD",
      stories: [
        {
          id: "S1",
          title: "Story",
          description: "Do it",
          acceptanceCriteria: ["works"],
          priority: 3,
          passes: true,
        },
      ],
    };

    const { prd } = normalizePrdOrThrow(input, "prd.json");
    expect(prd.stories[0]?.acceptance_criteria).toEqual(["works"]);
    expect(prd.stories[0]?.priority).toBe(3);
    expect(prd.stories[0]?.passes).toBe(true);
  });

  test("throws when criteria are missing", () => {
    const input = {
      title: "Bad PRD",
      stories: [
        {
          id: "S1",
          title: "Story",
          description: "Do it",
        },
      ],
    };

    expect(() => normalizePrdOrThrow(input, "prd.json")).toThrow(
      "missing acceptance_criteria"
    );
  });
});
