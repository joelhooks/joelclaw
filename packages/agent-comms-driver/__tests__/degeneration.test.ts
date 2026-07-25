import { describe, expect, test } from "bun:test";

import { detectRepeatedTokenCollapse, isRepeatedTokenCollapse } from "../src";

describe("repeated-token collapse detector", () => {
  test("trips on the court burst pattern from real transcripts", () => {
    const text = "court court court court court";
    expect(isRepeatedTokenCollapse(text)).toBe(true);
    expect(detectRepeatedTokenCollapse(text)).toMatchObject({
      degenerated: true,
      reason: "court-burst",
      token: "court",
    });
  });

  test("trips on a high repeated-token ratio window", () => {
    const text = Array.from({ length: 40 }, () => "wobble").join(" ");
    const match = detectRepeatedTokenCollapse(text);
    expect(match.degenerated).toBe(true);
    expect(match.reason).toBe("repeated-token-ratio");
    expect(match.token).toBe("wobble");
  });

  test("does not trip on normal gateway prose", () => {
    const text = [
      "Join the successor, stay held silent until the next inbound.",
      "Aggregate member event-a with holdUntil still open.",
      "Deliver a short rewrite to telegram once the window closes.",
    ].join(" ");
    expect(isRepeatedTokenCollapse(text)).toBe(false);
    expect(detectRepeatedTokenCollapse(text).degenerated).toBe(false);
  });

  test("ignores empty and tiny samples", () => {
    expect(isRepeatedTokenCollapse("")).toBe(false);
    expect(isRepeatedTokenCollapse("court court court")).toBe(false);
    expect(isRepeatedTokenCollapse("hi hi hi hi")).toBe(false);
  });

  test("still trips when court spam is buried after normal prose", () => {
    const text = `normal held-incident aggregation prose ${"court ".repeat(12)}`;
    expect(isRepeatedTokenCollapse(text)).toBe(true);
  });
});
