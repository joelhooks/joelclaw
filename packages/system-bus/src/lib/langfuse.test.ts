import { describe, expect, test } from "bun:test";
import { parsePiJsonAssistant } from "./langfuse";

describe("parsePiJsonAssistant", () => {
  test("retains usage/model/provider when assistant text is empty", () => {
    const raw = [
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "anthropic/claude-haiku-4-5",
          usage: {
            input: 42,
            output: 0,
            totalTokens: 42,
            cacheRead: 10,
            cacheWrite: 2,
            cost: { input: 0.0001, output: 0, total: 0.0001 },
          },
          content: [{ type: "tool_use", text: "" }],
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonAssistant(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.text).toBe("");
    expect(parsed?.provider).toBe("anthropic");
    expect(parsed?.model).toBe("anthropic/claude-haiku-4-5");
    expect(parsed?.usage).toMatchObject({
      inputTokens: 42,
      outputTokens: 0,
      totalTokens: 42,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      costTotal: 0.0001,
    });
  });

  test("extracts assistant text content when present", () => {
    const raw = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "openai/o4-mini",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: " world" },
        ],
      },
    });

    const parsed = parsePiJsonAssistant(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.text).toBe("hello world");
    expect(parsed?.provider).toBe("openai");
    expect(parsed?.model).toBe("openai/o4-mini");
  });
});
