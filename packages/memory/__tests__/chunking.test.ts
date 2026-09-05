import { describe, expect, it } from "vitest";
import {
  chunkTurns,
  detectFormat,
  extractTurns,
  parseJsonl,
  type RawJsonlEntry,
} from "../src/chunking";

describe("detectFormat", () => {
  it("detects claude-code by permission-mode entry", () => {
    const entries: RawJsonlEntry[] = [
      { type: "permission-mode" },
      { type: "user", message: { role: "user", content: "hi" } },
    ];
    expect(detectFormat(entries)).toBe("claude-code");
  });

  it("detects pi by session entry", () => {
    const entries: RawJsonlEntry[] = [
      { type: "session", version: 3 } as RawJsonlEntry,
      { type: "message", message: { role: "user", content: "hi" } },
    ];
    expect(detectFormat(entries)).toBe("pi");
  });

  it("detects pi when only message entries are present", () => {
    const entries: RawJsonlEntry[] = [
      { type: "message", message: { role: "user", content: "hi" } },
    ];
    expect(detectFormat(entries)).toBe("pi");
  });

  it("detects Codex response items", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      },
    ];
    expect(detectFormat(entries)).toBe("codex");
  });

  it("detects Grok top-level content events", () => {
    const entries: RawJsonlEntry[] = [
      { type: "system", content: "system" },
      { type: "user", content: "hi" },
    ];
    expect(detectFormat(entries)).toBe("grok");
  });
});

describe("extractTurns — claude-code", () => {
  it("treats a user-type entry carrying a tool_result as role=tool, not role=user", () => {
    // This is the bug the spike retrieval revealed: claude-code wraps
    // tool_results inside `type:user` entries; the chunker must detect
    // the content shape rather than trust the top-level type field.
    const entries: RawJsonlEntry[] = [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "stdout from the tool call",
            },
          ],
        },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "claude-code");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("tool");
  });

  it("preserves user role for genuine user prompts", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "user",
        message: { role: "user", content: "what broke the cluster" },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "claude-code");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("user");
  });

  it("promotes assistant to role=tool when the turn contains tool_use", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "claude-code");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("tool");
  });

  it("skips meta entries (permission-mode, file-history-snapshot, system, attachment)", () => {
    const entries: RawJsonlEntry[] = [
      { type: "permission-mode" },
      { type: "file-history-snapshot" },
      { type: "system", content: "note" } as RawJsonlEntry,
      { type: "attachment" },
      {
        type: "user",
        message: { role: "user", content: "real message" },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "claude-code");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("real message");
  });
});

describe("extractTurns — codex", () => {
  it("extracts user, assistant, and tool response items", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-04-19T12:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "do the thing" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-04-19T12:00:01.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok doing it" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-04-19T12:00:02.000Z",
        payload: {
          type: "function_call_output",
          output: "stdout",
        },
      },
    ];
    const turns = extractTurns(entries, "codex");
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool"]);
    expect(turns[2]!.text).toContain("stdout");
  });

  it("suppresses nearby dual representations but preserves a later repeated message", () => {
    const canonical: RawJsonlEntry = {
      type: "response_item",
      payload: { type: "message", role: "user", content: "same text" },
    };
    const nearby: RawJsonlEntry = {
      type: "event_msg",
      payload: { type: "user_message", message: "same text" },
    };
    const spacer = (index: number): RawJsonlEntry => ({
      type: "response_item",
      payload: { type: "function_call_output", output: `tool-${index}` },
    });
    const later: RawJsonlEntry = {
      type: "event_msg",
      payload: { type: "user_message", message: "same text" },
    };
    const turns = extractTurns(
      [canonical, nearby, spacer(1), spacer(2), spacer(3), spacer(4), later],
      "codex",
    );
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.text)).toEqual([
      "same text",
      "same text",
    ]);
  });
});

describe("extractTurns — grok", () => {
  it("maps top-level chat events to user/assistant/tool", () => {
    const entries: RawJsonlEntry[] = [
      { type: "user", content: "do the thing" },
      { type: "assistant", content: "ok doing it" },
      { type: "tool_result", content: "stdout" },
    ];
    const turns = extractTurns(entries, "grok");
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("extractTurns — pi", () => {
  it("maps pi message roles to user/assistant/tool correctly", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "message",
        message: { role: "user", content: "do the thing" },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
      {
        type: "message",
        message: { role: "assistant", content: "ok doing it" },
        timestamp: "2026-04-19T12:00:01.000Z",
      } as RawJsonlEntry,
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "stdout" }],
        },
        timestamp: "2026-04-19T12:00:02.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "pi");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("includes thinking content with a [thinking] marker", () => {
    const entries: RawJsonlEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal reasoning" }],
        },
        timestamp: "2026-04-19T12:00:00.000Z",
      } as RawJsonlEntry,
    ];
    const turns = extractTurns(entries, "pi");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain("[thinking]");
    expect(turns[0]!.text).toContain("internal reasoning");
  });
});

describe("chunkTurns", () => {
  it("preserves one chunk per turn for small inputs", () => {
    const chunks = chunkTurns([
      {
        role: "user",
        text: "small",
        started_at: 1,
        token_estimate: 2,
      },
      {
        role: "assistant",
        text: "also small",
        started_at: 2,
        token_estimate: 3,
      },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunk_idx).toBe(0);
    expect(chunks[1]!.chunk_idx).toBe(1);
  });

  it("splits oversized turns into sub-chunks with overlap", () => {
    // 40K chars ≈ 10K tokens — well over the 8K MAX_CHUNK_TOKENS ceiling
    const bigText = "x".repeat(40_000);
    const chunks = chunkTurns([
      {
        role: "assistant",
        text: bigText,
        started_at: 1,
        token_estimate: 10_000,
      },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    // Chunk indices are globally sequential, including after a split turn.
    expect(chunks[0]!.chunk_idx).toBe(0);
    expect(chunks[1]!.chunk_idx).toBe(1);
  });

  it("keeps indices unique when a split turn is followed by another turn", () => {
    const chunks = chunkTurns([
      {
        role: "assistant",
        text: "x".repeat(40_000),
        started_at: 1,
        token_estimate: 10_000,
      },
      {
        role: "user",
        text: "follow-up",
        started_at: 2,
        token_estimate: 3,
      },
    ]);
    expect(new Set(chunks.map((chunk) => chunk.chunk_idx)).size).toBe(chunks.length);
    expect(chunks.at(-1)!.chunk_idx).toBe(chunks.length - 1);
  });
});

describe("parseJsonl", () => {
  it("tolerates empty lines and malformed JSON", () => {
    const content = `{"type":"session"}\n\nnot valid json\n{"type":"message","message":{"role":"user","content":"ok"}}\n`;
    const entries = parseJsonl(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe("session");
    expect(entries[1]!.type).toBe("message");
  });
});
