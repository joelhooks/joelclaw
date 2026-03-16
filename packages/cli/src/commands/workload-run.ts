import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InboxResult } from "@joelclaw/agent-execution";
import type { NextAction } from "../response";
import { WORKLOAD_INBOX_DIR, WORKLOAD_VERSION, type WorkloadDispatchResult, type WorkloadPlanningResult, type WorkloadRequest, type WorkloadRunResult, type WorkloadRuntimeRequest, type WorkloadTarget } from "./workload-types";
import { buildDispatchContract } from "./workload-dispatch";
import { runGit } from "./workload-utils";

export function writeQueueAdmissionFailureInbox(
  runtimeRequest: WorkloadRuntimeRequest,
  errorMessage: string,
  now = new Date(),
): string {
  mkdirSync(WORKLOAD_INBOX_DIR, { recursive: true });
  const timestamp = now.toISOString();
  const result: InboxResult = {
    requestId: runtimeRequest.requestId,
    status: "failed",
    task: runtimeRequest.task,
    tool: runtimeRequest.tool,
    error: errorMessage,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    ...(runtimeRequest.executionMode ? { executionMode: runtimeRequest.executionMode } : {}),
    ...(runtimeRequest.sandboxBackend ? { sandboxBackend: runtimeRequest.sandboxBackend } : {}),
    logs: {
      stdout: "",
      stderr: errorMessage,
    },
  };
  const inboxPath = join(WORKLOAD_INBOX_DIR, `${runtimeRequest.requestId}.json`);
  writeFileSync(inboxPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return inboxPath;
}

export const isNestedWorkflowRigSandboxExecution = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const sandboxExecution = env.JOELCLAW_SANDBOX_EXECUTION?.trim().toLowerCase() === "true";
  const workflowId = env.JOELCLAW_SANDBOX_WORKFLOW_ID?.trim();
  const allowNested = env.JOELCLAW_ALLOW_NESTED_WORKFLOW_RIG?.trim().toLowerCase() === "true";

  return sandboxExecution && Boolean(workflowId) && !allowNested;
};

export const buildRunId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WR_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

export const resolveRepoUrlForRun = (
  target: WorkloadTarget,
  explicitRepoUrl?: string,
): string | undefined => {
  if (explicitRepoUrl?.trim()) {
    return explicitRepoUrl.trim();
  }

  if (!target.repo.startsWith("/")) {
    return undefined;
  }

  return runGit(target.repo, ["config", "--get", "remote.origin.url"]);
};

export const buildWorkloadRunTask = (options: {
  dispatch: WorkloadDispatchResult;
  request: WorkloadRequest;
}): string => {
  const targetPaths = options.dispatch.handoff.reservedPaths.length > 0
    ? options.dispatch.handoff.reservedPaths.join(", ")
    : "repo-wide";

  return [
    `Execute workload ${options.dispatch.sourcePlan.workloadId} ${options.dispatch.selectedStage.id}.`,
    "",
    `Goal: ${options.dispatch.selectedStage.name}`,
    `Repo: ${options.dispatch.target.repo}`,
    `Branch/base: ${options.dispatch.target.branch ?? "unknown"}${options.dispatch.target.baseSha ? ` @ ${options.dispatch.target.baseSha}` : ""}`,
    `Scoped paths: ${targetPaths}`,
    "",
    "Acceptance:",
    ...options.request.acceptance.map((criterion) => `- ${criterion}`),
    "",
    "Verification required:",
    ...options.dispatch.selectedStage.verification.map((criterion) => `- ${criterion}`),
    "",
    "Remaining gates:",
    ...options.dispatch.handoff.remainingGates.map((gate) => `- ${gate}`),
    "",
    "Guidance:",
    `- ${options.dispatch.guidance.summary}`,
    `- ${options.dispatch.guidance.executionLoop.progressUpdateExpectation}`,
    `- ${options.dispatch.guidance.executionLoop.completionExpectation}`,
    "",
    "Closeout:",
    "- Keep the work inside the scoped paths unless the plan is updated explicitly.",
    "- Report what changed, what was verified, what remains, and whether the next move is push, handoff, or stop.",
  ].join("\n");
};

export const buildWorkloadRunResult = (options: {
  sourcePlanPath: string;
  result: WorkloadPlanningResult;
  stageId?: string;
  tool: "pi" | "codex" | "claude";
  timeout?: number;
  model?: string;
  executionMode?: "auto" | "host" | "sandbox";
  sandboxBackend?: "local" | "k8s";
  sandboxMode?: "minimal" | "full";
  repoUrl?: string;
  now?: Date;
}): WorkloadRunResult => {
  const dispatch = buildDispatchContract({
    sourcePlanPath: options.sourcePlanPath,
    result: options.result,
    stageId: options.stageId,
    now: options.now,
  });
  const runId = buildRunId(options.now);
  const inferredExecutionMode =
    options.executionMode && options.executionMode !== "auto"
      ? options.executionMode
      : options.result.plan.mode === "sandbox" ||
          options.result.request.risk.includes("sandbox-required")
        ? "sandbox"
        : "host";
  const repoUrl = resolveRepoUrlForRun(dispatch.target, options.repoUrl);
  const cwd = dispatch.target.repo.startsWith("/") ? dispatch.target.repo : undefined;

  if (!cwd && !repoUrl) {
    throw new Error(
      "workload run needs either a local repo target or --repo-url so the runtime knows what checkout to execute",
    );
  }

  const runtimeRequest: WorkloadRuntimeRequest = {
    requestId: runId,
    workflowId: dispatch.sourcePlan.workloadId,
    storyId: dispatch.selectedStage.id,
    task: buildWorkloadRunTask({
      dispatch,
      request: options.result.request,
    }),
    tool: options.tool,
    ...(cwd ? { cwd } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(dispatch.target.branch ? { branch: dispatch.target.branch } : {}),
    ...(dispatch.target.baseSha ? { baseSha: dispatch.target.baseSha } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.model ? { model: options.model } : {}),
    executionMode: inferredExecutionMode,
    ...(inferredExecutionMode === "sandbox"
      ? {
          sandbox: "workspace-write",
          sandboxBackend: options.sandboxBackend ?? "local",
          sandboxMode: options.sandboxMode ?? "minimal",
        }
      : {}),
    readFiles: true,
  };

  return {
    version: WORKLOAD_VERSION,
    runId,
    sourcePlan: dispatch.sourcePlan,
    selectedStage: dispatch.selectedStage,
    target: dispatch.target,
    guidance: dispatch.guidance,
    event: {
      family: "workload/requested",
      target: "system/agent.requested",
    },
    runtimeRequest,
    dryRun: false,
    shipped: {
      plan: true,
      dispatch: true,
      run: true,
      status: false,
      explain: false,
      cancel: false,
    },
  };
};

export const buildRunNextActions = (
  planArtifactPath: string,
  result: WorkloadRunResult,
): NextAction[] => {
  const actions: NextAction[] = [];

  if (result.queue) {
    actions.push({
      command: "queue inspect <stream-id>",
      description: "Inspect the queued workload request",
      params: {
        "stream-id": {
          description: "Redis stream id",
          value: result.queue.streamId,
          required: true,
        },
      },
    });
    actions.push({
      command: "queue depth",
      description: "Check current queue depth after enqueueing the workload",
    });
    actions.push({
      command: "queue stats [--hours <hours>]",
      description: "Inspect recent queue dispatch health",
      params: {
        hours: {
          description: "Recent queue stats window",
          value: 1,
        },
      },
    });
    return actions;
  }

  actions.push({
    command:
      "workload run <plan-artifact> [--stage <stage-id>] [--tool <tool>] [--execution-mode <mode>] [--sandbox-backend <backend>] [--sandbox-mode <mode>] [--repo-url <repo-url>]",
    description: "Enqueue the normalized workload request through the canonical workload/runtime bridge",
    params: {
      "plan-artifact": {
        description: "Path to a workload plan envelope",
        value: planArtifactPath,
        required: true,
      },
      "stage-id": {
        description: "Stage to enqueue",
        value: result.selectedStage.id,
      },
      tool: {
        description: "Background agent tool",
        value: result.runtimeRequest.tool,
        enum: ["pi", "codex", "claude"],
      },
      mode: {
        description: "Runtime execution mode",
        value: result.runtimeRequest.executionMode ?? "host",
        enum: ["auto", "host", "sandbox"],
      },
      backend: {
        description: "Sandbox backend when sandbox mode is selected",
        value: result.runtimeRequest.sandboxBackend ?? "local",
        enum: ["local", "k8s"],
      },
      "sandbox-mode": {
        description: "Local sandbox mode when sandbox execution is selected",
        value: result.runtimeRequest.sandboxMode ?? "minimal",
        enum: ["minimal", "full"],
      },
      "repo-url": {
        description: "Explicit repo URL when the target is not a local checkout",
        value: result.runtimeRequest.repoUrl ?? "git@github.com:owner/repo.git",
      },
    },
  });

  return actions;
};
