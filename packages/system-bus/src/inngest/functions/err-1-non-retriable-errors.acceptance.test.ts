import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { NonRetriableError } from "inngest";
import { observeSessionFunction } from "./observe";
import { transcriptProcess } from "./transcript-process";
import { agentLoopPlan } from "./agent-loop/plan";
import { videoDownload } from "./video-download";

type StepLike = {
  run: <T>(id: string, handler: () => Promise<T> | T) => Promise<T>;
  sendEvent: (id: string, payload: unknown) => Promise<void>;
};

const originalPath = process.env.PATH;
const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "err-1-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;

  if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;

  rmSync(tempRoot, { recursive: true, force: true });
  rmSync("/tmp/video-ingest", { recursive: true, force: true });
});

function passthroughStep(overrides: Partial<StepLike> = {}): StepLike {
  return {
    run: async <T>(_id: string, handler: () => Promise<T> | T): Promise<T> => await handler(),
    sendEvent: async () => {},
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

describe("ERR-1 acceptance: validation failures are non-retriable", () => {
  test("observe: missing required session field throws NonRetriableError", async () => {
    const event = {
      name: "memory/session.compaction.pending",
      data: {
        dedupeKey: "dedupe-1",
        trigger: "compaction",
        messages: "log body",
      },
    };

    await expectNonRetriableError(
      () => (observeSessionFunction as any).fn({ event, step: passthroughStep() }),
      "Missing required session field: sessionId"
    );
  });

  test("transcript-process: missing audioPath and text throws NonRetriableError", async () => {
    const event = {
      name: "pipeline/transcript.requested",
      data: {
        source: "manual",
        title: "Missing media",
        slug: "missing-media",
      },
    };

    await expectNonRetriableError(
      () => (transcriptProcess as any).fn({ event, step: passthroughStep() }),
      "transcript.process requires either audioPath or text"
    );
  });

  test("plan: missing worktree on re-entry throws NonRetriableError", async () => {
    const projectDir = join(tempRoot, "project");
    mkdirSync(projectDir, { recursive: true });

    const loopId = `missing-worktree-${Date.now()}`;
    const event = {
      name: "agent/loop.story.passed",
      data: {
        loopId,
        project: projectDir,
      },
    };

    await expectNonRetriableError(
      () => (agentLoopPlan as any).fn({ event, step: passthroughStep() }),
      `Worktree missing at /tmp/agent-loop/${loopId}`
    );
  });

  test("plan: generated PRD without stories throws NonRetriableError", async () => {
    installFakeBinary(
      "claude",
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"title":"Generated PRD","stories":[]}'
`
    );

    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

    const projectDir = join(tempRoot, "project");
    mkdirSync(projectDir, { recursive: true });

    const event = {
      name: "agent/loop.started",
      data: {
        loopId: `loop-${Date.now()}`,
        project: projectDir,
        goal: "Generate a PRD",
      },
    };

    const step = passthroughStep({
      run: async <T>(id: string, handler: () => Promise<T> | T): Promise<T> => {
        if (id === "create-worktree" || id === "install-worktree-deps") {
          return undefined as T;
        }
        if (id === "resolve-workdir") {
          return projectDir as T;
        }
        if (id === "check-cancel") {
          return false as T;
        }
        return await handler();
      },
    });

    await expectNonRetriableError(
      () => (agentLoopPlan as any).fn({ event, step }),
      "Generated PRD has no stories"
    );
  });

  test("video-download: missing info json throws NonRetriableError", async () => {
    installFakeBinary(
      "yt-dlp",
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p /tmp/video-ingest/mock-download
touch /tmp/video-ingest/mock-download/video.mp4
`
    );

    const event = {
      name: "pipeline/video.requested",
      data: {
        url: "https://example.com/video",
      },
    };

    await expectNonRetriableError(
      () => (videoDownload as any).fn({ event, step: passthroughStep() }),
      "No .info.json found"
    );
  });
});
