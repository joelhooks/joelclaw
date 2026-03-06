import { afterEach, describe, expect, test } from "bun:test";
import {
  __commandQueueTestUtils,
  drain,
  enqueue,
  getActiveRequestMetadata,
  getSupersessionState,
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

  test("batches rapid follow-ups from the same human source before dispatch", async () => {
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

    await enqueue("discord:1", `${telegramHeader}\nfirst`, {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "discord:1",
      gatewayBatchKey: "discord:1",
      gatewayBatchWindowMs: 25,
    });
    const second = await enqueue("discord:1", `${telegramHeader.replace("3:49 PM PST", "3:50 PM PST")}\nsecond`, {
      gatewayHumanLatestWins: true,
      gatewaySupersessionKey: "discord:1",
      gatewayBatchKey: "discord:1",
      gatewayBatchWindowMs: 25,
    });

    expect(getSupersessionState().batching.pendingCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("first");
    expect(prompts[0]).toContain("--- Follow-up ---\nsecond");
    expect(prompts[0].match(/Channel: telegram/g)?.length ?? 0).toBe(1);
    expect(second.batching?.messageCount).toBe(2);
    expect(getSupersessionState().batching.pendingCount).toBe(0);
    expect(getSupersessionState().batching.lastFlush?.messageCount).toBe(2);
  });

  test("preserves active request metadata during downstream execution", async () => {
    let releasePrompt: (() => void) | undefined;
    let markPromptEntered: (() => void) | undefined;
    const promptEntered = new Promise<void>((resolve) => {
      markPromptEntered = resolve;
    });
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    setSession({
      prompt: async () => {
        expect(getActiveRequestMetadata()).toMatchObject({
          operatorTraceId: "cmd_trace_demo",
          command: "status",
        });
        markPromptEntered?.();
        await promptGate;
      },
      reload: async () => {},
      compact: async () => {},
      newSession: async () => {},
    });
    setIdleWaiter(async () => {});

    await enqueue("telegram:1", "status", {
      operatorTraceId: "cmd_trace_demo",
      command: "status",
    });
    const draining = drain();
    await promptEntered;
    releasePrompt?.();
    await draining;

    expect(getActiveRequestMetadata()).toBeUndefined();
  });

  test("requests abort immediately when a newer batched message arrives during the active turn", async () => {
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
      gatewayBatchKey: "telegram:1",
      gatewayBatchWindowMs: 25,
    });

    await draining;
    await drain();

    expect(second.supersession?.abortRequested).toBe(true);
    expect(second.batching).toBeUndefined();
    expect(supersessionEvents).toEqual([{ source: "telegram:1", abortRequested: true }]);
  });
});
