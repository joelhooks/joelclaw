#!/usr/bin/env bun
/**
 * Runtime entrypoint for sandboxed k8s Jobs.
 *
 * Reads the canonical SandboxExecutionRequest contract from env,
 * materializes the repo, runs the agent, executes verification commands,
 * emits a terminal SandboxExecutionResult via callback + stdout markers,
 * and exits with truthful status.
 */

import { generatePatchArtifact } from "./artifacts.js";
import { RESULT_END_MARKER, RESULT_START_MARKER } from "./k8s.js";
import { getTouchedFiles, materializeRepo } from "./repo.js";
import type { ExecutionArtifacts, SandboxExecutionResult } from "./types.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT?.trim() || "/workspace";
const REPO_PATH = process.env.WORKING_DIR?.trim() || `${WORKSPACE_ROOT}/repo`;
const REQUEST_ID = requiredEnv("REQUEST_ID");
const WORKFLOW_ID = requiredEnv("WORKFLOW_ID");
const STORY_ID = requiredEnv("STORY_ID");
const BASE_SHA = requiredEnv("BASE_SHA");
const SANDBOX_PROFILE = process.env.SANDBOX_PROFILE?.trim() || "workspace-write";
const AGENT_NAME = process.env.AGENT_NAME?.trim() || "sandbox-runner";
const AGENT_PROGRAM = process.env.AGENT_PROGRAM?.trim() || AGENT_NAME;
const AGENT_MODEL = process.env.AGENT_MODEL?.trim();
const REPO_URL = process.env.REPO_URL?.trim();
const REPO_BRANCH = process.env.REPO_BRANCH?.trim() || "main";
const RESULT_CALLBACK_URL = process.env.RESULT_CALLBACK_URL?.trim();
const RESULT_CALLBACK_TOKEN = process.env.RESULT_CALLBACK_TOKEN?.trim();
const TIMEOUT_SECONDS = Number.parseInt(process.env.TIMEOUT_SECONDS ?? "3600", 10) || 3600;
const TASK = decodeBase64Env("TASK_PROMPT_B64");
const VERIFICATION_COMMANDS = decodeJsonArrayEnv("VERIFICATION_COMMANDS_B64");
const STARTED_AT = new Date().toISOString();

let terminalWritten = false;
let currentStartedAt = STARTED_AT;
let currentJobName = process.env.JOB_NAME?.trim() || process.env.HOSTNAME?.trim();
let currentNamespace = process.env.JOB_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || "joelclaw";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function decodeBase64Env(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    throw new Error(`Missing required env ${name}`);
  }
  return Buffer.from(raw, "base64").toString("utf8");
}

function decodeJsonArrayEnv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(decoded);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must decode to a JSON string array`);
  }
  return parsed;
}

async function runProcess(
  command: string[],
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  let timedOut = false;
  const timeoutMs = Math.max(1, options.timeoutSeconds ?? TIMEOUT_SECONDS) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    timedOut,
  };
}

async function postResult(result: SandboxExecutionResult): Promise<void> {
  if (!RESULT_CALLBACK_URL) return;

  const response = await fetch(RESULT_CALLBACK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(RESULT_CALLBACK_TOKEN ? { "x-otel-emit-token": RESULT_CALLBACK_TOKEN } : {}),
    },
    body: JSON.stringify(result),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`result callback failed (${response.status}): ${text}`);
  }
}

function writeResultMarkers(result: SandboxExecutionResult): void {
  console.log(RESULT_START_MARKER);
  console.log(JSON.stringify(result));
  console.log(RESULT_END_MARKER);
}

function truncate(value: string | undefined, max = 10_000): string | undefined {
  if (!value) return value;
  return value.length > max ? value.slice(-max) : value;
}

async function runVerificationCommands(repoPath: string, commands: string[]): Promise<{
  success: boolean;
  output: string;
}> {
  const outputs: string[] = [];

  for (const command of commands) {
    const result = await runProcess(["bash", "-lc", command], {
      cwd: repoPath,
      timeoutSeconds: TIMEOUT_SECONDS,
    });

    outputs.push(`$ ${command}`);
    if (result.stdout) outputs.push(result.stdout);
    if (result.stderr) outputs.push(result.stderr);

    if (result.timedOut) {
      outputs.push(`verification timed out after ${TIMEOUT_SECONDS}s`);
      return { success: false, output: outputs.join("\n") };
    }

    if (result.exitCode !== 0) {
      outputs.push(`verification exited ${result.exitCode}`);
      return { success: false, output: outputs.join("\n") };
    }
  }

  return { success: true, output: outputs.join("\n") };
}

async function configureGitIdentity(repoPath: string): Promise<void> {
  await runProcess(["git", "-C", repoPath, "config", "user.name", "joelclawgithub[bot]"]);
  await runProcess(["git", "-C", repoPath, "config", "user.email", "joelclawgithub[bot]@users.noreply.github.com"]);
}

async function executeAgent(repoPath: string): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  switch (AGENT_PROGRAM) {
    case "claude": {
      const args = ["claude", "-p", TASK, "--dangerously-skip-permissions"];
      if (AGENT_MODEL) {
        args.push("--model", AGENT_MODEL);
      }
      const result = await runProcess(args, { cwd: repoPath, timeoutSeconds: TIMEOUT_SECONDS });
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        return {
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: "CLAUDE_CODE_OAUTH_TOKEN is required for claude sandbox runs",
        };
      }
      if (result.timedOut) {
        return {
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: `claude timed out after ${TIMEOUT_SECONDS}s`,
        };
      }
      if (result.exitCode !== 0) {
        return {
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: `claude exited ${result.exitCode}: ${result.stderr || result.stdout || "command failed"}`,
        };
      }
      return { success: true, stdout: result.stdout, stderr: result.stderr };
    }

    case "codex": {
      const args = ["codex", "exec", "--full-auto", "-s", SANDBOX_PROFILE];
      if (AGENT_MODEL) {
        args.push("-m", AGENT_MODEL);
      }
      args.push(TASK);
      const result = await runProcess(args, { cwd: repoPath, timeoutSeconds: TIMEOUT_SECONDS });
      if (result.timedOut) {
        return {
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: `codex timed out after ${TIMEOUT_SECONDS}s`,
        };
      }
      if (result.exitCode !== 0) {
        return {
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: `codex exited ${result.exitCode}: ${result.stderr || result.stdout || "command failed"}`,
        };
      }
      return { success: true, stdout: result.stdout, stderr: result.stderr };
    }

    case "pi":
      return {
        success: false,
        stdout: "",
        stderr: "",
        error: "pi is not supported inside the k8s sandbox runner yet; use the local sandbox backend until host-routed pi execution is designed",
      };

    default:
      return {
        success: false,
        stdout: "",
        stderr: "",
        error: `Unsupported AGENT_PROGRAM for sandbox runner: ${AGENT_PROGRAM}`,
      };
  }
}

async function buildArtifacts(
  repoPath: string,
  verification?: { success: boolean; output: string },
  stdout?: string,
  stderr?: string,
): Promise<ExecutionArtifacts> {
  const artifacts = await generatePatchArtifact({
    repoPath,
    baseSha: BASE_SHA,
    includeUntracked: true,
    verificationCommands: VERIFICATION_COMMANDS,
    verificationSuccess: verification?.success,
    verificationOutput: verification?.output,
  });

  const touchedFiles = await getTouchedFiles(repoPath);

  return {
    ...artifacts,
    touchedFiles,
    logs: {
      ...(artifacts.logs ?? {}),
      stdout: truncate(stdout) || artifacts.logs?.stdout,
      stderr: truncate(stderr) || artifacts.logs?.stderr,
    },
  };
}

async function finish(result: SandboxExecutionResult, exitCode: number): Promise<never> {
  if (!terminalWritten) {
    terminalWritten = true;
    writeResultMarkers(result);
    try {
      await postResult(result);
    } catch (error) {
      console.error(`[sandbox-runner] failed to post result: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  process.exit(exitCode);
}

process.on("SIGTERM", () => {
  const completedAt = new Date().toISOString();
  const result: SandboxExecutionResult = {
    requestId: REQUEST_ID,
    state: "cancelled",
    startedAt: currentStartedAt,
    completedAt,
    durationMs: Date.now() - new Date(currentStartedAt).getTime(),
    backend: "k8s",
    job: currentJobName ? { name: currentJobName, namespace: currentNamespace } : undefined,
    error: "Sandbox Job received SIGTERM and exited before completion",
  };

  void finish(result, 143);
});

(async () => {
  if (!REPO_URL) {
    throw new Error("REPO_URL is required for k8s sandbox runs");
  }

  await postResult({
    requestId: REQUEST_ID,
    state: "running",
    startedAt: STARTED_AT,
    backend: "k8s",
    job: currentJobName ? { name: currentJobName, namespace: currentNamespace } : undefined,
  }).catch((error) => {
    console.warn(`[sandbox-runner] failed to post running state: ${error instanceof Error ? error.message : String(error)}`);
  });

  const materialized = await materializeRepo(REPO_PATH, BASE_SHA, {
    remoteUrl: REPO_URL,
    branch: REPO_BRANCH,
    depth: 50,
    timeoutSeconds: Math.max(60, Math.min(TIMEOUT_SECONDS, 300)),
  });

  await configureGitIdentity(materialized.path);

  const execution = await executeAgent(materialized.path);
  const verification = VERIFICATION_COMMANDS?.length
    ? await runVerificationCommands(materialized.path, VERIFICATION_COMMANDS)
    : undefined;

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(STARTED_AT).getTime();

  if (!execution.success || (verification && !verification.success)) {
    const artifacts = await buildArtifacts(
      materialized.path,
      verification,
      execution.stdout,
      [execution.stderr, verification?.output].filter(Boolean).join("\n"),
    ).catch(() => undefined);

    await finish(
      {
        requestId: REQUEST_ID,
        state: "failed",
        startedAt: STARTED_AT,
        completedAt,
        durationMs,
        backend: "k8s",
        job: currentJobName ? { name: currentJobName, namespace: currentNamespace } : undefined,
        artifacts,
        error: execution.error || (verification && !verification.success ? "verification failed" : "sandbox execution failed"),
        output: truncate([execution.stdout, execution.stderr, verification?.output].filter(Boolean).join("\n\n"), 50_000),
      },
      1,
    );
  }

  const artifacts = await buildArtifacts(materialized.path, verification, execution.stdout, execution.stderr);

  await finish(
    {
      requestId: REQUEST_ID,
      state: "completed",
      startedAt: STARTED_AT,
      completedAt,
      durationMs,
      backend: "k8s",
      job: currentJobName ? { name: currentJobName, namespace: currentNamespace } : undefined,
      artifacts,
      output: truncate(execution.stdout, 50_000),
    },
    0,
  );
})().catch(async (error) => {
  const completedAt = new Date().toISOString();
  const result: SandboxExecutionResult = {
    requestId: REQUEST_ID,
    state: "failed",
    startedAt: STARTED_AT,
    completedAt,
    durationMs: Date.now() - new Date(STARTED_AT).getTime(),
    backend: "k8s",
    job: currentJobName ? { name: currentJobName, namespace: currentNamespace } : undefined,
    error: error instanceof Error ? error.message : String(error),
  };

  await finish(result, 1);
});
