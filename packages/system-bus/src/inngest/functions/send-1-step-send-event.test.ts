import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inngest } from "../client";

const originalVaultPath = process.env.VAULT_PATH;
const originalInngestSend = inngest.send.bind(inngest);

let tempDir = "";
let tempVault = "";
let inngestSendCallCount = 0;

function buildObserveEvent() {
  return {
    name: "memory/session.compaction.pending",
    data: {
      sessionId: "session-send-1",
      dedupeKey: "dedupe-send-1",
      trigger: "compaction" as const,
      messages: "user: hi\nassistant: hello",
      messageCount: 8,
      tokensBefore: 1234,
      filesRead: ["src/a.ts"],
      filesModified: ["src/b.ts"],
      capturedAt: "2026-02-17T03:04:05.000Z",
      schemaVersion: 1 as const,
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "send-1-"));
  tempVault = join(tempDir, "vault");
  mkdirSync(join(tempVault, "system"), { recursive: true });
  writeFileSync(join(tempVault, "system", "system-log.jsonl"), "", "utf8");

  process.env.VAULT_PATH = tempVault;

  inngestSendCallCount = 0;
  (inngest as { send: (...args: unknown[]) => Promise<unknown> }).send = async () => {
    inngestSendCallCount += 1;
    throw new Error("Unexpected direct inngest.send call");
  };
});

afterEach(() => {
  if (originalVaultPath === undefined) delete process.env.VAULT_PATH;
  else process.env.VAULT_PATH = originalVaultPath;

  (inngest as { send: typeof originalInngestSend }).send = originalInngestSend;

  rmSync(tempDir, { recursive: true, force: true });
});

describe("SEND-1 acceptance tests", () => {
  test("observe emits accumulated event via step.sendEvent and never calls inngest.send", async () => {
    const { observeSessionFunction } = await import("./observe.ts");
    const fn = (
      observeSessionFunction as unknown as { fn: (input: unknown) => Promise<unknown> }
    ).fn;

    const stepSendCalls: Array<{ id: string; payload: unknown }> = [];
    const step = {
      run: async (id: string, work: () => Promise<unknown>) => {
        if (id === "emit-accumulated") return work();

        const canned: Record<string, unknown> = {
          "validate-input": buildObserveEvent().data,
          "dedupe-check": { dedupe: false, dedupeKey: "dedupe-send-1" },
          "call-observer-llm": "<observations>ignored</observations>",
          "parse-observations": {
            observations: "Fallback observation text",
            segments: [{ narrative: "Segment narrative", facts: ["Fact A", "Fact B"] }],
            currentTask: null,
            suggestedResponse: null,
            parsed: true,
            concepts: [],
            facts: [],
          },
          "append-daily-log": { appended: true },
          "ensure-qdrant-collection": { exists: true, created: false },
          "store-to-qdrant": { stored: true, count: 3 },
          "update-redis-state": { updated: true, key: "memory:latest:2026-02-17" },
        };

        if (!(id in canned)) throw new Error(`Unexpected step.run id: ${id}`);
        return canned[id];
      },
      sendEvent: async (id: string, payload: unknown) => {
        stepSendCalls.push({ id, payload });
        return { ids: ["evt-1"] };
      },
    };

    const result = (await fn({
      event: buildObserveEvent(),
      step,
    })) as Record<string, unknown>;

    expect(stepSendCalls).toHaveLength(1);
    expect(stepSendCalls[0]).toMatchObject({
      id: "emit-accumulated",
      payload: [
        {
          name: "memory/observations.accumulated",
          data: {
            date: "2026-02-17",
            totalTokens: 1234,
            observationCount: 3,
            capturedAt: "2026-02-17T03:04:05.000Z",
          },
        },
      ],
    });

    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      sessionId: "session-send-1",
      accumulatedEvent: {
        emitted: true,
        name: "memory/observations.accumulated",
        data: {
          date: "2026-02-17",
          totalTokens: 1234,
          observationCount: 3,
          capturedAt: "2026-02-17T03:04:05.000Z",
        },
      },
    });
  });

  test("system logger uses step.sendEvent for follow-up event and never calls inngest.send", async () => {
    const mod = await import(`./system-logger.ts?send1=${Date.now()}`);
    const fn = (mod.systemLogger as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const stepSendCalls: Array<{ id: string; payload: unknown }> = [];
    const result = (await fn({
      event: {
        name: "content/summarized",
        data: {
          action: "summarize",
          tool: "content-summarize",
          detail: "daily summary generated",
          reason: "pipeline completion",
        },
      },
      step: {
        sendEvent: async (id: string, payload: unknown) => {
          stepSendCalls.push({ id, payload });
          return { ids: ["evt-2"] };
        },
      },
    })) as Record<string, unknown>;

    expect(stepSendCalls).toHaveLength(1);
    expect(stepSendCalls[0]).toMatchObject({
      id: "emit-system-log-written",
      payload: {
        name: "system/log.written",
        data: {
          action: "summarize",
          tool: "content-summarize",
          detail: "daily summary generated",
          reason: "pipeline completion",
        },
      },
    });

    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      logged: "content/summarized",
    });
  });

  test(
    "TypeScript compiles cleanly: bunx tsc --noEmit",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
