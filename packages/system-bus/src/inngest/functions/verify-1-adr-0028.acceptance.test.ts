import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { inngest, type Events } from "../client";
import { observeSessionFunction } from "./observe";
import { transcriptProcess } from "./transcript-process";
import { videoDownload } from "./video-download";
import { agentLoopPlan } from "./agent-loop/plan";
import { summarize } from "./summarize";
import { discoveryCapture } from "./discovery-capture";
import { agentLoopTestWriter } from "./agent-loop/test-writer";
import { agentLoopImplement } from "./agent-loop/implement";
import { agentLoopReview } from "./agent-loop/review";
import { agentLoopJudge } from "./agent-loop/judge";
import { agentLoopComplete } from "./agent-loop/complete";
import { agentLoopRetro } from "./agent-loop/retro";

type StepLike = {
  run: <T>(id: string, handler: () => Promise<T> | T) => Promise<T>;
  sendEvent: (id: string, payload: unknown) => Promise<unknown>;
};

type InngestFn = {
  opts?: {
    cancelOn?: Array<{ event?: string; if?: string }>;
  };
  fn: (args: {
    event: { name: string; data: Record<string, unknown> };
    step: StepLike;
  }) => Promise<unknown>;
};

const expectedCancelRule = {
  event: "agent/loop.cancelled",
  if: "event.data.loopId == async.data.loopId",
};

const originalInngestSend = inngest.send.bind(inngest);
let inngestSendCallCount = 0;

const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const originalPath = process.env.PATH;
const originalVaultPath = process.env.VAULT_PATH;
let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "verify-1-"));
  const tempVault = join(tempRoot, "vault");
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
  (inngest as { send: typeof originalInngestSend }).send = originalInngestSend;

  if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;

  if (originalVaultPath === undefined) delete process.env.VAULT_PATH;
  else process.env.VAULT_PATH = originalVaultPath;

  rmSync(tempRoot, { recursive: true, force: true });
  rmSync("/tmp/video-ingest", { recursive: true, force: true });
});

function passthroughStep(overrides: Partial<StepLike> = {}): StepLike {
  return {
    run: async <T>(_id: string, handler: () => Promise<T> | T): Promise<T> => await handler(),
    sendEvent: async () => ({ ids: ["evt-1"] }),
    ...overrides,
  };
}

function installFakeBinary(name: string, body: string): string {
  const binDir = join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return path;
}

async function expectNonRetriableError(
  run: () => Promise<unknown>,
  expectedMessage: string
): Promise<void> {
  try {
    await run();
    throw new Error("Expected function to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(NonRetriableError);
    expect(error as { message?: string }).toMatchObject({
      message: expect.stringContaining(expectedMessage),
    });
  }
}

describe("VERIFY-1 acceptance: ADR-0028 checklist items 1-3", () => {
  test("checklist item 1: direct inngest.send is not used in public event-emission flows", async () => {
    const sendCalls: Array<{ id: string; payload: unknown }> = [];

    const observeResult = await (observeSessionFunction as unknown as InngestFn).fn({
      event: {
        name: "memory/session.compaction.pending",
        data: {
          sessionId: "verify-1-observe",
          dedupeKey: "verify-1-observe-key",
          trigger: "compaction",
          messages: "user: hi",
          tokensBefore: 100,
          capturedAt: "2026-02-17T00:00:00.000Z",
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            "validate-input": {
              sessionId: "verify-1-observe",
              dedupeKey: "verify-1-observe-key",
              trigger: "compaction",
              messages: "user: hi",
              tokensBefore: 100,
              capturedAt: "2026-02-17T00:00:00.000Z",
              schemaVersion: 1,
            },
            "dedupe-check": { dedupe: false, dedupeKey: "verify-1-observe-key" },
            "call-observer-llm": "<observations>ok</observations>",
            "parse-observations": {
              observations: "Observation",
              segments: [{ narrative: "Segment", facts: ["Fact"] }],
              parsed: true,
              concepts: [],
              facts: [],
            },
            "append-daily-log": { appended: true },
            "ensure-qdrant-collection": { exists: true, created: false },
            "store-to-qdrant": { stored: true, count: 1 },
            "update-redis-state": { updated: true },
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-observe"] };
        },
      }),
    });

    const transcriptResult = await (transcriptProcess as unknown as InngestFn).fn({
      event: {
        name: "pipeline/transcript.requested",
        data: {
          source: "youtube",
          audioPath: "/tmp/video-ingest/sample/video.mp4",
          title: "Verify 1",
          slug: "verify-1",
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            transcribe: "/tmp/video-ingest/sample/verify-1.json",
            "create-vault-note": "/tmp/vault/Resources/videos/verify-1.md",
            "update-daily-note": undefined,
            "log-and-cleanup": undefined,
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-transcript"] };
        },
      }),
    });

    const videoResult = await (videoDownload as unknown as InngestFn).fn({
      event: {
        name: "pipeline/video.requested",
        data: {
          url: "https://example.com/video",
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            download: {
              title: "Verify Video",
              slug: "verify-video",
              channel: "Channel",
              duration: "00:01:00",
              sourceUrl: "https://example.com/video",
              publishedDate: "2026-02-17",
            },
            "transfer-to-nas": "/volume1/home/joel/video/2026/verify-video",
            "log-download": undefined,
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-video"] };
        },
      }),
    });

    const summarizeResult = await (summarize as unknown as InngestFn).fn({
      event: {
        name: "content/summarize.requested",
        data: {
          vaultPath: "/tmp/vault/verify-1.md",
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            "read-title": "Verify 1",
            "pi-enrich": undefined,
            "log-and-emit": undefined,
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-summarize"] };
        },
      }),
    });

    const discoveryResult = await (discoveryCapture as unknown as InngestFn).fn({
      event: {
        name: "discovery/noted",
        data: {
          url: "https://example.com/post",
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            investigate: { content: "note", sourceType: "article" },
            "generate-note": {
              noteName: "Verify Discovery",
              vaultPath: "/tmp/vault/Verify Discovery.md",
              piOutput: "ok",
            },
            "slog-result": undefined,
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-discovery"] };
        },
      }),
    });

    const planResult = await (agentLoopPlan as unknown as InngestFn).fn({
      event: {
        name: "agent/loop.story.passed",
        data: {
          loopId: "verify-1-loop",
          project: "/tmp/project",
          maxIterations: 10,
        },
      },
      step: passthroughStep({
        run: async <T>(id: string, _handler: () => Promise<T> | T): Promise<T> => {
          const canned: Record<string, unknown> = {
            "verify-worktree": { exists: true },
            "ensure-worktree-deps": { installed: true },
            "resolve-workdir": "/tmp/agent-loop/worktree/project",
            "check-cancel": false,
            "read-prd": {
              stories: [
                {
                  id: "VERIFY-1",
                  title: "Story",
                  description: "desc",
                  acceptance_criteria: ["criterion"],
                  priority: 1,
                  passes: false,
                },
              ],
            },
            "derive-run-token": "verify-1-token",
            "claim-story": "verify-1-token",
            "emit-test": undefined,
          };

          return canned[id] as T;
        },
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-plan"] };
        },
      }),
    });

    const loggerModule = await import(`./system-logger.ts?verify1=${Date.now()}`);
    const systemLoggerFn = (loggerModule.systemLogger as unknown as InngestFn).fn;

    const systemLoggerResult = await systemLoggerFn({
      event: {
        name: "content/summarized",
        data: {
          action: "summarize",
          detail: "done",
          reason: "verify-1",
        },
      },
      step: passthroughStep({
        sendEvent: async (id: string, payload: unknown) => {
          sendCalls.push({ id, payload });
          return { ids: ["evt-system-logger"] };
        },
      }),
    });

    expect(sendCalls.length).toBeGreaterThan(0);
    expect(inngestSendCallCount).toBe(0);
    expect(observeResult as Record<string, unknown>).toMatchObject({ sessionId: "verify-1-observe" });
    expect(transcriptResult as Record<string, unknown>).toMatchObject({ status: "processed" });
    expect(videoResult as Record<string, unknown>).toMatchObject({ status: "downloaded" });
    expect(summarizeResult as Record<string, unknown>).toMatchObject({ status: "summarized" });
    expect(discoveryResult as Record<string, unknown>).toMatchObject({ status: "captured" });
    expect(planResult as Record<string, unknown>).toMatchObject({ status: "dispatched", loopId: "verify-1-loop" });
    expect(systemLoggerResult as Record<string, unknown>).toMatchObject({ logged: "content/summarized" });
  });

  test("checklist item 2: required functions reject invalid input with NonRetriableError", async () => {
    await expectNonRetriableError(
      () =>
        (observeSessionFunction as unknown as InngestFn).fn({
          event: {
            name: "memory/session.compaction.pending",
            data: {
              dedupeKey: "verify-1",
              trigger: "compaction",
              messages: "missing session id",
            },
          },
          step: passthroughStep(),
        }),
      "Missing required session field: sessionId"
    );

    await expectNonRetriableError(
      () =>
        (transcriptProcess as unknown as InngestFn).fn({
          event: {
            name: "pipeline/transcript.requested",
            data: {
              source: "manual",
              title: "Invalid",
              slug: "invalid",
            },
          },
          step: passthroughStep(),
        }),
      "transcript.process requires either audioPath or text"
    );

    await expectNonRetriableError(
      () =>
        (agentLoopPlan as unknown as InngestFn).fn({
          event: {
            name: "agent/loop.story.passed",
            data: {
              loopId: `verify-1-missing-worktree-${Date.now()}`,
              project: tempRoot,
            },
          },
          step: passthroughStep(),
        }),
      "Worktree missing at /tmp/agent-loop/verify-1-missing-worktree"
    );

    installFakeBinary(
      "yt-dlp",
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p /tmp/video-ingest/verify-1
touch /tmp/video-ingest/verify-1/video.mp4
`
    );

    await expectNonRetriableError(
      () =>
        (videoDownload as unknown as InngestFn).fn({
          event: {
            name: "pipeline/video.requested",
            data: {
              url: "https://example.com/no-info-json",
            },
          },
          step: passthroughStep(),
        }),
      "No .info.json found"
    );
  });

  test("checklist item 3: all 7 agent-loop functions define loop cancellation", () => {
    const loopFunctions = [
      { name: "plan", fn: agentLoopPlan },
      { name: "test-writer", fn: agentLoopTestWriter },
      { name: "implement", fn: agentLoopImplement },
      { name: "review", fn: agentLoopReview },
      { name: "judge", fn: agentLoopJudge },
      { name: "complete", fn: agentLoopComplete },
      { name: "retro", fn: agentLoopRetro },
    ] as const;

    for (const entry of loopFunctions) {
      const rules = (entry.fn as unknown as InngestFn).opts?.cancelOn ?? [];
      const matchingRule = rules.find((rule) => rule.event === "agent/loop.cancelled");

      expect(matchingRule, `${entry.name} is missing cancelOn for agent/loop.cancelled`).toBeDefined();
      expect(matchingRule).toMatchObject(expectedCancelRule);
    }

    const cancelledEvent: Events["agent/loop.cancelled"] = {
      data: {
        loopId: "verify-1-loop-id",
        reason: "user_requested",
      },
    };

    expect(cancelledEvent).toMatchObject({
      data: {
        loopId: "verify-1-loop-id",
      },
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
      const stderr = await new Response(proc.stderr).text();
      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    },
    30_000
  );
});
