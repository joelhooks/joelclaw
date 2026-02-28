import { describe, expect, test } from "bun:test";
import { __commandQueueTestUtils } from "./command-queue";

const { contentHash, stripInjectedChannelContext } = __commandQueueTestUtils;

const telegramHeader = `---
Channel: telegram
Date: Saturday, February 28, 2026 at 3:49 PM PST
Platform capabilities: HTML formatting, inline keyboards, slash commands, reply markup
Formatting guide:
- Use Telegram HTML tags for rich formatting
- Keep answers concise and readable
---
`;

describe("command queue dedup hashing", () => {
  test("strips injected channel context and preserves message body", () => {
    const prompt = `${telegramHeader}\nhey mate`; 
    expect(stripInjectedChannelContext(prompt)).toBe("hey mate");
  });

  test("keeps prompt when no injected channel context exists", () => {
    expect(stripInjectedChannelContext("plain message")).toBe("plain message");
  });

  test("hash differs for different bodies even when channel preamble is identical", () => {
    const a = `${telegramHeader}\nfirst message body`;
    const b = `${telegramHeader}\nsecond message body`;

    expect(contentHash("telegram:7718912466", a)).not.toBe(contentHash("telegram:7718912466", b));
  });

  test("hash remains stable across channel preamble timestamp changes", () => {
    const a = `${telegramHeader}\nwhat happened?`;
    const b = `${telegramHeader.replace("3:49 PM PST", "3:50 PM PST")}\nwhat happened?`;

    expect(contentHash("telegram:7718912466", a)).toBe(contentHash("telegram:7718912466", b));
  });
});
