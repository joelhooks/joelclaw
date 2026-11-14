import { describe, expect, test } from "bun:test";
import { detectFormat, extractTurns, parseJsonl } from "../src/chunking";

describe("Grok native Run snapshots", () => {
  test("detects top-level content and indexes user, assistant, reasoning, and tool events", () => {
    const jsonl = [
      { type: "system", content: "system metadata" },
      { type: "user", content: "fixture question", timestamp: "2026-08-25T00:00:00.000Z" },
      { type: "assistant", content: { text: "fixture answer" } },
      { type: "reasoning", content: { summary: "fixture reasoning" } },
      { type: "backend_tool_call", content: { name: "read", input: { path: "fixture.ts" } } },
      { type: "tool_result", content: "fixture tool output" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const entries = parseJsonl(`${jsonl}\n`);

    expect(detectFormat(entries)).toBe("grok");
    expect(extractTurns(entries).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "fixture question" },
      { role: "assistant", text: "fixture answer" },
      { role: "assistant", text: "fixture reasoning" },
      { role: "tool", text: '{"name":"read","input":{"path":"fixture.ts"}}' },
      { role: "tool", text: "fixture tool output" },
    ]);
  });
});
