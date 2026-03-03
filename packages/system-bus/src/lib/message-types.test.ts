import { describe, expect, test } from "bun:test";
import { classifyMessage, isHumanMessage, isSystemMessage } from "./message-types";

describe("message-types", () => {
  test("classifies plain text as human", () => {
    const text = "Hey Joel, can you take a look at this?";

    expect(classifyMessage(text)).toBe("human");
    expect(isHumanMessage(text)).toBe(true);
    expect(isSystemMessage(text)).toBe(false);
  });

  test("classifies 🔔 header as system", () => {
    const text = "## 🔔 Gateway — 2026-03-02T11:00 PST\n\n2 event(s) received";

    expect(classifyMessage(text)).toBe("system");
    expect(isSystemMessage(text)).toBe(true);
    expect(isHumanMessage(text)).toBe(false);
  });

  test("classifies 📋 Batch Digest as system", () => {
    const text = "## 📋 Batch Digest — 2026-03-02T12:00 PST";

    expect(classifyMessage(text)).toBe("system");
  });

  test("classifies empty string as system", () => {
    const text = "   ";

    expect(classifyMessage(text)).toBe("system");
  });

  test("classifies mixed content with header as system", () => {
    const text = "Can you check this deploy? ❌ Deploy Failed on production";

    expect(classifyMessage(text)).toBe("system");
  });
});
