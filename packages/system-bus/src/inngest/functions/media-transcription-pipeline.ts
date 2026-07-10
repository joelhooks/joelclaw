import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const DEFAULT_RIG_ROOT = "/Users/joel/Code/joelhooks/transcript-rig";
const MEDIA_ROOT = "/Volumes/badass-media/";

type RigResult = {
  artifactId?: string;
  sourceId?: string;
  stage?: string;
  claimChecks?: Record<string, string>;
  layout?: { root?: string; pointer?: string };
};

async function leaseSecret(name: string, ttl = "4h"): Promise<string> {
  const proc = Bun.spawn(["secrets", "lease", name, "--ttl", ttl], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`failed to lease ${name}: ${stderr.trim() || `exit ${code}`}`);
  }
  return stdout.trim();
}

async function runRig(
  args: string[],
  options: { needsHuggingFace?: boolean; needsTypesense?: boolean } = {},
): Promise<RigResult> {
  const rigRoot = process.env.TRANSCRIPT_RIG_ROOT ?? DEFAULT_RIG_ROOT;
  const env: Record<string, string | undefined> = { ...process.env };
  if (options.needsHuggingFace) {
    env.HF_TOKEN = await leaseSecret("huggingface_read_token");
  }
  if (options.needsTypesense) {
    env.TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
    env.TYPESENSE_API_KEY =
      process.env.TYPESENSE_API_KEY || (await leaseSecret("typesense_api_key"));
  }

  const logDir = `${rigRoot}/.transcript-rig-runtime`;
  await mkdir(logDir, { recursive: true });
  const invocationId = randomUUID();
  const stdoutPath = `${logDir}/${invocationId}.stdout.log`;
  const stderrPath = `${logDir}/${invocationId}.stderr.log`;
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: rigRoot,
    env,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    Bun.file(stdoutPath).text(),
    Bun.file(stderrPath).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `transcript-rig ${args[0]} failed (${code}): ${(stderr || stdout).trim().slice(-4000)}`,
    );
  }
  try {
    return JSON.parse(stdout) as RigResult;
  } catch {
    throw new Error(
      `transcript-rig ${args[0]} returned invalid JSON: ${stdout.slice(-1000)}`,
    );
  }
}

async function verifyMediaMount(sourcePath: string): Promise<{
  available: boolean;
  blocker?: {
    code: "mount_unavailable";
    message: string;
    retryable: true;
  };
}> {
  const pathExists = await stat(sourcePath)
    .then((value) => value.isDirectory())
    .catch(() => false);
  const proc = Bun.spawn(["mount"], { stdout: "pipe", stderr: "pipe" });
  const [mounts, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  const mounted =
    code === 0 && mounts.includes(" on /Volumes/badass-media (nfs");
  if (mounted && pathExists) return { available: true };
  return {
    available: false,
    blocker: {
      code: "mount_unavailable",
      message:
        "Flagg requires the direct 10GbE NFS mount /Volumes/badass-media; SSH staging and local raw copies are forbidden",
      retryable: true,
    },
  };
}

async function recordStage(
  requestId: string,
  sourcePath: string,
  stage: string,
  result: RigResult,
): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: "media-transcription-pipeline",
    action: "media.transcription.stage.completed",
    success: true,
    metadata: {
      requestId,
      sourcePath,
      stage,
      artifactId: result.artifactId ?? null,
      claimChecks: result.claimChecks ?? {},
    },
  });
}

export const mediaTranscriptionPipeline = inngest.createFunction(
  {
    id: "media-transcription-pipeline-v1",
    name: "Media Transcription Pipeline v1",
    idempotency: "event.data.requestId",
    concurrency: { key: '"media-transcription"', limit: 1 },
    timeouts: { start: "30m", finish: "4h" },
    cancelOn: [
      {
        event: "media/transcription.cancelled",
        if: "event.data.requestId == async.data.requestId",
      },
    ],
  },
  { event: "media/transcription.requested" },
  async ({ event, step }) => {
    const { requestId, sourcePath, publish = true, index = true } = event.data;
    const absoluteSource = resolve(sourcePath);
    if (!absoluteSource.startsWith(MEDIA_ROOT)) {
      throw new NonRetriableError(
        `sourcePath must be under mounted ${MEDIA_ROOT}; got ${sourcePath}`,
      );
    }

    const mount = await step.run("00-verify-badass-media-mount", async () =>
      verifyMediaMount(absoluteSource),
    );
    if (!mount.available && mount.blocker) {
      await step.sendEvent("emit-transcription-blocked", {
        name: "media/transcription.blocked",
        data: {
          requestId,
          sourcePath: absoluteSource,
          blocker: mount.blocker,
        },
      });
      return {
        requestId,
        sourcePath: absoluteSource,
        status: "blocked" as const,
        blocker: mount.blocker,
      };
    }

    const planned = await step.run("01-plan-mounted-media", async () => {
      const result = await runRig(["plan", absoluteSource]);
      await recordStage(requestId, absoluteSource, "planned", result);
      return {
        artifactId: result.artifactId,
        sourceId: result.sourceId,
        outputRoot: result.layout?.root,
      };
    });

    const transcribed = await step.run("02-transcribe-tracks", async () => {
      const result = await runRig(
        ["run", absoluteSource, "--until", "transcribed"],
        { needsHuggingFace: true },
      );
      await recordStage(requestId, absoluteSource, "transcribed", result);
      return result;
    });

    const diarized = await step.run("03-diarize-speakers", async () => {
      const result = await runRig(
        ["resume", absoluteSource, "--until", "diarized"],
        { needsHuggingFace: true },
      );
      await recordStage(requestId, absoluteSource, "diarized", result);
      return result;
    });

    const merged = await step.run("04-merge-timed-words", async () => {
      const result = await runRig([
        "resume",
        absoluteSource,
        "--until",
        "merged",
      ]);
      await recordStage(requestId, absoluteSource, "merged", result);
      return result;
    });

    const exported = await step.run("05-render-editorial-and-analysis", async () => {
      const result = await runRig([
        "resume",
        absoluteSource,
        "--until",
        "exported",
      ]);
      await recordStage(requestId, absoluteSource, "exported", result);
      return result;
    });

    const completed = await step.run("06-index-and-publish", async () => {
      const args = ["resume", absoluteSource];
      if (index) args.push("--index");
      if (publish) args.push("--publish");
      const result = await runRig(args, { needsTypesense: index });
      await recordStage(requestId, absoluteSource, "complete", result);
      return result;
    });

    await step.sendEvent("emit-transcription-completed", {
      name: "media/transcription.completed",
      data: {
        requestId,
        sourcePath: absoluteSource,
        artifactId: completed.artifactId ?? planned.artifactId ?? "unknown",
        outputRoot: planned.outputRoot,
        published: publish,
        indexed: index,
      },
    });

    return {
      requestId,
      sourcePath: absoluteSource,
      artifactId: completed.artifactId ?? planned.artifactId,
      stage: completed.stage ?? "complete",
      published: publish,
      indexed: index,
      checkpoints: {
        transcribed: transcribed.stage,
        diarized: diarized.stage,
        merged: merged.stage,
        exported: exported.stage,
      },
    };
  },
);
