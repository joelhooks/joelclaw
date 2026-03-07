import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionArtifacts,
  generatePatchArtifact,
  getTouchedFiles,
  type InboxResult,
  materializeRepo,
} from "@joelclaw/agent-execution";
import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { inngest } from "../client";

// Track active processes for cancellation
const activeProcesses = new Map<string, { kill: () => void }>();

const INBOX_DIR = join(
  process.env.HOME || "/Users/joel",
  ".joelclaw",
  "workspace",
  "inbox"
);

const PI_FILE_HINT_PATTERN =
  /(?:\/Users\/|~\/|(?:^|[\s"'`])[^\s"'`]+\.(?:ts|md)(?=$|[\s"'`]))/i;
const FILE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:~\/|\/|\.\.?\/|[A-Za-z0-9._-]+\/)[^\s"'`]+/;
const FILE_CONTEXT_PATTERN =
  /\b(file|files|path|paths|repo|repository|directory|folder|codebase|source|src)\b/;
const FILE_READ_OPERATION_PATTERN =
  /\b(read|open|inspect|review|scan|grep|search|find|cat|ls|sed|rg)\b/;
const PI_FILE_ANALYSIS_PATH_PATTERN = /\/[A-Za-z0-9_.~-]+\.[a-z]{1,5}(?=$|[\s"'`])/;
const PI_FILE_ANALYSIS_PREFIX_PATTERN = /^\s*(read|analyze|review)\b/i;
const CODEX_DEFAULT_MODEL = "gpt-5.4";
const CODEX_ALLOWED_MODELS = new Set([
  "gpt-5.4",
]);

function taskRequiresFileAccess(task: string): boolean {
  const normalizedTask = task.toLowerCase();

  return (
    PI_FILE_HINT_PATTERN.test(task) ||
    FILE_PATH_PATTERN.test(task) ||
    (FILE_CONTEXT_PATTERN.test(normalizedTask) &&
      FILE_READ_OPERATION_PATTERN.test(normalizedTask))
  );
}

function taskIsIncompatibleWithPiNoTools(task: string): boolean {
  return (
    PI_FILE_ANALYSIS_PATH_PATTERN.test(task) ||
    PI_FILE_ANALYSIS_PREFIX_PATTERN.test(task)
  );
}

function resolveCodexModel(model?: string): string {
  const requestedModel = model?.trim();
  if (!requestedModel) {
    return CODEX_DEFAULT_MODEL;
  }

  if (CODEX_ALLOWED_MODELS.has(requestedModel)) {
    return requestedModel;
  }

  console.warn(
    `[agent-dispatch] Unsupported codex model "${requestedModel}" requested; ` +
      `overriding to "${CODEX_DEFAULT_MODEL}" for ChatGPT account compatibility.`
  );
  return CODEX_DEFAULT_MODEL;
}

function writeInboxSnapshot(result: InboxResult): string {
  mkdirSync(INBOX_DIR, { recursive: true });
  const filePath = join(INBOX_DIR, `${result.requestId}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

async function runAgentCommand(
  command: string,
  options: {
    cwd: string;
    timeoutSeconds: number;
    env: Record<string, string | undefined>;
    requestId: string;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string; cancelled?: boolean }> {
  const proc = Bun.spawn(["bash", "-lc", `exec ${command}`], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
  });

  // Register for cancellation
  activeProcesses.set(options.requestId, { kill: () => proc.kill() });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, Math.max(1, options.timeoutSeconds) * 1000);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);
  activeProcesses.delete(options.requestId);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

type AgentExecutionResult = {
  status: "completed" | "failed";
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
  artifacts?: ExecutionArtifacts;
};

type AgentExecutionInput = {
  requestId: string;
  task: string;
  tool: "codex" | "claude" | "pi";
  agent?: string;
  workDir: string;
  timeoutSeconds: number;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readFiles?: boolean;
};

function toSandboxProfile(
  sandbox?: "read-only" | "workspace-write" | "danger-full-access",
): "workspace-write" | "danger-full-access" {
  return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";
}

async function resolveSandboxRepoContext(workDir: string, providedBaseSha?: string): Promise<{
  repoRoot: string;
  baseSha: string;
  branch: string;
}> {
  const repoRoot = (await Bun.$`git -C ${workDir} rev-parse --show-toplevel`.text()).trim();
  if (!repoRoot) {
    throw new Error(`failed to resolve repo root from ${workDir}`);
  }

  const baseSha = (providedBaseSha?.trim() || (await Bun.$`git -C ${repoRoot} rev-parse HEAD`.text()).trim());
  if (!baseSha) {
    throw new Error(`failed to resolve base SHA from ${repoRoot}`);
  }

  const branchRaw = (await Bun.$`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.text()).trim();
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : "main";

  return { repoRoot, baseSha, branch };
}

function buildSandboxTask(
  task: string,
  options: {
    repoPath: string;
    requestedCwd: string;
    baseSha: string;
    workflowId?: string;
    storyId?: string;
  },
): string {
  const lines = [
    "You are executing inside an isolated sandbox checkout.",
    `Sandbox checkout path: ${options.repoPath}`,
    `Original requested cwd: ${options.requestedCwd}`,
    `Sandbox base SHA: ${options.baseSha}`,
    "Do not reference or mutate the host checkout path directly. Work only inside the sandbox checkout path above.",
  ];

  if (options.workflowId) {
    lines.push(`Workflow ID: ${options.workflowId}`);
  }
  if (options.storyId) {
    lines.push(`Story ID: ${options.storyId}`);
  }

  lines.push("", task);
  return lines.join("\n");
}

async function getSandboxTouchedFiles(repoPath: string, baseSha: string): Promise<string[]> {
  try {
    const headSha = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.text()).trim();
    if (headSha && headSha !== baseSha) {
      const committed = (await Bun.$`git -C ${repoPath} diff --name-only ${baseSha}..${headSha}`.text())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (committed.length > 0) {
        return [...new Set(committed)].sort();
      }
    }
  } catch {
    // fall back to working tree status below
  }

  return getTouchedFiles(repoPath);
}

async function executeAgentTask(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const {
    requestId,
    task,
    tool,
    agent,
    workDir,
    timeoutSeconds,
    model,
    sandbox,
    readFiles = false,
  } = input;

  if (tool === "claude") {
    try {
      const lease = execSync("secrets lease claude_oauth_token --ttl 1h", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (lease) process.env.CLAUDE_CODE_OAUTH_TOKEN = lease;
    } catch {
      // Fall through to existing env var
    }
  }

  const piNeedsTools = tool === "pi" && (
    readFiles ||
    taskRequiresFileAccess(task) ||
    taskIsIncompatibleWithPiNoTools(task)
  );
  const sharedEnv = {
    ...process.env,
    CI: "true",
    TERM: "dumb",
    JOELCLAW_SANDBOX_EXECUTION: workDir.includes(`${tmpdir()}/`) ? "true" : "false",
  };

  try {
    if (tool === "pi") {
      const resolvedAgent = typeof agent === "string" ? agent.trim() : "";
      const result = await infer(task, {
        task: "complex",
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
        model,
        ...(resolvedAgent ? {} : { system: "Analyze and respond." }),
        component: "agent-dispatch",
        action: "agent-dispatch.pi",
        print: true,
        noTools: !piNeedsTools,
        timeout: timeoutSeconds * 1000,
        json: false,
        env: sharedEnv,
        cwd: workDir,
        requestId,
        metadata: {
          executionPath: workDir,
        },
      });

      const textOutput = result.text.trim();
      return {
        status: "completed",
        output: textOutput.slice(-50_000),
        stdout: textOutput.slice(-10_000),
        stderr: "",
      };
    }

    const cmd = buildCommand(tool, task, {
      model,
      sandbox,
      timeout: timeoutSeconds,
      allowPiTools: piNeedsTools,
    });
    const commandResult = await runAgentCommand(cmd, {
      cwd: workDir,
      timeoutSeconds,
      env: sharedEnv,
      requestId,
    });

    if (commandResult.exitCode !== 0) {
      return {
        status: "failed",
        output: commandResult.stdout.slice(-10_000),
        stdout: commandResult.stdout.slice(-10_000),
        stderr: commandResult.stderr.slice(-10_000),
        error: `Exit ${commandResult.exitCode}: ${commandResult.stderr.slice(-5_000) || commandResult.stdout.slice(-5_000) || "command failed"}`,
      };
    }

    return {
      status: "completed",
      output: commandResult.stdout.slice(-50_000),
      stdout: commandResult.stdout.slice(-10_000),
      stderr: commandResult.stderr.slice(-10_000),
    };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "failed",
      output: "",
      stdout: "",
      stderr: message.slice(-5_000),
      error: `agent dispatch crashed: ${message.slice(-5_000)}`,
    };
  }
}

async function executeSandboxAgent(input: AgentExecutionInput & {
  requestedCwd: string;
  baseSha?: string;
  workflowId?: string;
  storyId?: string;
}): Promise<AgentExecutionResult> {
  const workspaceDir = await mkdtemp(join(tmpdir(), `joelclaw-sandbox-${input.requestId}-`));
  const repoPath = join(workspaceDir, "repo");

  try {
    const { repoRoot, baseSha, branch } = await resolveSandboxRepoContext(
      input.requestedCwd,
      input.baseSha,
    );

    await materializeRepo(repoPath, baseSha, {
      remoteUrl: repoRoot,
      branch,
      depth: 50,
      timeoutSeconds: Math.max(60, Math.min(input.timeoutSeconds, 300)),
    });

    const execution = await executeAgentTask({
      ...input,
      sandbox: toSandboxProfile(input.sandbox),
      task: buildSandboxTask(input.task, {
        repoPath,
        requestedCwd: input.requestedCwd,
        baseSha,
        workflowId: input.workflowId,
        storyId: input.storyId,
      }),
      workDir: repoPath,
    });

    try {
      const artifacts = await generatePatchArtifact({
        repoPath,
        baseSha,
        includeUntracked: true,
        timeoutSeconds: Math.max(30, Math.min(input.timeoutSeconds, 120)),
      });
      const touchedFiles = await getSandboxTouchedFiles(repoPath, baseSha);
      const logs = execution.stdout || execution.stderr
        ? {
            ...(artifacts.logs ?? {}),
            stdout: execution.stdout || "",
            stderr: execution.stderr || "",
          }
        : artifacts.logs;

      return {
        ...execution,
        artifacts: {
          ...artifacts,
          touchedFiles,
          ...(logs ? { logs } : {}),
        },
      };
    } catch (artifactError) {
      if (execution.status === "failed") {
        return execution;
      }

      const message = artifactError instanceof Error ? artifactError.message : String(artifactError);
      return {
        status: "failed",
        output: execution.output,
        stdout: execution.stdout,
        stderr: [execution.stderr, `sandbox artifact generation failed: ${message}`]
          .filter(Boolean)
          .join("\n"),
        error: `sandbox artifact generation failed: ${message}`,
      };
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * ADR-0026: Background agent dispatch via Inngest.
 *
 * Spawns codex, claude, or pi to execute a task. Writes result to
 * inbox file for pickup by pi-tools extension. Emits completion event
 * for chaining.
 *
 * Durable (survives restarts), observable (Inngest trace), cross-session
 * (results land in inbox regardless of which session is active).
 *
 * Handles deduplication by requestId - if a terminal result already exists,
 * returns that result instead of spawning a new execution.
 */
export const agentDispatch = inngest.createFunction(
  {
    id: "system/agent-dispatch",
    name: "Background Agent Dispatch",
    retries: 1,
    cancelOn: [{ event: "system/agent.cancelled", match: "data.requestId" }],
    throttle: { limit: 3, period: "60s" },
    onFailure: async ({ event, error, step }) => {
      const {
        requestId,
        sessionId,
        task,
        tool,
        agent,
        executionMode = "host",
      } = event.data.event.data;

      // Kill any active process for this requestId
      const activeProc = activeProcesses.get(requestId);
      if (activeProc) {
        try {
          activeProc.kill();
          activeProcesses.delete(requestId);
        } catch {
          // Process may already be dead
        }
      }

      // Check if this is a cancellation
      const isCancellation = error.message?.includes("cancelled") || error.name === "FunctionCancelledError";

      if (isCancellation) {
        // Write cancelled snapshot
        await step.run("write-cancelled-inbox", async () => {
          const completedAt = new Date().toISOString();
          const startedAt = new Date(Date.now() - 1000).toISOString(); // Approximate start

          const result: InboxResult = {
            requestId,
            sessionId,
            status: "cancelled",
            task,
            tool,
            ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
            error: "Execution cancelled",
            startedAt,
            updatedAt: completedAt,
            completedAt,
            durationMs: Date.now() - new Date(startedAt).getTime(),
            executionMode,
          };

          writeInboxSnapshot(result);
        });
      }
    },
  },
  { event: "system/agent.requested" },
  async ({ event, step }) => {
    const {
      requestId,
      workflowId,
      storyId,
      baseSha,
      sessionId,
      task,
      tool,
      agent,
      cwd,
      timeout = 600,
      model,
      sandbox,
      executionMode = "host",
      readFiles = false,
    } = event.data;

    if (!requestId || !task || !tool) {
      throw new NonRetriableError(
        "Missing required fields: requestId, task, tool"
      );
    }

    if (!["codex", "claude", "pi"].includes(tool)) {
      throw new NonRetriableError(
        `Unknown tool: ${tool}. Must be codex, claude, or pi.`
      );
    }

    const startedAt = new Date().toISOString();

    // Deduplication: check if we already have a terminal result for this requestId
    const dedupe = await step.run("check-existing-result", async () => {
      const existingPath = join(INBOX_DIR, `${requestId}.json`);
      try {
        const content = await Bun.file(existingPath).text();
        const existing = JSON.parse(content) as InboxResult;
        const status = existing.status;
        
        if (status === "completed" || status === "failed") {
          return { shouldDedupe: true, existing };
        }
        
        // Check for cancelled state (extended type not in InboxResult)
        if ((existing as any).status === "cancelled") {
          return { shouldDedupe: true, existing };
        }
        
        return { shouldDedupe: false, existing: null };
      } catch {
        return { shouldDedupe: false, existing: null };
      }
    });

    if (dedupe.shouldDedupe && dedupe.existing) {
      return {
        requestId,
        status: dedupe.existing.status,
        inboxFile: join(INBOX_DIR, `${requestId}.json`),
        durationMs: dedupe.existing.durationMs ?? 0,
        deduped: true,
      };
    }

    const runningSnapshot = await step.run("write-running-inbox", async () => {
      const runningResult: InboxResult = {
        requestId,
        sessionId,
        status: "running",
        task,
        tool,
        ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
        startedAt,
        updatedAt: startedAt,
        executionMode,
      };

      const filePath = writeInboxSnapshot(runningResult);
      return { filePath, status: runningResult.status, startedAt: runningResult.startedAt };
    });

    const execution = await step.run("execute-agent", async () => {
      const requestedCwd = cwd || process.env.HOME || "/Users/joel";
      const executionInput = {
        requestId,
        task,
        tool,
        agent,
        workDir: requestedCwd,
        timeoutSeconds: timeout,
        model,
        sandbox,
        readFiles,
      } as const;

      if (executionMode === "sandbox") {
        return executeSandboxAgent({
          ...executionInput,
          requestedCwd,
          baseSha,
          workflowId,
          storyId,
        });
      }

      return executeAgentTask(executionInput);
    });

    // Write to inbox
    const inboxResult = await step.run("write-inbox", async () => {
      const completedAt = new Date().toISOString();
      const effectiveStartedAt = runningSnapshot.startedAt ?? startedAt;
      const durationMs =
        new Date(completedAt).getTime() - new Date(effectiveStartedAt).getTime();

      const result: InboxResult = {
        requestId,
        sessionId,
        status: execution.status,
        task,
        tool,
        ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
        ...(execution.status === "completed"
          ? { result: execution.output }
          : { error: execution.error }),
        startedAt: effectiveStartedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs,
        executionMode,
        ...(execution.artifacts ? { artifacts: execution.artifacts } : {}),
        ...(execution.stdout || execution.stderr
          ? {
              logs: {
                ...(execution.artifacts?.logs ?? {}),
                stdout: execution.stdout || execution.artifacts?.logs?.stdout || "",
                stderr: execution.stderr || execution.artifacts?.logs?.stderr || "",
              },
            }
          : execution.artifacts?.logs
            ? { logs: execution.artifacts.logs }
            : {}),
      };

      const filePath = writeInboxSnapshot(result);
      const completionStatus = execution.status;

      return { filePath, status: completionStatus, durationMs };
    });

    // Emit completion event for chaining
    await step.sendEvent("notify-completion", {
      name: "system/agent.completed",
      data: {
        requestId,
        sessionId,
        status: inboxResult.status,
        task,
        tool,
        ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
        durationMs: inboxResult.durationMs,
      },
    });

    return {
      requestId,
      status: inboxResult.status,
      inboxFile: inboxResult.filePath,
      durationMs: inboxResult.durationMs,
    };
  }
);

/**
 * Build the CLI command for each tool.
 */
function buildCommand(
  tool: string,
  task: string,
  opts: {
    model?: string;
    sandbox?: string;
    timeout?: number;
    allowPiTools?: boolean;
  }
): string {
  // Escape task for shell — single-quote with escaped single-quotes
  const escaped = task.replace(/'/g, "'\\''");

  switch (tool) {
    case "codex": {
      const codexModel = resolveCodexModel(opts.model);
      return [
        "codex exec",
        "--full-auto",
        `-m ${codexModel}`,
        opts.sandbox ? `-s ${opts.sandbox}` : "",
        `'${escaped}'`,
      ]
        .filter(Boolean)
        .join(" ");
    }

    case "claude":
      return [
        "claude",
        "-p",
        `'${escaped}'`,
        "--dangerously-skip-permissions",
        opts.model ? `--model ${opts.model}` : "",
      ]
        .filter(Boolean)
        .join(" ");

    case "pi":
      return [
        "pi",
        ...(opts.allowPiTools ? [] : ["--no-tools"]),
        "--no-session",
        "--print",
        "--mode json",
        opts.model ? `--model ${opts.model}` : "",
        `--system-prompt '${escaped}'`,
        `'Analyze and respond.'`,
      ]
        .filter(Boolean)
        .join(" ");

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
