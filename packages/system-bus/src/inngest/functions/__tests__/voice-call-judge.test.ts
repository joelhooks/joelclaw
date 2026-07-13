import { describe, expect, test } from "bun:test";
import {
  buildJudgePrompt,
  DIMENSION_KEYS,
  parseJudgeOutput,
} from "../voice-call-judge";

const transcript = "**ShitRat**: Hello there.\n\n**Caller**: Thanks.";

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dimensions: DIMENSION_KEYS.map((key) => ({
      key,
      score: 5,
      justification: "Grounded in the supplied call.",
      quote: "Hello there.",
    })),
    taxonomyTags: [],
    hardFails: {
      privacy_boundary_breach: false,
      missing_public_disclosure: false,
      invented_receipt: false,
      unsafe_action: false,
    },
    hardFailEvidence: {
      privacy_boundary_breach: "",
      missing_public_disclosure: "",
      invented_receipt: "",
      unsafe_action: "",
    },
    observed: { toolHandling: false, repair: false, publicCharacterPresent: true },
    confidence: 0.9,
    notes: "Clean evidence.",
    escalation: { recommended: false, reason: "" },
    ...overrides,
  });
}

describe("voice call judge normalization", () => {
  test("excludes N/O dimensions and labels a short good call clean-so-far", () => {
    const raw = JSON.parse(output()) as any;
    raw.dimensions.find((item: any) => item.key === "tool_silence").score = null;
    raw.dimensions.find((item: any) => item.key === "tool_silence").quote = "";
    raw.dimensions.find((item: any) => item.key === "repair").score = null;
    raw.dimensions.find((item: any) => item.key === "repair").quote = "";

    const result = parseJudgeOutput(JSON.stringify(raw), {
      tier: "public",
      transcript,
      silentToolTimingReceipt: false,
    });

    expect(result.mean).toBe(5);
    expect(result.label).toBe("clean-so-far");
  });

  test("forces public wit to N/O for private calls and strips unproved silence tags", () => {
    const result = parseJudgeOutput(output({ taxonomyTags: ["silent-tool-chain"] }), {
      tier: "private",
      transcript,
      silentToolTimingReceipt: false,
    });

    expect(result.dimensions.find((item) => item.key === "public_piss_taking")?.score).toBeNull();
    expect(result.taxonomyTags).toEqual([]);
    expect(result.warnings).toContain("silent-tool-chain removed: no timing receipt supplied");
  });

  test("hard failures override a high mean", () => {
    const result = parseJudgeOutput(output({
      hardFails: {
        privacy_boundary_breach: true,
        missing_public_disclosure: false,
        invented_receipt: false,
        unsafe_action: false,
      },
      hardFailEvidence: {
        privacy_boundary_breach: "Hello there.",
        missing_public_disclosure: "",
        invented_receipt: "",
        unsafe_action: "",
      },
    }), {
      tier: "public",
      transcript,
      silentToolTimingReceipt: false,
    });

    expect(result.mean).toBe(5);
    expect(result.label).toBe("hard-fail");
  });

  test("rejects hard failures without an exact transcript receipt", () => {
    expect(() => parseJudgeOutput(output({
      hardFails: {
        privacy_boundary_breach: true,
        missing_public_disclosure: false,
        invented_receipt: false,
        unsafe_action: false,
      },
    }), {
      tier: "public",
      transcript,
      silentToolTimingReceipt: false,
    })).toThrow("requires an exact transcript receipt");
  });

  test("rejects scored quotes that are not in the transcript", () => {
    const raw = JSON.parse(output()) as any;
    raw.dimensions[0].quote = "Made up quote";

    expect(() => parseJudgeOutput(JSON.stringify(raw), {
      tier: "public",
      transcript,
      silentToolTimingReceipt: false,
    })).toThrow("not present verbatim");
  });

  test("prompt carries the rubric verbatim, transcript, timing rows, and output contract", () => {
    const rubric = "SIGNED RUBRIC EXACT TEXT";
    const prompt = buildJudgePrompt(rubric, {
      room: "room-1",
      tier: "public",
      transcript,
      transcriptMessages: 2,
      durationS: 12,
      silentToolTimingReceipt: false,
      turnRows: [{ idx: 0, ts: 1, llmTtftMs: 900 }],
    });

    expect(prompt).toContain(rubric);
    expect(prompt).toContain(transcript);
    expect(prompt).toContain('"llmTtftMs": 900');
    expect(prompt).toContain("public_piss_taking");
  });
});
