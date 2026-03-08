/**
 * k8s Job launcher helpers for sandbox execution.
 *
 * These helpers keep the Kubernetes-facing control plane deterministic:
 * create a Job from the canonical SandboxExecutionRequest,
 * inspect Job/Pod state, read logs, and cancel work explicitly.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateJobSpec, type JobSpecOptions } from "./job-spec.js";
import type { SandboxExecutionRequest, SandboxExecutionResult, SandboxJobRef } from "./types.js";

export const RESULT_START_MARKER = "---RESULT_START---";
export const RESULT_END_MARKER = "---RESULT_END---";

export type SandboxJobPhase = "pending" | "running" | "completed" | "failed" | "unknown";

export interface LaunchSandboxJobOptions extends JobSpecOptions {
  kubectlBin?: string;
}

export interface SandboxJobLaunchResult {
  job: SandboxJobRef;
  createdAt: string;
  manifest: Record<string, unknown>;
}

export interface SandboxJobStatus {
  found: boolean;
  job: SandboxJobRef;
  phase: SandboxJobPhase;
  startTime?: string;
  completionTime?: string;
  reason?: string;
  message?: string;
  active: number;
  succeeded: number;
  failed: number;
}

async function runProcess(
  command: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getKubectlBin(options?: { kubectlBin?: string }): string {
  return options?.kubectlBin?.trim() || "kubectl";
}

export async function launchSandboxJob(
  request: SandboxExecutionRequest,
  options: LaunchSandboxJobOptions,
): Promise<SandboxJobLaunchResult> {
  const manifest = generateJobSpec(request, options);
  const namespace = ((manifest.metadata as Record<string, unknown> | undefined)?.namespace as string) || "joelclaw";
  const name = ((manifest.metadata as Record<string, unknown> | undefined)?.name as string) || request.requestId;
  const job: SandboxJobRef = { name, namespace };

  const kubectlBin = getKubectlBin(options);
  const dir = await mkdtemp(join(tmpdir(), "joelclaw-sandbox-job-"));
  const manifestPath = join(dir, `${name}.json`);

  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const applied = await runProcess([kubectlBin, "apply", "-f", manifestPath]);

    if (applied.exitCode !== 0) {
      throw new Error(applied.stderr || applied.stdout || "kubectl apply failed");
    }

    return {
      job,
      createdAt: new Date().toISOString(),
      manifest,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readSandboxJobStatus(
  job: SandboxJobRef,
  options: { kubectlBin?: string } = {},
): Promise<SandboxJobStatus> {
  const kubectlBin = getKubectlBin(options);
  const result = await runProcess([
    kubectlBin,
    "get",
    "job",
    job.name,
    "-n",
    job.namespace,
    "-o",
    "json",
  ]);

  if (result.exitCode !== 0) {
    return {
      found: false,
      job,
      phase: "unknown",
      reason: "job_not_found",
      message: result.stderr || result.stdout || "Job not found",
      active: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const parsed = parseJson<Record<string, any>>(result.stdout);
  if (!parsed) {
    return {
      found: false,
      job,
      phase: "unknown",
      reason: "invalid_job_json",
      message: result.stdout,
      active: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const status = (parsed.status ?? {}) as Record<string, any>;
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const completeCondition = conditions.find((condition) => condition?.type === "Complete" && condition?.status === "True");
  const failedCondition = conditions.find((condition) => condition?.type === "Failed" && condition?.status === "True");

  let phase: SandboxJobPhase = "pending";
  if (completeCondition) phase = "completed";
  else if (failedCondition || Number(status.failed ?? 0) > 0) phase = "failed";
  else if (Number(status.active ?? 0) > 0 || status.startTime) phase = "running";

  const podName = await readSandboxJobPodName(job, options).catch(() => undefined);

  return {
    found: true,
    job: podName ? { ...job, podName } : job,
    phase,
    startTime: typeof status.startTime === "string" ? status.startTime : undefined,
    completionTime:
      typeof status.completionTime === "string"
        ? status.completionTime
        : typeof completeCondition?.lastTransitionTime === "string"
          ? completeCondition.lastTransitionTime
          : typeof failedCondition?.lastTransitionTime === "string"
            ? failedCondition.lastTransitionTime
            : undefined,
    reason:
      (typeof failedCondition?.reason === "string" && failedCondition.reason) ||
      (typeof completeCondition?.reason === "string" && completeCondition.reason) ||
      undefined,
    message:
      (typeof failedCondition?.message === "string" && failedCondition.message) ||
      (typeof completeCondition?.message === "string" && completeCondition.message) ||
      undefined,
    active: Number(status.active ?? 0),
    succeeded: Number(status.succeeded ?? 0),
    failed: Number(status.failed ?? 0),
  };
}

export async function readSandboxJobPodName(
  job: SandboxJobRef,
  options: { kubectlBin?: string } = {},
): Promise<string | undefined> {
  const kubectlBin = getKubectlBin(options);
  const result = await runProcess([
    kubectlBin,
    "get",
    "pods",
    "-n",
    job.namespace,
    "-l",
    `job-name=${job.name}`,
    "-o",
    "json",
  ]);

  if (result.exitCode !== 0) {
    return undefined;
  }

  const parsed = parseJson<Record<string, any>>(result.stdout);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const pod = items[0];
  const name = pod?.metadata?.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

export async function readSandboxJobLogs(
  job: SandboxJobRef,
  options: { kubectlBin?: string } = {},
): Promise<string> {
  const kubectlBin = getKubectlBin(options);
  const result = await runProcess([
    kubectlBin,
    "logs",
    `job/${job.name}`,
    "-n",
    job.namespace,
    "--all-containers=true",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to read logs for ${job.name}`);
  }

  return result.stdout;
}

export async function cancelSandboxJob(
  job: SandboxJobRef,
  options: { kubectlBin?: string } = {},
): Promise<void> {
  const kubectlBin = getKubectlBin(options);
  const result = await runProcess([
    kubectlBin,
    "delete",
    "job",
    job.name,
    "-n",
    job.namespace,
    "--ignore-not-found=true",
    "--wait=false",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to delete Job ${job.name}`);
  }
}

export function extractSandboxResultFromLogs(logText: string): SandboxExecutionResult | null {
  const start = logText.indexOf(RESULT_START_MARKER);
  const end = logText.indexOf(RESULT_END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const jsonText = logText.slice(start + RESULT_START_MARKER.length, end).trim();
  return parseJson<SandboxExecutionResult>(jsonText);
}
