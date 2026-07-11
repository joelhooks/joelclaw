import { describe, expect, test } from "bun:test";
import { parseAsrJson } from "../asr-json";

describe("parseAsrJson", () => {
  test("parses whisper output with bare NaN value tokens", () => {
    const raw = `{"segments":[{"text":"hi","avg_logprob": NaN,"no_speech_prob":0.1},{"text":"there","avg_logprob":NaN}],"language":"en"}`;
    const parsed = parseAsrJson(raw) as {
      segments: Array<{ text: string; avg_logprob: null }>;
    };
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.avg_logprob).toBeNull();
    expect(parsed.segments[1]?.avg_logprob).toBeNull();
  });

  test("handles Infinity, -Infinity, adjacent tokens, and array positions", () => {
    const raw = `{"a": Infinity,"b": -Infinity,"c":[NaN, NaN, 1]}`;
    expect(parseAsrJson(raw)).toEqual({ a: null, b: null, c: [null, null, 1] });
  });

  test("never rewrites NaN inside string values", () => {
    const raw = `{"text":"the word NaN, spoken aloud","x": NaN}`;
    expect(parseAsrJson(raw)).toEqual({
      text: "the word NaN, spoken aloud",
      x: null,
    });
  });

  test("still throws on genuinely corrupt JSON", () => {
    expect(() => parseAsrJson("{truncated")).toThrow();
  });
});
