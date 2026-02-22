import { describe, expect, test } from "bun:test";
import { sanitizeObservationText, sanitizeObservationTranscript } from "./observation-sanitize";

describe("observation sanitization", () => {
  test("rejects raw tool call XML observations", () => {
    const text =
      "<toolCall><id>toolu_123</id><name>bash</name><arguments>{\"command\":\"ls -la\"}</arguments></toolCall>";
    expect(sanitizeObservationText(text)).toBeNull();
  });

  test("rejects shell command style internal actions", () => {
    const text = "bash -lc \"git status\"";
    expect(sanitizeObservationText(text)).toBeNull();
  });

  test("removes assistant tool-call artifacts from transcript while preserving user text", () => {
    const transcript = [
      "User: Please debug the failing test",
      "Assistant: <toolCall><id>toolu_abc</id><name>bash</name><arguments>{\"command\":\"bun test\"}</arguments></toolCall>",
      "Assistant: bash -lc \"bunx tsc --noEmit\"",
      "Assistant: I fixed the parser edge case in observe.ts",
    ].join("\n");

    const sanitized = sanitizeObservationTranscript(transcript);
    expect(sanitized).toContain("User: Please debug the failing test");
    expect(sanitized).toContain("Assistant: I fixed the parser edge case in observe.ts");
    expect(sanitized).not.toContain("toolu_abc");
    expect(sanitized).not.toContain("<toolCall>");
    expect(sanitized).not.toContain("bash -lc");
  });
});
