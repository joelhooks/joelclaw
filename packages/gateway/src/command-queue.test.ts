import { afterEach, describe, expect, test } from "bun:test";
import {
  __commandQueueTestUtils,
  drain,
  enqueue,
  onSupersession,
  setIdleWaiter,
  setSession,
} from "./command-queue";

const { contentHash, resetState, stripInjectedChannelContext } = __commandQueueTestUtils;

const telegramHeader = `---
Channel: telegram
Date: Saturday, February 28, 2026 at 3:49 PM PST
Platform capabilities: HTML formatting, inline keyboards, slash commands, reply markup
Formatting guide:
- Use Telegram HTML tags for rich formatting
- Keep answers concise and readable
---
`;

afterEach(() => {
  resetState();
});

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

describe("command queue supersession", () => {
  test("drops older queued message from the same supersession key", async () => {
    const prompts: string[] = [];

    setSession({
      prompt: async (text: string) => {
        prompts.push(text);
      },
      reload: async () => {},
      compact: async () => {},
      newSession: async () => {},
    });
    setIdleWaiter(async () => {});

    await enqueue("telegram:1", "first", {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "telegram:1",
    });
    const second = await enqueue("telegram:1", "second", {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "telegram:1",
    });

    await drain();

    expect(prompts).toEqual(["second"]);
    expect(second.supersession?.droppedQueued).toBe(1);
    expect(second.supersession?.abortRequested).toBe(false);
  });

  test("requests abort when a newer message supersedes the active turn", async () => {
    let releaseFirstPrompt: (() => void) | undefined;
    let markFirstPromptEntered: (() => void) | undefined;
    const firstPromptEntered = new Promise<void>((resolve) => {
      markFirstPromptEntered = resolve;
    });
    const firstPromptGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const supersessionEvents: Array<{ source: string; abortRequested: boolean }> = [];

    setSession({
      prompt: async (text: string) => {
        if (text === "first") {
          markFirstPromptEntered?.();
          await firstPromptGate;
        }
      },
      reload: async () => {},
      compact: async () => {},
      newSession: async () => {},
    });
    setIdleWaiter(async () => {});
    onSupersession((event) => {
      supersessionEvents.push({ source: event.source, abortRequested: event.abortRequested });
      releaseFirstPrompt?.();
    });

    await enqueue("telegram:1", "first", {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "telegram:1",
    });
    const draining = drain();

    await firstPromptEntered;

    const second = await enqueue("telegram:1", "second", {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "telegram:1",
    });

    await draining;
    await drain();

    expect(second.supersession?.abortRequested).toBe(true);
    expect(supersessionEvents).toEqual([{ source: "telegram:1", abortRequested: true }]);
  });
});
