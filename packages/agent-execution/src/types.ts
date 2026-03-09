/**
 * Canonical sandbox execution contract types.
 *
 * Shared between Restate workflows and system-bus Inngest functions.
 * All sandboxed story execution must use these types.
 */

/**
 * Execution mode for story execution.
 *
 * - "host": Execute on the shared host checkout (legacy path)
 * - "sandbox": Execute in an isolated runner (currently local sandbox, k8s Job runner next/optional)
 */
export type ExecutionMode = "host" | "sandbox";

/**
 * Concrete sandbox backend.
 *
 * - "local": Host-worker isolated temp checkout
 * - "k8s": Kubernetes Job runner
 */
export type SandboxBackend = "local" | "k8s";

/**
 * Sandbox profile defining isolation level and permissions.
 */
export type SandboxProfile = "workspace-write" | "danger-full-access";

/**
 * Lifecycle state of a sandboxed execution.
 */
export type ExecutionState = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Agent identity for tracking and observability.
 */
export interface AgentIdentity {
  /** Logical agent name (e.g. "story-executor", "codex", "claude", "pi") */
  name: string;
  /** Optional agent variant/instance identifier */
  variant?: string;
  /** Model used for this execution */
  model?: string;
  /** Program/CLI tool executing the agent */
  program?: string;
}

/**
 * Optional k8s Job reference for an isolated execution.
 */
export interface SandboxJobRef {
  /** k8s Job name */
  name: string;
  /** k8s namespace */
  namespace: string;
  /** Optional Pod name once scheduled */
  podName?: string;
}

/**
 * Local sandbox runtime metadata for host-worker isolation.
 */
export interface LocalSandboxRuntimeInfo {
  /** Deterministic sandbox identifier */
  sandboxId: string;
  /** Human-readable slug for the sandbox */
  slug: string;
  /** Compose identity reserved for this sandbox */
  composeProjectName: string;
  /** Local sandbox mode */
  mode: "minimal" | "full";
  /** Root sandbox path on disk */
  path: string;
  /** Repo checkout path on disk */
  repoPath: string;
  /** Materialized sandbox env path */
  envPath: string;
  /** Registry path tracking this sandbox */
  registryPath: string;
}

/**
 * Request for sandboxed story execution.
 *
 * Sent by Restate to system-bus or a k8s Job launcher.
 */
export interface SandboxExecutionRequest {
  /** Unique workflow identifier */
  workflowId: string;
  /** Unique request identifier for idempotency */
  requestId: string;
  /** Story identifier from the PRD */
  storyId: string;
  /** Story prompt/task to execute */
  task: string;
  /** Agent identity */
  agent: AgentIdentity;
  /** Sandbox profile */
  sandbox: SandboxProfile;
  /** Base git SHA before execution */
  baseSha: string;
  /** Sandbox backend (defaults to local when omitted) */
  backend?: SandboxBackend;
  /** Working directory for execution (host/local path when available) */
  cwd?: string;
  /** Remote git URL for isolated runners that cannot access the host worktree directly */
  repoUrl?: string;
  /** Branch or ref used when materializing the repo */
  branch?: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Verification commands to run after completion */
  verificationCommands?: string[];
  /** Optional session identifier for tracking */
  sessionId?: string;
}

/**
 * Artifact manifest from a completed sandbox execution.
 */
export interface ExecutionArtifacts {
  /** Git SHA after execution */
  headSha: string;
  /** List of files touched during execution */
  touchedFiles: string[];
  /** Optional patch/diff content */
  patch?: string;
  /** Verification summary */
  verification?: {
    /** Commands run */
    commands: string[];
    /** All commands passed */
    success: boolean;
    /** Output from verification commands */
    output?: string;
  };
  /** Log references and output */
  logs?: {
    /** Path to execution log */
    executionLog?: string;
    /** Path to verification log */
    verificationLog?: string;
    /** Stdout content (truncated if large) */
    stdout?: string;
    /** Stderr content (truncated if large) */
    stderr?: string;
  };
}

/**
 * Result of a sandboxed execution.
 *
 * Returned to Restate by system-bus or a k8s Job runner.
 */
export interface SandboxExecutionResult {
  /** Request identifier (for correlation) */
  requestId: string;
  /** Final execution state */
  state: ExecutionState;
  /** Timestamp when execution started */
  startedAt: string;
  /** Timestamp when execution completed/failed */
  completedAt?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Backend that produced this result */
  backend?: SandboxBackend;
  /** Optional k8s Job reference */
  job?: SandboxJobRef;
  /** Artifacts produced (only for completed state) */
  artifacts?: ExecutionArtifacts;
  /** Error message (only for failed/cancelled state) */
  error?: string;
  /** Optional stdout/stderr output or result text */
  output?: string;
}

/**
 * Story plan from a PRD.
 *
 * This is the input format for Restate workflows.
 */
export interface StoryPlan {
  /** Unique story identifier */
  id: string;
  /** Story title */
  title: string;
  /** Summary of the story */
  summary: string;
  /** Full story prompt */
  prompt: string;
  /** Preferred files to touch */
  files?: string[];
  /** Story dependencies (IDs of stories that must complete first) */
  dependsOn?: string[];
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Sandbox profile */
  sandbox?: SandboxProfile;
}

/**
 * Wave plan grouping parallel stories.
 */
export interface WavePlan {
  /** Wave identifier */
  id: string;
  /** Stories in this wave (execute in parallel) */
  stories: StoryPlan[];
}

/**
 * Full PRD execution plan.
 */
export interface PrdExecutionPlan {
  /** Plan summary */
  summary: string;
  /** Waves of stories (execute sequentially, parallel within wave) */
  waves: WavePlan[];
}

/**
 * Legacy inbox result format (for backward compatibility).
 *
 * This is the format used by agent-dispatch and written to ~/.joelclaw/workspace/inbox.
 * New code should use SandboxExecutionResult instead.
 *
 * @deprecated Use SandboxExecutionResult for new code
 */
export interface InboxResult {
  requestId: string;
  sessionId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  task: string;
  tool: string;
  agent?: string;
  result?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Execution mode used (host or sandbox) */
  executionMode?: ExecutionMode;
  /** Concrete sandbox backend when executionMode === sandbox */
  sandboxBackend?: SandboxBackend;
  /** Optional job reference for k8s-backed runs */
  job?: SandboxJobRef;
  /** Optional local sandbox metadata for host-worker runs */
  localSandbox?: LocalSandboxRuntimeInfo;
  /** Optional artifact bundle for sandboxed runs */
  artifacts?: ExecutionArtifacts;
  /** Optional execution and verification logs */
  logs?: ExecutionArtifacts["logs"];
}
