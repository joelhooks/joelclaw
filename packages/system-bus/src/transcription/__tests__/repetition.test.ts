import { describe, expect, test } from "bun:test";
import {
  collapseConsecutiveSegments,
  detectPathologicalRepetition,
  screenWithCollapse,
} from "../repetition";

function seg(text: string): { text: string } {
  return { text };
}

function loop(text: string, count: number): Array<{ text: string }> {
  return Array.from({ length: count }, () => seg(text));
}

describe("collapseConsecutiveSegments", () => {
  test("collapses a run to its first occurrence", () => {
    const segments = [seg("hello"), ...loop("I'm not sure.", 14), seg("moving on")];
    const result = collapseConsecutiveSegments(segments);
    expect(result.segments.map((s) => s.text)).toEqual([
      "hello",
      "I'm not sure.",
      "moving on",
    ]);
    expect(result.removed).toBe(13);
  });

  test("alternating segments are untouched", () => {
    const segments = [seg("a"), seg("b"), seg("a"), seg("b")];
    expect(collapseConsecutiveSegments(segments).removed).toBe(0);
  });

  test("normalized equality: punctuation/case variants still collapse", () => {
    const segments = [seg(" Yeah."), seg("yeah"), seg("YEAH!")];
    expect(collapseConsecutiveSegments(segments).segments).toHaveLength(1);
  });

  test("empty-text segments break runs and are kept", () => {
    const segments = [seg("a"), seg(""), seg("a")];
    const result = collapseConsecutiveSegments(segments);
    expect(result.segments).toHaveLength(3);
  });
});

describe("screenWithCollapse", () => {
  test("a deterministic short loop inside real content passes after collapse", () => {
    const segments = [
      ...["so the thumbnail", "draws the eye", "toward the title", "which is why",
          "contrast matters", "and the face", "should be visible", "in the corner",
          "of the frame", "every single time", "you publish", "a new video"].map(seg),
      ...loop("I'm not sure.", 14),
    ];
    // Without collapse this trips the consecutive-repeat rule…
    expect(detectPathologicalRepetition(segments).repetitive).toBe(true);
    // …with collapse the loop folds into one segment and the chunk passes.
    const verdict = screenWithCollapse(segments);
    expect(verdict.repetitive).toBe(false);
    expect(verdict.removed).toBe(13);
    expect(verdict.segments.filter((s) => s.text === "I'm not sure.")).toHaveLength(1);
  });

  test("a decode that is mostly loop padding still fails (maxCollapsedFraction)", () => {
    const segments = [seg("real intro"), ...loop("thank you", 40)];
    const verdict = screenWithCollapse(segments);
    expect(verdict.repetitive).toBe(true);
    expect(verdict.reason).toContain("consecutive-duplicate padding");
  });

  test("tiny inputs are not judged by the fraction rule", () => {
    const segments = [seg("yeah"), seg("yeah"), seg("right")];
    expect(screenWithCollapse(segments).repetitive).toBe(false);
  });

  test("non-consecutive dominance still fails post-collapse (topPhraseShare)", () => {
    const filler = ["one", "two", "three", "four", "five", "six"].map(seg);
    const segments: Array<{ text: string }> = [];
    for (let i = 0; i < 12; i += 1) {
      segments.push(seg("the quick brown fox jumps over everything"), filler[i % 6] as { text: string });
    }
    const verdict = screenWithCollapse(segments);
    expect(verdict.repetitive).toBe(true);
  });
});
