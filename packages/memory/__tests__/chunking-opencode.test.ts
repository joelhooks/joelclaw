import { describe, expect, test } from "bun:test";
import { detectFormat, extractTurns, parseJsonl } from "../src/chunking";

describe("OpenCode native Run snapshots", () => {
  test("indexes visible user, assistant, and tool content while preserving the raw source field", () => {
    const jsonl = [
      JSON.stringify({ type: "opencode_session", session_id: "fixture" }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-25T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "fixture question" }] },
        opencode_raw: { message_json: "original-user-json", parts: [] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-25T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "fixture answer" },
            { type: "tool_use", name: "read_file", input: { path: "fixture.ts" } },
            { type: "tool_result", content: "fixture tool output" },
          ],
        },
        opencode_raw: { message_json: "original-assistant-json", parts: ["original-part-json"] },
      }),
    ].join("\n");
    const entries = parseJsonl(`${jsonl}\n`);
    expect(detectFormat(entries)).toBe("claude-code");
    expect(entries[1]?.opencode_raw).toMatchObject({ message_json: "original-user-json" });
    expect(extractTurns(entries).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "fixture question" },
      {
        role: "tool",
        text: 'fixture answer\n[tool_use:read_file] {"path":"fixture.ts"}\n[tool_result] fixture tool output',
      },
    ]);
  });
});
