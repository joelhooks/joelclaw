import { describe, expect, test } from "bun:test";
import type { OtelEvent } from "./otel-event";

const sampleEvent: OtelEvent = {
  id: "evt-triage-parse",
  timestamp: Date.now(),
  sessionId: "test-session",
  systemId: "panda",
  level: "error",
  source: "worker",
  component: "o11y-test",
  action: "classifier.parse",
  success: false,
  error: "bad output",
  metadata: {},
};

describe("o11y triage classifier parsing", () => {
  test("accepts plain JSON array", async () => {
    const { __triageTestUtils } = await import("./triage");
    const parsed = __triageTestUtils.parseClassificationArray(
      JSON.stringify([{ tier: 2, reasoning: "plain json", proposed_pattern: null }]),
      1,
    );

    expect(parsed).toBeTruthy();
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.debug.parseSource).toBe("raw");
  });

  test("accepts fenced JSON array", async () => {
    const { __triageTestUtils } = await import("./triage");
    const parsed = __triageTestUtils.parseClassificationArray(
      '```json\n[{"tier":1,"reasoning":"fenced","proposed_pattern":null}]\n```',
      1,
    );

    expect(parsed).toBeTruthy();
    expect(parsed?.items).toHaveLength(1);
  });

  test("extracts prose plus JSON array", async () => {
    const { __triageTestUtils } = await import("./triage");
    const parsed = __triageTestUtils.parseClassificationArray(
      'Here is the classification:\n[{"tier":3,"reasoning":"pipeline stalled","proposed_pattern":null}]\nDone.',
      1,
    );

    expect(parsed).toBeTruthy();
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.debug.parseSource).toBe("balanced_array");
  });

  test("rejects invalid output and falls back through normalization", async () => {
    const { __triageTestUtils } = await import("./triage");
    const parsed = __triageTestUtils.parseClassificationArray("not json at all", 1);

    expect(parsed).toBeNull();

    const normalized = __triageTestUtils.normalizeLLMClassification(sampleEvent, null);
    expect(normalized.tier).toBe(2);
    expect(normalized.reasoning).toContain("defaulting to tier 2");
    expect(normalized.proposed_pattern).toBeNull();
  });

  test("rejects wrong item count instead of silently truncating", async () => {
    const { __triageTestUtils } = await import("./triage");
    const parsed = __triageTestUtils.parseClassificationArray(
      JSON.stringify([{ tier: 2, reasoning: "only one", proposed_pattern: null }]),
      2,
    );

    expect(parsed).toBeNull();
  });
});
