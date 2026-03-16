import { homedir } from "node:os";
import { join } from "node:path";


export const WORKLOAD_VERSION = "2026-03-08";
export const WORKLOAD_INBOX_DIR = join(homedir(), ".joelclaw", "workspace", "inbox");

export const WORKLOAD_KINDS = [
  "repo.patch",
  "repo.refactor",
  "repo.docs",
  "repo.review",
  "research.spike",
  "runtime.proof",
  "cross-repo.integration",
] as const;

export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export const WORKLOAD_KIND_CHOICES = ["auto", ...WORKLOAD_KINDS] as const;

export type WorkloadKindChoice = (typeof WORKLOAD_KIND_CHOICES)[number];

export const WORKLOAD_SHAPES = ["auto", "serial", "parallel", "chained"] as const;

export type WorkloadShape = Exclude<(typeof WORKLOAD_SHAPES)[number], "auto">;
export type WorkloadShapeChoice = (typeof WORKLOAD_SHAPES)[number];

export const EXECUTION_MODES = [
  "inline",
  "durable",
  "sandbox",
  "loop",
  "blocked",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const BACKEND_CLASSES = [
  "host",
  "local-sandbox",
  "k8s-sandbox",
  "queue",
  "restate",
  "none",
] as const;

export type BackendClass = (typeof BACKEND_CLASSES)[number];

export const AUTONOMY_LEVELS = ["inline", "supervised", "afk", "blocked"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const PROOF_POSTURES = ["none", "dry-run", "canary", "soak", "full"] as const;

export type ProofPosture = (typeof PROOF_POSTURES)[number];

export const RISK_POSTURES = [
  "reversible-only",
  "sandbox-required",
  "host-okay",
  "deploy-allowed",
  "human-signoff",
] as const;

export type RiskPosture = (typeof RISK_POSTURES)[number];

export const ARTIFACT_NAMES = [
  "patch",
  "tests",
  "verification",
  "summary",
  "docs",
  "adr",
  "deploy-proof",
  "telemetry-proof",
  "handoff",
  "research-note",
  "comparison",
  "rollback-plan",
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export const WORKLOAD_PRESETS = [
  "docs-truth",
  "research-compare",
  "refactor-handoff",
] as const;

export type WorkloadPreset = (typeof WORKLOAD_PRESETS)[number];

export const LOCAL_SANDBOX_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type LocalSandboxState = (typeof LOCAL_SANDBOX_STATES)[number];

export type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" };

export type PathScopeSource =
  | "repo-wide"
  | "explicit-paths"
  | "git-status"
  | "git-head"
  | "git-recent";

export type WorkloadTarget = {
  repo: string;
  branch?: string;
  baseSha?: string;
  paths?: string[];
};

export type WorkloadRequest = {
  version: string;
  kind: WorkloadKind;
  intent: string;
  requestedBy: string;
  shape: WorkloadShape;
  autonomy: AutonomyLevel;
  proof: ProofPosture;
  risk: RiskPosture[];
  targets: WorkloadTarget[];
  acceptance: string[];
  artifacts: ArtifactName[];
  constraints?: {
    mustFollow?: string[];
    avoid?: string[];
  };
  context?: {
    adr: string[];
    steering: string;
    notes: string[];
  };
};

export type WorkloadStage = {
  id: string;
  name: string;
  owner: string;
  mode: ExecutionMode;
  inputs: string[];
  outputs: string[];
  reservedPaths?: string[];
  verification: string[];
  stopConditions: string[];
  dependsOn?: string[];
};

export type WorkloadPlan = {
  workloadId: string;
  version: string;
  status: "planned";
  kind: WorkloadKind;
  shape: WorkloadShape;
  mode: ExecutionMode;
  backend: BackendClass;
  summary: string;
  why: string[];
  risks: string[];
  artifacts: ArtifactName[];
  verification: string[];
  stages: WorkloadStage[];
  next_actions: Array<{ command: string; description: string }>;
};

export type PathScopeSeed = {
  source: PathScopeSource;
  detail?: string;
  pathCount: number;
};

export type AppliedPreset = {
  name: WorkloadPreset;
  description: string;
  appliedDefaults: string[];
};

export type WorkloadPlanArtifact = {
  written: true;
  path: string;
  format: "joelclaw-envelope";
};

export type WorkloadDispatchArtifact = {
  written: true;
  path: string;
  format: "joelclaw-envelope";
};

export type WorkloadHandoff = {
  workloadId: string;
  stageId: string;
  goal: string;
  currentState: string;
  artifactsProduced: string[];
  verificationDone: string[];
  remainingGates: string[];
  reservedPaths: string[];
  releasedPaths: string[];
  risks: string[];
  nextAction: string;
};

export type WorkloadDispatchDelivery = {
  sent: boolean;
  project: string;
  from: string;
  to: string;
  result: unknown;
};

export type WorkloadDispatchRecommendation =
  | "execute-dispatched-stage-now"
  | "dispatch-is-overkill-keep-it-inline"
  | "dispatch-after-health-check"
  | "clarify-recipient-before-sending";

export type WorkloadExecutionLoop = {
  approvalPrompt: string;
  approvedNextStep: string;
  progressUpdateExpectation: string;
  completionExpectation: string;
};

export type WorkloadDispatchGuidance = {
  recommendation: WorkloadDispatchRecommendation;
  summary: string;
  stageReason: string;
  adrCoverage: {
    records: string[];
    note: string;
  };
  recommendedSkills: WorkloadSkillRecommendation[];
  executionLoop: WorkloadExecutionLoop;
};

export type WorkloadDispatchResult = {
  version: string;
  dispatchId: string;
  sourcePlan: {
    path: string;
    workloadId: string;
  };
  selectedStage: WorkloadStage;
  target: WorkloadTarget;
  guidance: WorkloadDispatchGuidance;
  handoff: WorkloadHandoff;
  mail: {
    subject: string;
    body: string;
    from?: string;
    to?: string;
  };
  artifact?: WorkloadDispatchArtifact;
  delivery?: WorkloadDispatchDelivery;
  shipped: {
    plan: true;
    dispatch: true;
    run: true;
    status: false;
    explain: false;
    cancel: false;
  };
};

export type WorkloadRuntimeRequest = {
  requestId: string;
  workflowId: string;
  storyId: string;
  task: string;
  tool: "pi" | "codex" | "claude";
  cwd?: string;
  repoUrl?: string;
  branch?: string;
  baseSha?: string;
  timeout?: number;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  executionMode?: "host" | "sandbox";
  sandboxBackend?: "local" | "k8s";
  sandboxMode?: "minimal" | "full";
  readFiles?: boolean;
};

export type WorkloadRunResult = {
  version: string;
  runId: string;
  sourcePlan: {
    path: string;
    workloadId: string;
  };
  selectedStage: WorkloadStage;
  target: WorkloadTarget;
  guidance: WorkloadDispatchGuidance;
  event: {
    family: "workload/requested";
    target: "system/agent.requested";
  };
  runtimeRequest: WorkloadRuntimeRequest;
  queue?: {
    streamId: string;
    eventId: string;
    priority: number;
    triageMode: string;
    triage?: unknown;
  };
  dryRun: boolean;
  shipped: {
    plan: true;
    dispatch: true;
    run: true;
    status: false;
    explain: false;
    cancel: false;
  };
};

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

export type WorkloadRecommendedExecution =
  | "execute-inline-now"
  | "tighten-scope-first"
  | "dispatch-after-health-check"
  | "write-plan-then-dispatch"
  | "blocked-clarify-first";

export type WorkloadSkillRecommendation = {
  name: string;
  reason: string;
  sourceRoot?: string;
  canonicalPath?: string;
  installedConsumers: Array<"agents" | "pi" | "claude">;
  missingConsumers: Array<"agents" | "pi" | "claude">;
  ensureCommand?: string;
  externalInstallCommand?: string;
  readPath?: string;
};

export type WorkloadExecutionExample = {
  shape: WorkloadShape;
  title: string;
  setup: string[];
  execute: string[];
  exampleTask: string;
  exampleCommand: string;
};

export type WorkloadGuidance = {
  recommendedExecution: WorkloadRecommendedExecution;
  operatorSummary: string;
  adrCoverage: {
    records: string[];
    note: string;
  };
  recommendedSkills: WorkloadSkillRecommendation[];
  executionExamples: WorkloadExecutionExample[];
  executionLoop: WorkloadExecutionLoop;
};

export type WorkloadPlanningResult = {
  request: WorkloadRequest;
  plan: WorkloadPlan;
  guidance: WorkloadGuidance;
  metadata?: Record<string, unknown>;
  inference: {
    kind: { value: WorkloadKind; inferred: boolean; reason: string };
    shape: { value: WorkloadShape; inferred: boolean; reason: string };
    mode: { value: ExecutionMode; inferred: boolean; reason: string };
    backend: { value: BackendClass; inferred: boolean; reason: string };
    risks: { value: RiskPosture[]; inferred: boolean };
    artifacts: { value: ArtifactName[]; inferred: boolean };
    target: {
      value: WorkloadTarget;
      inferred: boolean;
      localRepo: boolean;
      scope: PathScopeSeed;
    };
  };
  warnings: string[];
  preset?: AppliedPreset;
  artifact?: WorkloadPlanArtifact;
  shipped: {
    plan: true;
    run: true;
    status: false;
    explain: false;
    cancel: false;
  };
};

export type EnumParseResult<T extends string> = {
  values: T[];
  unknown: string[];
};

export type ShapeResolution = {
  value: WorkloadShape;
  inferred: boolean;
  reason: string;
};

export type Resolution<T extends string> = {
  value: T;
  inferred: boolean;
  reason: string;
};

export type PathsFromDirective =
  | { raw: string; source: "status" }
  | { raw: string; source: "head" }
  | { raw: string; source: "recent"; count: number };

export type TargetResolution = {
  value: WorkloadTarget;
  inferred: boolean;
  localRepo: boolean;
  warnings: string[];
  scope: PathScopeSeed;
};

export type PlannerInput = {
  intent: string;
  preset?: WorkloadPreset;
  kind: WorkloadKindChoice;
  shape: WorkloadShapeChoice;
  autonomy: AutonomyLevel;
  proof: ProofPosture;
  riskText?: string;
  artifactsText?: string;
  acceptanceText?: string;
  repoText?: string;
  pathsText?: string;
  pathsFromText?: string;
  requestedBy: string;
};

export type NormalizedPlannerInput = PlannerInput & {
  kind: WorkloadKindChoice;
  shape: WorkloadShapeChoice;
};

export type PlannerInputResolution = {
  normalized: NormalizedPlannerInput;
  preset?: AppliedPreset;
};

export type WorkloadPresetDefinition = {
  description: string;
  kind?: WorkloadKind;
  shape?: WorkloadShape;
  risk?: readonly RiskPosture[];
  artifacts?: readonly ArtifactName[];
  acceptance?: readonly string[];
};

export const WORKLOAD_PRESET_DEFINITIONS: Record<
  WorkloadPreset,
  WorkloadPresetDefinition
> = {
  "docs-truth": {
    description: "Serial docs/ADR truth grooming with explicit closeout",
    kind: "repo.docs",
    shape: "serial",
    artifacts: ["docs", "summary", "adr"],
    acceptance: [
      "shipped docs and ADR truth match the current code reality",
      "scope is explicit before edits start",
      "closeout leaves a concise reusable summary",
    ],
  },
  "research-compare": {
    description: "Parallel comparison work with one synthesis owner",
    kind: "research.spike",
    shape: "parallel",
    artifacts: ["research-note", "comparison", "summary"],
    acceptance: [
      "each branch produces a scoped finding without overlapping edits",
      "one synthesis step makes a clear recommendation",
      "the chosen path is explicit enough to schedule next",
    ],
  },
  "refactor-handoff": {
    description: "Chained implementation → verification → handoff planning",
    kind: "repo.refactor",
    shape: "chained",
    artifacts: ["patch", "tests", "verification", "docs", "summary", "handoff"],
    acceptance: [
      "implementation scope is path-bounded before mutation starts",
      "verification is recorded separately from implementation",
      "the final handoff is reusable without raw chat history",
    ],
  },
};
