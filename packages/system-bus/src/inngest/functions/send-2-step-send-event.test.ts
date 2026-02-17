import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inngest } from "../client";

const originalInngestSend = inngest.send.bind(inngest);
const originalVaultPath = process.env.VAULT_PATH;

let inngestSendCallCount = 0;

type SendCall = {
  id: string;
  payload: unknown;
  runContext: string | null;
};

beforeEach(() => {
  inngestSendCallCount = 0;
  (inngest as { send: (...args: unknown[]) => Promise<unknown> }).send = async () => {
    inngestSendCallCount += 1;
    throw new Error("Unexpected direct inngest.send call");
  };
});

afterEach(() => {
  (inngest as { send: typeof originalInngestSend }).send = originalInngestSend;

  if (originalVaultPath === undefined) {
    delete process.env.VAULT_PATH;
  } else {
    process.env.VAULT_PATH = originalVaultPath;
  }
});

describe("SEND-2 acceptance tests", () => {
  test("video download emits follow-up events via step.sendEvent from the existing emit-events step", async () => {
    const mod = await import(`./video-download.ts?send2=${Date.now()}`);
    const fn = (mod.videoDownload as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const runIds: string[] = [];
    const stepSendCalls: SendCall[] = [];
    let activeRunId: string | null = null;

    const result = (await fn({
      event: {
        name: "pipeline/video.requested",
        data: {
          url: "https://example.com/video",
          maxQuality: "1080",
        },
      },
      step: {
        run: async (id: string, _work: () => Promise<unknown>) => {
          runIds.push(id);

          const canned: Record<string, unknown> = {
            download: {
              dir: "/tmp/video-ingest/sample/",
              title: "Sample Video",
              slug: "sample-video",
              channel: "Sample Channel",
              publishedDate: "2026-02-17",
              duration: "00:05:00",
              sourceUrl: "https://example.com/video",
              audioPath: "/tmp/video-ingest/sample/video.mp4",
            },
            "transfer-to-nas": "/volume1/home/joel/video/2026/sample-video",
            "log-download": undefined,
          };

          if (!(id in canned)) {
            throw new Error(`Unexpected step.run id: ${id}`);
          }

          return canned[id];
        },
        sendEvent: async (id: string, payload: unknown) => {
          stepSendCalls.push({ id, payload, runContext: activeRunId });
          return { ids: ["evt-send-2-video"] };
        },
      },
    })) as Record<string, unknown>;

    expect(runIds).not.toContain("emit-events");
    expect(stepSendCalls).toHaveLength(1);
    expect(stepSendCalls[0]).toMatchObject({
      id: "emit-events",
      runContext: null,
      payload: [
        {
          name: "pipeline/video.downloaded",
          data: {
            slug: "sample-video",
            title: "Sample Video",
            channel: "Sample Channel",
            duration: "00:05:00",
            nasPath: "/volume1/home/joel/video/2026/sample-video",
            sourceUrl: "https://example.com/video",
            publishedDate: "2026-02-17",
          },
        },
        {
          name: "pipeline/transcript.requested",
          data: {
            source: "youtube",
            title: "Sample Video",
            slug: "sample-video",
            channel: "Sample Channel",
            publishedDate: "2026-02-17",
            duration: "00:05:00",
            sourceUrl: "https://example.com/video",
            nasPath: "/volume1/home/joel/video/2026/sample-video",
          },
        },
      ],
    });

    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      slug: "sample-video",
      title: "Sample Video",
      channel: "Sample Channel",
      nasPath: "/volume1/home/joel/video/2026/sample-video",
      status: "downloaded",
    });
  });

  test("transcript process emits completion and summarize events via step.sendEvent from the existing emit-events step", async () => {
    process.env.VAULT_PATH = "/tmp/send-2-vault";

    const mod = await import(`./transcript-process.ts?send2=${Date.now()}`);
    const fn = (mod.transcriptProcess as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const runIds: string[] = [];
    const stepSendCalls: SendCall[] = [];
    let activeRunId: string | null = null;

    const result = (await fn({
      event: {
        name: "pipeline/transcript.requested",
        data: {
          source: "youtube",
          audioPath: "/tmp/video-ingest/sample/video.mp4",
          title: "Sample Video",
          slug: "sample-video",
          channel: "Sample Channel",
          publishedDate: "2026-02-17",
          duration: "00:05:00",
          sourceUrl: "https://example.com/video",
          nasPath: "/volume1/home/joel/video/2026/sample-video",
          tmpDir: "/tmp/video-ingest/sample",
        },
      },
      step: {
        run: async (id: string, _work: () => Promise<unknown>) => {
          runIds.push(id);

          const canned: Record<string, unknown> = {
            transcribe: "/tmp/transcript-process/sample-video-processed.json",
            "create-vault-note": "/tmp/send-2-vault/Resources/videos/sample-video.md",
            "update-daily-note": undefined,
            "log-and-cleanup": undefined,
          };

          if (!(id in canned)) {
            throw new Error(`Unexpected step.run id: ${id}`);
          }

          return canned[id];
        },
        sendEvent: async (id: string, payload: unknown) => {
          stepSendCalls.push({ id, payload, runContext: activeRunId });
          return { ids: ["evt-send-2-transcript"] };
        },
      },
    })) as Record<string, unknown>;

    expect(runIds).not.toContain("emit-events");
    expect(stepSendCalls).toHaveLength(1);
    expect(stepSendCalls[0]).toMatchObject({
      id: "emit-events",
      runContext: null,
      payload: [
        {
          name: "pipeline/transcript.processed",
          data: {
            vaultPath: "/tmp/send-2-vault/Resources/videos/sample-video.md",
            title: "Sample Video",
            slug: "sample-video",
            source: "youtube",
          },
        },
        {
          name: "content/summarize.requested",
          data: {
            vaultPath: "/tmp/send-2-vault/Resources/videos/sample-video.md",
          },
        },
      ],
    });

    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      vaultPath: "/tmp/send-2-vault/Resources/videos/sample-video.md",
      title: "Sample Video",
      slug: "sample-video",
      source: "youtube",
      status: "processed",
    });
  });

  test("grep -r \"inngest.send\" has no matches in video-download.ts", async () => {
    const proc = Bun.spawn(["grep", "-r", "inngest.send", "src/inngest/functions/video-download.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
  });

  test("grep -r \"inngest.send\" has no matches in transcript-process.ts", async () => {
    const proc = Bun.spawn(["grep", "-r", "inngest.send", "src/inngest/functions/transcript-process.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
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
