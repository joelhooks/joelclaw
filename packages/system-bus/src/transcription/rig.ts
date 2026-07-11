/**
 * transcript-rig CLI invocation helpers, moved verbatim out of
 * media-transcription-pipeline.ts (v1) so v2's orchestrator and the new
 * per-chunk/diarize functions can share them. Behavior-identical to v1.
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { emitOtelEvent } from "../observability/emit";

export const DEFAULT_RIG_ROOT = "/Users/joel/Code/joelhooks/transcript-rig";
export const MEDIA_ROOT = "/Volumes/badass-media/";

export type RigResult = {
  artifactId?: string;
  sourceId?: string;
  stage?: string;
  claimChecks?: Record<string, string>;
  layout?: { root?: string; pointer?: string };
};

export async function leaseSecret(name: string, ttl = "4h"): Promise<string> {
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

export async function runRig(
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

export async function verifyMediaMount(sourcePath: string): Promise<{
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
  const proc = Bun.spawn(["/sbin/mount"], { stdout: "pipe", stderr: "pipe" });
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

export async function recordStage(
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
