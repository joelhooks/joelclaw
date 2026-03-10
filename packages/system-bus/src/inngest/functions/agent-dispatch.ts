import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  cancelSandboxJob,
  type ExecutionArtifacts,
  ensureLocalSandboxLayout,
  extractSandboxResultFromLogs,
  generateLocalSandboxIdentity,
  generatePatchArtifact,
  getTouchedFiles,
  type InboxResult,
  type LocalSandboxIdentity,
  type LocalSandboxMode,
  type LocalSandboxPaths,
  type LocalSandboxRuntimeInfo,
  launchSandboxJob,
  materializeLocalSandboxEnv,
  materializeRepo,
  pruneExpiredLocalSandboxes,
  readSandboxJobLogs,
  readSandboxJobStatus,
  resolveLocalSandboxPaths,
  resolveLocalSandboxRetention,
  type SandboxBackend,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxJobRef,
  upsertLocalSandboxRegistryEntry,
  writeArtifactBundle,
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
const SANDBOX_BACKEND_DEFAULT = (
  process.env.SANDBOX_RUNNER_BACKEND?.trim().toLowerCase() === "k8s" ? "k8s" : "local"
) as SandboxBackend;
const SANDBOX_K8S_NAMESPACE = process.env.SANDBOX_K8S_NAMESPACE?.trim() || "joelclaw";
const SANDBOX_K8S_IMAGE = process.env.SANDBOX_K8S_IMAGE?.trim() || "ghcr.io/joelhooks/agent-runner:latest";
const SANDBOX_K8S_IMAGE_PULL_SECRET = process.env.SANDBOX_K8S_IMAGE_PULL_SECRET?.trim() || "ghcr-pull";
const SANDBOX_K8S_SERVICE_ACCOUNT = process.env.SANDBOX_K8S_SERVICE_ACCOUNT?.trim() || "default";
const SANDBOX_RESULT_CALLBACK_URL = process.env.SANDBOX_RESULT_CALLBACK_URL?.trim() || "http://host.docker.internal:3111/internal/agent-result";
const INTERNAL_RESULT_TOKEN = process.env.OTEL_EMIT_TOKEN?.trim();

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
  status: "completed" | "failed" | "cancelled";
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
  artifacts?: ExecutionArtifacts;
  sandboxBackend?: SandboxBackend;
  job?: SandboxJobRef;
  localSandbox?: LocalSandboxRuntimeInfo;
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
  extraEnv?: Record<string, string | undefined>;
};

type PreparedLocalSandboxContext = {
  identity: LocalSandboxIdentity;
  paths: LocalSandboxPaths;
  runtimeInfo: LocalSandboxRuntimeInfo;
  requestedCwd: string;
  workDir: string;
  composeFiles: string[];
  repoRoot: string;
  baseSha: string;
  branch: string;
  repoUrl?: string;
  mode: LocalSandboxMode;
};

const LOCAL_SANDBOX_COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

function toSandboxProfile(
  sandbox?: "read-only" | "workspace-write" | "danger-full-access",
): "workspace-write" | "danger-full-access" {
  return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";
}

async function resolveSandboxRepoContext(workDir: string, providedBaseSha?: string): Promise<{
  repoRoot: string;
  baseSha: string;
  branch: string;
  repoUrl?: string;
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

  const repoUrl = await Bun.$`git -C ${repoRoot} remote get-url origin`
    .text()
    .then((value) => value.trim())
    .catch(() => undefined);

  return { repoRoot, baseSha, branch, repoUrl };
}

function resolveLocalSandboxWorkDir(
  repoRoot: string,
  requestedCwd: string,
  sandboxRepoDir: string,
): string {
  const relativeRequested = relative(repoRoot, requestedCwd);

  if (
    relativeRequested === "" ||
    relativeRequested === "."
  ) {
    return sandboxRepoDir;
  }

  if (relativeRequested.startsWith("..") || relativeRequested.split(/[\\/]/).includes("..")) {
    throw new Error(`requested cwd ${requestedCwd} is outside repo root ${repoRoot}`);
  }

  return join(sandboxRepoDir, relativeRequested);
}

async function discoverLocalSandboxComposeFiles(
  requestedCwd: string,
  repoRoot: string,
  sandboxRepoDir: string,
): Promise<string[]> {
  let currentDir = requestedCwd;

  while (currentDir.startsWith(repoRoot)) {
    const discovered: string[] = [];
    const relativeDir = relative(repoRoot, currentDir);
    const sandboxDir = relativeDir === "" ? sandboxRepoDir : join(sandboxRepoDir, relativeDir);

    for (const fileName of LOCAL_SANDBOX_COMPOSE_FILE_NAMES) {
      const candidate = join(currentDir, fileName);
      if (await Bun.file(candidate).exists()) {
        discovered.push(join(sandboxDir, fileName));
      }
    }

    if (discovered.length > 0) {
      return discovered.sort();
    }

    if (currentDir === repoRoot) {
      break;
    }

    const parent = dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  return [];
}

async function prepareLocalSandboxContext(options: {
  requestId: string;
  workflowId?: string;
  storyId?: string;
  requestedCwd: string;
  baseSha?: string;
  mode?: LocalSandboxMode;
}): Promise<PreparedLocalSandboxContext> {
  const repoContext = await resolveSandboxRepoContext(options.requestedCwd, options.baseSha);
  const identity = generateLocalSandboxIdentity({
    workflowId: options.workflowId ?? `sandbox-${options.requestId}`,
    requestId: options.requestId,
    storyId: options.storyId ?? options.requestId,
  });
  const paths = resolveLocalSandboxPaths(identity);
  const mode = options.mode ?? "minimal";
  const workDir = resolveLocalSandboxWorkDir(repoContext.repoRoot, options.requestedCwd, paths.repoDir);
  const composeFiles = mode === "full"
    ? await discoverLocalSandboxComposeFiles(options.requestedCwd, repoContext.repoRoot, paths.repoDir)
    : [];

  return {
    identity,
    paths,
    runtimeInfo: {
      sandboxId: identity.sandboxId,
      slug: identity.slug,
      composeProjectName: identity.composeProjectName,
      mode,
      path: paths.sandboxDir,
      repoPath: paths.repoDir,
      workDir,
      envPath: paths.envPath,
      metadataPath: paths.metadataPath,
      devcontainerPath: join(workDir, ".devcontainer"),
      ...(composeFiles.length > 0 ? { composeFiles } : {}),
      registryPath: paths.registryPath,
    },
    requestedCwd: options.requestedCwd,
    workDir,
    composeFiles,
    repoRoot: repoContext.repoRoot,
    baseSha: repoContext.baseSha,
    branch: repoContext.branch,
    repoUrl: repoContext.repoUrl,
    mode,
  };
}

async function syncLocalSandboxState(options: {
  context: PreparedLocalSandboxContext;
  state: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  teardownState?: "active" | "tearing-down" | "removed";
}): Promise<{ cleanupAfter?: string }> {
  const retention = resolveLocalSandboxRetention({
    state: options.state,
    updatedAt: options.updatedAt,
  });

  await upsertLocalSandboxRegistryEntry(
    {
      sandboxId: options.context.identity.sandboxId,
      requestId: options.context.identity.requestId,
      workflowId: options.context.identity.workflowId,
      storyId: options.context.identity.storyId,
      slug: options.context.identity.slug,
      composeProjectName: options.context.identity.composeProjectName,
      mode: options.context.mode,
      baseSha: options.context.baseSha,
      path: options.context.paths.sandboxDir,
      repoPath: options.context.paths.repoDir,
      envPath: options.context.paths.envPath,
      metadataPath: options.context.paths.metadataPath,
      state: options.state,
      backend: "local",
      createdAt: options.startedAt,
      updatedAt: options.updatedAt,
      teardownState: options.teardownState ?? "active",
      retentionPolicy: retention.policy,
      cleanupAfter: retention.cleanupAfter,
      cleanupReason: retention.reason,
      devcontainerStrategy: "copy",
    },
    options.context.paths.registryPath,
  );

  await Bun.write(
    options.context.paths.metadataPath,
    `${JSON.stringify(
      {
        sandbox: {
          ...options.context.runtimeInfo,
          cleanupAfter: retention.cleanupAfter,
        },
        repoRoot: options.context.repoRoot,
        baseSha: options.context.baseSha,
        branch: options.context.branch,
        state: options.state,
        startedAt: options.startedAt,
        updatedAt: options.updatedAt,
        teardownState: options.teardownState ?? "active",
        retention,
      },
      null,
      2,
    )}\n`,
  );

  return {
    cleanupAfter: retention.cleanupAfter,
  };
}

function buildSandboxTask(
  task: string,
  options: {
    repoPath: string;
    workDir: string;
    requestedCwd: string;
    baseSha: string;
    workflowId?: string;
    storyId?: string;
  },
): string {
  const lines = [
    "You are executing inside an isolated sandbox checkout.",
    `Sandbox checkout path: ${options.repoPath}`,
    `Sandbox execution cwd: ${options.workDir}`,
    `Original requested cwd: ${options.requestedCwd}`,
    `Sandbox base SHA: ${options.baseSha}`,
    "Do not reference or mutate the host checkout path directly. Work only inside the sandbox checkout path above.",
    `Use ${options.workDir} as the effective working directory unless the task explicitly says otherwise.`,
    "Do not trigger nested workflow-rig execution from inside this sandbox.",
    "Specifically: do not run `joelclaw workload run`, do not run `scripts/verify-workload-full-mode.ts`, and do not spawn another workload canary from inside this stage.",
    "If proof is required, use direct local commands in this sandbox and return the evidence directly instead of starting another workload.",
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
    extraEnv,
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
    ...(extraEnv ?? {}),
    CI: "true",
    TERM: "dumb",
    JOELCLAW_SANDBOX_EXECUTION:
      workDir.includes(`${tmpdir()}/`) || workDir.includes(`${join(process.env.HOME || "/Users/joel", ".joelclaw", "sandboxes")}/`)
        ? "true"
        : "false",
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

async function runSandboxInfraCommand(options: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  env: Record<string, string | undefined>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-lc", `exec ${options.command}`], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  });

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

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function buildDockerComposeCommand(composeFiles: string[], composeProjectName: string, subcommand: string): string {
  const args = composeFiles.map((file) => `-f '${file.replace(/'/g, `'\\''`)}'`).join(" ");
  return `docker compose ${args} -p '${composeProjectName.replace(/'/g, `'\\''`)}' ${subcommand}`;
}

async function ensureLocalSandboxFullModeRuntime(
  context: PreparedLocalSandboxContext,
  timeoutSeconds: number,
): Promise<void> {
  if (context.mode !== "full") {
    return;
  }

  if (context.composeFiles.length === 0) {
    throw new Error(
      `local full sandbox mode requires a compose file under ${context.workDir} or its repo ancestors`,
    );
  }

  const composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: context.identity.composeProjectName,
    JOELCLAW_SANDBOX_ID: context.identity.sandboxId,
    JOELCLAW_SANDBOX_MODE: context.mode,
  };

  const commandResult = await runSandboxInfraCommand({
    command: buildDockerComposeCommand(
      context.composeFiles,
      context.identity.composeProjectName,
      "up -d --wait --remove-orphans",
    ),
    cwd: context.workDir,
    timeoutSeconds: Math.max(60, Math.min(timeoutSeconds, 180)),
    env: composeEnv,
  });

  if (commandResult.exitCode !== 0) {
    throw new Error(
      `failed to start full local sandbox runtime: ${commandResult.stderr || commandResult.stdout || "docker compose up failed"}`,
    );
  }
}

async function teardownLocalSandboxFullModeRuntime(
  context: PreparedLocalSandboxContext,
  timeoutSeconds: number,
): Promise<string | undefined> {
  if (context.mode !== "full" || context.composeFiles.length === 0) {
    return undefined;
  }

  const composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: context.identity.composeProjectName,
    JOELCLAW_SANDBOX_ID: context.identity.sandboxId,
    JOELCLAW_SANDBOX_MODE: context.mode,
  };

  const commandResult = await runSandboxInfraCommand({
    command: buildDockerComposeCommand(
      context.composeFiles,
      context.identity.composeProjectName,
      "down --remove-orphans --volumes",
    ),
    cwd: context.workDir,
    timeoutSeconds: Math.max(60, Math.min(timeoutSeconds, 180)),
    env: composeEnv,
  });

  if (commandResult.exitCode === 0) {
    return undefined;
  }

  return commandResult.stderr || commandResult.stdout || "docker compose down failed";
}

async function executeSandboxAgent(input: AgentExecutionInput & {
  requestedCwd: string;
  workflowId?: string;
  storyId?: string;
  localSandbox: PreparedLocalSandboxContext;
}): Promise<AgentExecutionResult> {
  const { localSandbox } = input;
  const repoPath = localSandbox.paths.repoDir;

  await materializeRepo(repoPath, localSandbox.baseSha, {
    remoteUrl: localSandbox.repoRoot,
    branch: localSandbox.branch,
    depth: 50,
    timeoutSeconds: Math.max(60, Math.min(input.timeoutSeconds, 300)),
  });

  let runtimeTeardownError: string | undefined;

  const execution = await (async () => {
    try {
      await ensureLocalSandboxFullModeRuntime(localSandbox, input.timeoutSeconds);

      return await executeAgentTask({
        ...input,
        sandbox: toSandboxProfile(input.sandbox),
        task: buildSandboxTask(input.task, {
          repoPath,
          workDir: localSandbox.workDir,
          requestedCwd: input.requestedCwd,
          baseSha: localSandbox.baseSha,
          workflowId: input.workflowId,
          storyId: input.storyId,
        }),
        workDir: localSandbox.workDir,
        extraEnv: {
          JOELCLAW_SANDBOX_ID: localSandbox.identity.sandboxId,
          JOELCLAW_SANDBOX_SLUG: localSandbox.identity.slug,
          JOELCLAW_SANDBOX_MODE: localSandbox.mode,
          JOELCLAW_SANDBOX_REQUEST_ID: localSandbox.identity.requestId,
          JOELCLAW_SANDBOX_WORKFLOW_ID: localSandbox.identity.workflowId,
          JOELCLAW_SANDBOX_STORY_ID: localSandbox.identity.storyId,
          JOELCLAW_SANDBOX_BASE_SHA: localSandbox.baseSha,
          JOELCLAW_SANDBOX_REQUESTED_CWD: input.requestedCwd,
          JOELCLAW_SANDBOX_REPO_ROOT: localSandbox.repoRoot,
          COMPOSE_PROJECT_NAME: localSandbox.identity.composeProjectName,
        },
      });
    } finally {
      runtimeTeardownError = await teardownLocalSandboxFullModeRuntime(
        localSandbox,
        input.timeoutSeconds,
      );
    }
  })();

  try {
    const artifacts = await generatePatchArtifact({
      repoPath,
      baseSha: localSandbox.baseSha,
      includeUntracked: true,
      timeoutSeconds: Math.max(30, Math.min(input.timeoutSeconds, 120)),
    });
    const touchedFiles = await getSandboxTouchedFiles(repoPath, localSandbox.baseSha);
    const stderrOutput = [
      execution.stderr || "",
      runtimeTeardownError ? `sandbox full-mode teardown failed: ${runtimeTeardownError}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const logs = execution.stdout || stderrOutput
      ? {
          ...(artifacts.logs ?? {}),
          stdout: execution.stdout || "",
          stderr: stderrOutput,
        }
      : artifacts.logs;
    const nextArtifacts = {
      ...artifacts,
      touchedFiles,
      ...(logs ? { logs } : {}),
    };

    await writeArtifactBundle(nextArtifacts, join(localSandbox.paths.artifactsDir, "artifacts.json"));

    return {
      ...execution,
      stderr: stderrOutput,
      ...(runtimeTeardownError && execution.error
        ? {
            error: `${execution.error}\nsandbox full-mode teardown failed: ${runtimeTeardownError}`,
          }
        : {}),
      sandboxBackend: "local",
      localSandbox: localSandbox.runtimeInfo,
      artifacts: nextArtifacts,
    };
  } catch (artifactError) {
    if (execution.status === "failed") {
      return {
        ...execution,
        stderr: [
          execution.stderr,
          runtimeTeardownError ? `sandbox full-mode teardown failed: ${runtimeTeardownError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        error:
          runtimeTeardownError && execution.error
            ? `${execution.error}\nsandbox full-mode teardown failed: ${runtimeTeardownError}`
            : execution.error,
        sandboxBackend: "local",
        localSandbox: localSandbox.runtimeInfo,
      };
    }

    const message = artifactError instanceof Error ? artifactError.message : String(artifactError);
    return {
      status: "failed",
      output: execution.output,
      stdout: execution.stdout,
      stderr: [
        execution.stderr,
        `sandbox artifact generation failed: ${message}`,
        runtimeTeardownError ? `sandbox full-mode teardown failed: ${runtimeTeardownError}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      error: `sandbox artifact generation failed: ${message}`,
      sandboxBackend: "local",
      localSandbox: localSandbox.runtimeInfo,
    };
  }
}

async function leaseSecretValue(secretName: string, ttl = "1h"): Promise<string | undefined> {
  const proc = Bun.spawn(["secrets", "lease", secretName, "--ttl", ttl], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    console.warn(`[agent-dispatch] failed to lease ${secretName}: ${stderr.trim() || stdout.trim()}`);
    return undefined;
  }

  const value = stdout.trim();
  return value.length > 0 ? value : undefined;
}

async function readInboxResultSnapshot(requestId: string): Promise<InboxResult | null> {
  const filePath = join(INBOX_DIR, `${requestId}.json`);
  try {
    const raw = await Bun.file(filePath).text();
    return JSON.parse(raw) as InboxResult;
  } catch {
    return null;
  }
}

function inboxResultToExecution(result: InboxResult): AgentExecutionResult | null {
  if (result.status === "running") return null;

  return {
    status:
      result.status === "completed"
        ? "completed"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed",
    output: (result.result || result.logs?.stdout || "").slice(-50_000),
    stdout: (result.logs?.stdout || result.result || "").slice(-10_000),
    stderr: (result.logs?.stderr || result.error || "").slice(-10_000),
    ...(result.error ? { error: result.error } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.sandboxBackend ? { sandboxBackend: result.sandboxBackend } : {}),
    ...(result.job ? { job: result.job } : {}),
    ...(result.localSandbox ? { localSandbox: result.localSandbox } : {}),
  };
}

function sandboxResultToExecution(
  result: SandboxExecutionResult,
  logsText?: string,
): AgentExecutionResult {
  return {
    status:
      result.state === "completed"
        ? "completed"
        : result.state === "cancelled"
          ? "cancelled"
          : "failed",
    output: (result.output || result.artifacts?.logs?.stdout || logsText || "").slice(-50_000),
    stdout: (result.artifacts?.logs?.stdout || result.output || "").slice(-10_000),
    stderr: (result.artifacts?.logs?.stderr || logsText || result.error || "").slice(-10_000),
    ...(result.error ? { error: result.error } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.backend ? { sandboxBackend: result.backend } : {}),
    ...(result.job ? { job: result.job } : {}),
  };
}

async function executeK8sSandboxAgent(input: AgentExecutionInput & {
  requestedCwd: string;
  baseSha?: string;
  workflowId?: string;
  storyId?: string;
}): Promise<AgentExecutionResult> {
  const { repoRoot, baseSha, branch, repoUrl } = await resolveSandboxRepoContext(
    input.requestedCwd,
    input.baseSha,
  );

  if (!repoUrl) {
    return {
      status: "failed",
      output: "",
      stdout: "",
      stderr: "sandbox k8s runner requires a git remote URL for repo materialization",
      error: `sandbox k8s runner requires an origin remote for ${repoRoot}`,
      sandboxBackend: "k8s",
    };
  }

  const k8sRequest: SandboxExecutionRequest = {
    workflowId: input.workflowId ?? `sandbox-${input.requestId}`,
    requestId: input.requestId,
    storyId: input.storyId ?? input.requestId,
    task: input.task,
    agent: {
      name: (typeof input.agent === "string" && input.agent.trim()) || input.tool,
      ...(input.model ? { model: input.model } : {}),
      program: input.tool,
    },
    sandbox: toSandboxProfile(input.sandbox),
    baseSha,
    backend: "k8s",
    cwd: input.requestedCwd,
    repoUrl,
    branch,
    timeoutSeconds: input.timeoutSeconds,
  };

  const env: Record<string, string> = {};
  if (input.tool === "claude") {
    const token = await leaseSecretValue("claude_oauth_token", "1h");
    if (token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  }

  const launch = await launchSandboxJob(k8sRequest, {
    runtime: {
      image: SANDBOX_K8S_IMAGE,
      imagePullPolicy: "Always",
      command: ["bun", "run", "/app/packages/agent-execution/src/job-runner.ts"],
    },
    namespace: SANDBOX_K8S_NAMESPACE,
    imagePullSecret: SANDBOX_K8S_IMAGE_PULL_SECRET || undefined,
    serviceAccountName: SANDBOX_K8S_SERVICE_ACCOUNT || undefined,
    resultCallbackUrl: SANDBOX_RESULT_CALLBACK_URL,
    resultCallbackToken: INTERNAL_RESULT_TOKEN,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });

  activeProcesses.set(input.requestId, {
    kill: () => {
      void cancelSandboxJob(launch.job).catch((error) => {
        console.warn(
          `[agent-dispatch] failed to cancel sandbox Job ${launch.job.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  });

  const deadline = Date.now() + Math.max(60, input.timeoutSeconds) * 1000;

  try {
    while (Date.now() < deadline) {
      const inboxResult = await readInboxResultSnapshot(input.requestId);
      const executionFromInbox = inboxResult ? inboxResultToExecution(inboxResult) : null;
      if (executionFromInbox) {
        return {
          ...executionFromInbox,
          sandboxBackend: executionFromInbox.sandboxBackend ?? "k8s",
          job: executionFromInbox.job ?? launch.job,
        };
      }

      const status = await readSandboxJobStatus(launch.job).catch(() => null);
      if (status && (status.phase === "completed" || status.phase === "failed")) {
        const logsText = await readSandboxJobLogs(status.job).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          return `[agent-dispatch] failed to read Job logs: ${message}`;
        });
        const parsed = extractSandboxResultFromLogs(logsText);
        if (parsed) {
          return {
            ...sandboxResultToExecution(parsed, logsText),
            sandboxBackend: parsed.backend ?? "k8s",
            job: parsed.job ?? status.job,
          };
        }

        return {
          status: "failed",
          output: logsText.slice(-50_000),
          stdout: "",
          stderr: logsText.slice(-10_000),
          error:
            status.phase === "completed"
              ? "sandbox Job completed without reporting a terminal result"
              : status.message || status.reason || "sandbox Job failed",
          sandboxBackend: "k8s",
          job: status.job,
        };
      }

      await Bun.sleep(5_000);
    }

    await cancelSandboxJob(launch.job).catch(() => {});
    return {
      status: "failed",
      output: "",
      stdout: "",
      stderr: "sandbox k8s runner timed out waiting for terminal result",
      error: `sandbox k8s runner timed out after ${input.timeoutSeconds}s`,
      sandboxBackend: "k8s",
      job: launch.job,
    };
  } finally {
    activeProcesses.delete(input.requestId);
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
        sandboxBackend = SANDBOX_BACKEND_DEFAULT,
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
          const existing = await readInboxResultSnapshot(requestId);
          const startedAt = existing?.startedAt ?? new Date(Date.now() - 1000).toISOString();

          const localSandboxRetention = resolveLocalSandboxRetention({
            state: "cancelled",
            updatedAt: completedAt,
          });

          if (
            executionMode === "sandbox" &&
            sandboxBackend === "local" &&
            existing?.localSandbox
          ) {
            const localSandbox = existing.localSandbox;
            await upsertLocalSandboxRegistryEntry(
              {
                sandboxId: localSandbox.sandboxId,
                requestId,
                workflowId: event.data.event.data.workflowId ?? `sandbox-${requestId}`,
                storyId: event.data.event.data.storyId ?? requestId,
                slug: localSandbox.slug,
                composeProjectName: localSandbox.composeProjectName,
                mode: localSandbox.mode,
                baseSha: event.data.event.data.baseSha ?? "unknown",
                path: localSandbox.path,
                repoPath: localSandbox.repoPath,
                envPath: localSandbox.envPath,
                metadataPath: localSandbox.metadataPath,
                state: "cancelled",
                backend: "local",
                createdAt: startedAt,
                updatedAt: completedAt,
                teardownState: localSandbox.mode === "full" ? "removed" : "active",
                retentionPolicy: localSandboxRetention.policy,
                cleanupAfter: localSandboxRetention.cleanupAfter,
                cleanupReason: localSandboxRetention.reason,
                devcontainerStrategy: "copy",
              },
              localSandbox.registryPath,
            );
          }

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
            ...(executionMode === "sandbox" ? { sandboxBackend } : {}),
            ...(existing?.localSandbox
              ? {
                  localSandbox: {
                    ...existing.localSandbox,
                    cleanupAfter: localSandboxRetention.cleanupAfter,
                  },
                }
              : {}),
            ...(existing?.artifacts ? { artifacts: existing.artifacts } : {}),
            ...(existing?.logs ? { logs: existing.logs } : {}),
          };

          writeInboxSnapshot(result);
        });
        return;
      }

      await step.run("write-failed-inbox", async () => {
        const completedAt = new Date().toISOString();
        const existing = await readInboxResultSnapshot(requestId);
        const startedAt = existing?.startedAt ?? new Date(Date.now() - 1000).toISOString();
        const failureMessage = error instanceof Error ? error.message : String(error);

        const localSandboxRetention = resolveLocalSandboxRetention({
          state: "failed",
          updatedAt: completedAt,
        });

        if (
          executionMode === "sandbox" &&
          sandboxBackend === "local" &&
          existing?.localSandbox
        ) {
          const localSandbox = existing.localSandbox;
          await upsertLocalSandboxRegistryEntry(
            {
              sandboxId: localSandbox.sandboxId,
              requestId,
              workflowId: event.data.event.data.workflowId ?? `sandbox-${requestId}`,
              storyId: event.data.event.data.storyId ?? requestId,
              slug: localSandbox.slug,
              composeProjectName: localSandbox.composeProjectName,
              mode: localSandbox.mode,
              baseSha: event.data.event.data.baseSha ?? "unknown",
              path: localSandbox.path,
              repoPath: localSandbox.repoPath,
              envPath: localSandbox.envPath,
              metadataPath: localSandbox.metadataPath,
              state: "failed",
              backend: "local",
              createdAt: startedAt,
              updatedAt: completedAt,
              teardownState: localSandbox.mode === "full" ? "removed" : "active",
              retentionPolicy: localSandboxRetention.policy,
              cleanupAfter: localSandboxRetention.cleanupAfter,
              cleanupReason: localSandboxRetention.reason,
              devcontainerStrategy: "copy",
            },
            localSandbox.registryPath,
          );
        }

        const result: InboxResult = {
          requestId,
          sessionId,
          status: "failed",
          task,
          tool,
          ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
          error: failureMessage,
          startedAt,
          updatedAt: completedAt,
          completedAt,
          durationMs: Date.now() - new Date(startedAt).getTime(),
          executionMode,
          ...(executionMode === "sandbox" ? { sandboxBackend } : {}),
          ...(existing?.localSandbox
            ? {
                localSandbox: {
                  ...existing.localSandbox,
                  cleanupAfter: localSandboxRetention.cleanupAfter,
                },
              }
            : {}),
          ...(existing?.artifacts ? { artifacts: existing.artifacts } : {}),
          ...(existing?.logs ? { logs: existing.logs } : {}),
        };

        writeInboxSnapshot(result);
      });
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
      sandboxBackend = SANDBOX_BACKEND_DEFAULT,
      sandboxMode = "minimal",
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
    const requestedCwd = cwd || process.env.HOME || "/Users/joel";

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

    const localSandboxContext =
      executionMode === "sandbox" && sandboxBackend === "local"
        ? await step.run("resolve-local-sandbox-context", async () => {
            return prepareLocalSandboxContext({
              requestId,
              workflowId,
              storyId,
              requestedCwd,
              baseSha,
              mode: sandboxMode,
            });
          })
        : null;

    const runningSnapshot = await step.run("write-running-inbox", async () => {
      if (localSandboxContext) {
        await pruneExpiredLocalSandboxes({
          registryPath: localSandboxContext.paths.registryPath,
        });
        await ensureLocalSandboxLayout(localSandboxContext.paths);
        await materializeLocalSandboxEnv({
          path: localSandboxContext.paths.envPath,
          identity: localSandboxContext.identity,
          mode: localSandboxContext.mode,
          baseSha: localSandboxContext.baseSha,
          extra: {
            JOELCLAW_SANDBOX_REQUESTED_CWD: requestedCwd,
            JOELCLAW_SANDBOX_REPO_ROOT: localSandboxContext.repoRoot,
          },
        });
        await syncLocalSandboxState({
          context: localSandboxContext,
          state: "running",
          startedAt,
          updatedAt: startedAt,
        });
      }

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
        ...(executionMode === "sandbox" ? { sandboxBackend } : {}),
        ...(localSandboxContext ? { localSandbox: localSandboxContext.runtimeInfo } : {}),
      };

      const filePath = writeInboxSnapshot(runningResult);
      return {
        filePath,
        status: runningResult.status,
        startedAt: runningResult.startedAt,
        localSandbox: runningResult.localSandbox,
      };
    });

    const execution = await step.run("execute-agent", async () => {
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
        if (sandboxBackend === "k8s") {
          return executeK8sSandboxAgent({
            ...executionInput,
            requestedCwd,
            baseSha,
            workflowId,
            storyId,
          });
        }

        return executeSandboxAgent({
          ...executionInput,
          requestedCwd,
          workflowId,
          storyId,
          localSandbox: localSandboxContext ??
            (await prepareLocalSandboxContext({
              requestId,
              workflowId,
              storyId,
              requestedCwd,
              baseSha,
              mode: sandboxMode,
            })),
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
      let localSandbox = execution.localSandbox ?? runningSnapshot.localSandbox;

      if (localSandboxContext) {
        const synced = await syncLocalSandboxState({
          context: localSandboxContext,
          state: execution.status,
          startedAt: effectiveStartedAt,
          updatedAt: completedAt,
          teardownState: localSandboxContext.mode === "full" ? "removed" : "active",
        });
        localSandbox = {
          ...localSandboxContext.runtimeInfo,
          cleanupAfter: synced.cleanupAfter,
        };
      }

      const result: InboxResult = {
        requestId,
        sessionId,
        status: execution.status,
        task,
        tool,
        ...(typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : {}),
        ...(execution.status === "completed"
          ? { result: execution.output }
          : {
              error:
                execution.error ??
                (execution.status === "cancelled" ? "Execution cancelled" : "Execution failed"),
            }),
        startedAt: effectiveStartedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs,
        executionMode,
        ...(execution.sandboxBackend ? { sandboxBackend: execution.sandboxBackend } : {}),
        ...(execution.job ? { job: execution.job } : {}),
        ...(localSandbox ? { localSandbox } : {}),
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

      return { filePath, status: completionStatus, durationMs, localSandbox };
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
