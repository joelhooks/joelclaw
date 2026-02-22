import { describe, test, expect } from "bun:test";
import { parseClaudeOutput } from "./utils";

describe("parseClaudeOutput", () => {
  test("parses --output-format json envelope with fenced result", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: '```json\n{"verdict":"pass","reasoning":"looks good"}\n```',
    });
    const result = parseClaudeOutput(envelope) as any;
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toBe("looks good");
  });

  test("parses --output-format json envelope with raw JSON result", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: '{"verdict":"fail","reasoning":"bad"}',
    });
    const result = parseClaudeOutput(envelope) as any;
    expect(result.verdict).toBe("fail");
  });

  test("parses direct JSON string (no envelope)", () => {
    const result = parseClaudeOutput('{"verdict":"pass","reasoning":"ok"}') as any;
    expect(result.verdict).toBe("pass");
  });

  test("parses markdown-fenced JSON from text output", () => {
    const text = 'Here is my answer:\n```json\n{"questions":[{"id":"q2","answer":true}]}\n```\n';
    const result = parseClaudeOutput(text) as any;
    expect(result.questions[0].id).toBe("q2");
  });

  test("extracts JSON object embedded in prose", () => {
    const text = 'My evaluation:\n{"verdict":"pass","reasoning":"all good"}\nDone.';
    const result = parseClaudeOutput(text) as any;
    expect(result.verdict).toBe("pass");
  });

  test("returns null for empty input", () => {
    expect(parseClaudeOutput("")).toBeNull();
    expect(parseClaudeOutput("  ")).toBeNull();
  });

  test("returns null for non-JSON text", () => {
    expect(parseClaudeOutput("just some text with no json")).toBeNull();
  });

  test("handles real claude --output-format json shape", () => {
    // Actual shape from claude CLI
    const real = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1860,
      result: '```json\n{"verdict":"pass","reasoning":"All 7 acceptance criteria are satisfied"}\n```',
      session_id: "abc-123",
      total_cost_usd: 0.044,
    });
    const result = parseClaudeOutput(real) as any;
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toContain("acceptance criteria");
  });
});
