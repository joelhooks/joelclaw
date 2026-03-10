import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import {
  cleanupLocalSandboxes,
  defaultLocalSandboxRegistryPath,
  isLocalSandboxEntryExpired,
  type LocalSandboxRegistryEntry,
  pruneExpiredLocalSandboxes,
  reconcileLocalSandboxRegistry,
} from "@joelclaw/agent-execution";
import { Console, Effect } from "effect";
import { executeCapabilityCommand } from "../capabilities/runtime";
import { enqueueQueueEventViaWorker } from "../lib/queue-admission";
import {
  buildSuccessEnvelope,
  type JoelclawEnvelope,
  type NextAction,
  respond,
  respondError,
} from "../response";

const WORKLOAD_VERSION = "2026-03-08";

const WORKLOAD_KINDS = [
  "repo.patch",
  "repo.refactor",
  "repo.docs",
  "repo.review",
  "research.spike",
  "runtime.proof",
  "cross-repo.integration",
] as const;

type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

const WORKLOAD_KIND_CHOICES = ["auto", ...WORKLOAD_KINDS] as const;

type WorkloadKindChoice = (typeof WORKLOAD_KIND_CHOICES)[number];

const WORKLOAD_SHAPES = ["auto", "serial", "parallel", "chained"] as const;

type WorkloadShape = Exclude<(typeof WORKLOAD_SHAPES)[number], "auto">;
type WorkloadShapeChoice = (typeof WORKLOAD_SHAPES)[number];

const EXECUTION_MODES = [
  "inline",
  "durable",
  "sandbox",
  "loop",
  "blocked",
] as const;

type ExecutionMode = (typeof EXECUTION_MODES)[number];

const BACKEND_CLASSES = [
  "host",
  "local-sandbox",
  "k8s-sandbox",
  "queue",
  "restate",
  "none",
] as const;

type BackendClass = (typeof BACKEND_CLASSES)[number];

const AUTONOMY_LEVELS = ["inline", "supervised", "afk", "blocked"] as const;

type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const PROOF_POSTURES = ["none", "dry-run", "canary", "soak", "full"] as const;

type ProofPosture = (typeof PROOF_POSTURES)[number];

const RISK_POSTURES = [
  "reversible-only",
  "sandbox-required",
  "host-okay",
  "deploy-allowed",
  "human-signoff",
] as const;

type RiskPosture = (typeof RISK_POSTURES)[number];

const ARTIFACT_NAMES = [
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

type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const WORKLOAD_PRESETS = [
  "docs-truth",
  "research-compare",
  "refactor-handoff",
] as const;

type WorkloadPreset = (typeof WORKLOAD_PRESETS)[number];

const LOCAL_SANDBOX_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

type LocalSandboxState = (typeof LOCAL_SANDBOX_STATES)[number];

type PathScopeSource =
  | "repo-wide"
  | "explicit-paths"
  | "git-status"
  | "git-head"
  | "git-recent";

type WorkloadTarget = {
  repo: string;
  branch?: string;
  baseSha?: string;
  paths?: string[];
};

type WorkloadRequest = {
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

type WorkloadStage = {
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

type WorkloadPlan = {
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

type PathScopeSeed = {
  source: PathScopeSource;
  detail?: string;
  pathCount: number;
};

type AppliedPreset = {
  name: WorkloadPreset;
  description: string;
  appliedDefaults: string[];
};

type WorkloadPlanArtifact = {
  written: true;
  path: string;
  format: "joelclaw-envelope";
};

type WorkloadDispatchArtifact = {
  written: true;
  path: string;
  format: "joelclaw-envelope";
};

type WorkloadHandoff = {
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

type WorkloadDispatchDelivery = {
  sent: boolean;
  project: string;
  from: string;
  to: string;
  result: unknown;
};

type WorkloadDispatchRecommendation =
  | "execute-dispatched-stage-now"
  | "dispatch-is-overkill-keep-it-inline"
  | "dispatch-after-health-check"
  | "clarify-recipient-before-sending";

type WorkloadExecutionLoop = {
  approvalPrompt: string;
  approvedNextStep: string;
  progressUpdateExpectation: string;
  completionExpectation: string;
};

type WorkloadDispatchGuidance = {
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

type WorkloadDispatchResult = {
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

type WorkloadRuntimeRequest = {
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

type WorkloadRunResult = {
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

type WorkloadRecommendedExecution =
  | "execute-inline-now"
  | "tighten-scope-first"
  | "dispatch-after-health-check"
  | "write-plan-then-dispatch"
  | "blocked-clarify-first";

type WorkloadSkillRecommendation = {
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

type WorkloadExecutionExample = {
  shape: WorkloadShape;
  title: string;
  setup: string[];
  execute: string[];
  exampleTask: string;
  exampleCommand: string;
};

type WorkloadGuidance = {
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

type WorkloadPlanningResult = {
  request: WorkloadRequest;
  plan: WorkloadPlan;
  guidance: WorkloadGuidance;
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

type EnumParseResult<T extends string> = {
  values: T[];
  unknown: string[];
};

type ShapeResolution = {
  value: WorkloadShape;
  inferred: boolean;
  reason: string;
};

type Resolution<T extends string> = {
  value: T;
  inferred: boolean;
  reason: string;
};

type PathsFromDirective =
  | { raw: string; source: "status" }
  | { raw: string; source: "head" }
  | { raw: string; source: "recent"; count: number };

type TargetResolution = {
  value: WorkloadTarget;
  inferred: boolean;
  localRepo: boolean;
  warnings: string[];
  scope: PathScopeSeed;
};

type PlannerInput = {
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

type NormalizedPlannerInput = PlannerInput & {
  kind: WorkloadKindChoice;
  shape: WorkloadShapeChoice;
};

type PlannerInputResolution = {
  normalized: NormalizedPlannerInput;
  preset?: AppliedPreset;
};

type WorkloadPresetDefinition = {
  description: string;
  kind?: WorkloadKind;
  shape?: WorkloadShape;
  risk?: readonly RiskPosture[];
  artifacts?: readonly ArtifactName[];
  acceptance?: readonly string[];
};

const WORKLOAD_PRESET_DEFINITIONS: Record<
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

const lower = (value: string) => value.toLowerCase();

const dedupe = <T extends string>(values: readonly T[]): T[] => [
  ...new Set(values),
];

const shellQuote = (value: string) => JSON.stringify(value);

const splitCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const splitDelimited = (value: string | undefined): string[] => {
  if (!value) return [];
  const separator = value.includes("|") ? "|" : ",";
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
};

const splitLines = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
};

const trimClause = (value: string) =>
  value
    .trim()
    .replace(/^[\s;,.:-]+/u, "")
    .replace(/[\s;,.:-]+$/u, "");

const splitClauses = (value: string): string[] => {
  const source = value.trim();
  if (source.length === 0) return [];

  if (source.includes(";")) {
    return source.split(/;+/u).map(trimClause).filter(Boolean);
  }

  const lineClauses = splitLines(source).map(trimClause).filter(Boolean);
  if (lineClauses.length > 1) {
    return lineClauses;
  }

  return source.split(/\.\s+/u).map(trimClause).filter(Boolean);
};

const extractIntentSection = (
  intent: string,
  label: string,
  stopMarkers: readonly string[],
): string | undefined => {
  const lowered = lower(intent);
  const labelNeedle = `${lower(label)}:`;
  const start = lowered.indexOf(labelNeedle);
  if (start === -1) return undefined;

  const contentStart = start + labelNeedle.length;
  let end = intent.length;

  for (const marker of stopMarkers) {
    const index = lowered.indexOf(lower(marker), contentStart);
    if (index !== -1 && index < end) {
      end = index;
    }
  }

  const section = intent.slice(contentStart, end).trim();
  return section.length > 0 ? section : undefined;
};

const extractAcceptanceFromIntent = (intent: string): string[] => {
  const section = extractIntentSection(intent, "acceptance", [
    " goal:",
    " context:",
    " constraints:",
    " if these changes",
    " if this changes",
    " stop and",
  ]);

  return section ? splitClauses(section) : [];
};

const extractGoalMilestones = (intent: string): string[] => {
  const section =
    extractIntentSection(intent, "goal", [
      " acceptance:",
      " context:",
      " constraints:",
      " if these changes",
      " if this changes",
      " stop and",
    ]) ?? intent;

  return splitClauses(section).filter(
    (clause) => !/^acceptance\b/iu.test(clause),
  );
};

const shouldInsertReflectionStage = (
  intent: string,
  acceptance: readonly string[],
): boolean => {
  const combined = lower([intent, ...acceptance].join(" "));
  return hasAny(combined, [
    "reflect",
    "reflection",
    "plan-update",
    "update plan",
    "re-plan",
    "replan",
    "update the plan",
  ]);
};

const toStageName = (value: string, fallback: string): string => {
  const clause = trimClause(value);
  if (clause.length === 0) return fallback;
  if (clause.length <= 88) return clause;
  return `${clause.slice(0, 85).trimEnd()}…`;
};

const parseEnumList = <T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): EnumParseResult<T> => {
  const values = splitCsv(raw);
  const allowedSet = new Set(allowed);
  const known: T[] = [];
  const unknown: string[] = [];

  for (const value of values) {
    if (allowedSet.has(value as T)) {
      known.push(value as T);
    } else {
      unknown.push(value);
    }
  }

  return { values: dedupe(known), unknown: dedupe(unknown) };
};

const hasAny = (value: string, needles: readonly string[]) =>
  needles.some((needle) => value.includes(needle));

const hasExplicitIsolationIntent = (value: string) =>
  hasAny(value, [
    "sandbox required",
    "require sandbox",
    "run in sandbox",
    "use a sandbox",
    "sandbox this",
    "isolated execution",
    "isolation required",
    "inside sandbox",
    "sandboxed execution",
  ]);

const hasExplicitDeployIntent = (value: string) =>
  hasAny(value, [
    "deploy",
    "release this",
    "cut release",
    "publish this",
    "publish package",
    "publish packages",
    "ship to prod",
    "ship to production",
  ]);

const expandHome = (value: string) =>
  value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value;

const runGitRaw = (repoPath: string, args: string[]): string | undefined => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
};

const runGit = (repoPath: string, args: string[]): string | undefined => {
  const output = runGitRaw(repoPath, args)?.trim();
  return output && output.length > 0 ? output : undefined;
};

const normalizeGitPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes(" -> ")) return trimmed;
  return trimmed.split(" -> ").at(-1)?.trim() ?? trimmed;
};

const parsePathsFrom = (
  value: string | undefined,
): PathsFromDirective | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const lowered = lower(trimmed);

  if (lowered === "status") {
    return { raw: trimmed, source: "status" };
  }

  if (lowered === "head") {
    return { raw: trimmed, source: "head" };
  }

  const recentMatch = lowered.match(/^recent:(\d+)$/u);
  if (recentMatch) {
    const count = Number.parseInt(recentMatch[1] ?? "0", 10);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Invalid --paths-from value: ${trimmed}`);
    }
    return { raw: trimmed, source: "recent", count };
  }

  throw new Error(
    `Invalid --paths-from value: ${trimmed}. Use status, head, or recent:<n>`,
  );
};

const collectGitStatusPaths = (repoPath: string): string[] => {
  const output = runGitRaw(repoPath, [
    "status",
    "--short",
    "--untracked-files=all",
    "--porcelain=v1",
  ]);

  return dedupe(
    splitLines(output)
      .map((line) => normalizeGitPath(line.slice(3)))
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));
};

const collectGitNamedPaths = (repoPath: string, args: string[]): string[] =>
  dedupe(
    splitLines(runGitRaw(repoPath, args))
      .map((line) => normalizeGitPath(line))
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));

const collectPathsFromDirective = (
  repoPath: string,
  directive: PathsFromDirective,
): { paths: string[]; scope: PathScopeSeed } => {
  switch (directive.source) {
    case "status": {
      const paths = collectGitStatusPaths(repoPath);
      return {
        paths,
        scope: {
          source: "git-status",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
    case "head": {
      const paths = collectGitNamedPaths(repoPath, [
        "show",
        "--pretty=format:",
        "--name-only",
        "HEAD",
      ]);
      return {
        paths,
        scope: {
          source: "git-head",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
    case "recent": {
      const paths = collectGitNamedPaths(repoPath, [
        "log",
        `-n${directive.count}`,
        "--name-only",
        "--pretty=format:",
      ]);
      return {
        paths,
        scope: {
          source: "git-recent",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
  }
};

const defaultPlanArtifactPath = (workloadId: string) =>
  `~/.joelclaw/workloads/${workloadId}.json`;

const resolvePlanArtifactPath = (value: string, workloadId: string): string => {
  const expanded = expandHome(value);
  const absolute = resolve(expanded);
  const looksLikeDirectory =
    value.endsWith("/") ||
    (existsSync(absolute) && statSync(absolute).isDirectory());

  return looksLikeDirectory ? join(absolute, `${workloadId}.json`) : absolute;
};

const writePlanArtifact = (
  path: string,
  envelope: JoelclawEnvelope,
): WorkloadPlanArtifact => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return {
    written: true,
    path,
    format: "joelclaw-envelope",
  };
};

const defaultDispatchArtifactPath = (dispatchId: string) =>
  `~/.joelclaw/workloads/${dispatchId}.json`;

const SKILL_CONSUMER_DIRS = {
  agents: join(homedir(), ".agents", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
  claude: join(homedir(), ".claude", "skills"),
} as const;

const resolveCanonicalSkillPath = (
  name: string,
  sourceRoot?: string,
): string | undefined => {
  const candidates = [
    ...(sourceRoot ? [join(resolve(expandHome(sourceRoot)), "skills", name, "SKILL.md")] : []),
    join(homedir(), "Code", "joelhooks", "joelclaw", "skills", name, "SKILL.md"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
};

const detectInstalledSkillConsumers = (
  name: string,
): Array<"agents" | "pi" | "claude"> =>
  (Object.entries(SKILL_CONSUMER_DIRS) as Array<
    ["agents" | "pi" | "claude", string]
  >)
    .filter(([, dir]) => existsSync(join(dir, name, "SKILL.md")))
    .map(([consumer]) => consumer);

const buildEnsureSkillCommand = (
  name: string,
  sourceRoot?: string,
): string =>
  `joelclaw skills ensure ${name}${sourceRoot ? ` --source-root ${shellQuote(sourceRoot)}` : ""}`;

const buildExternalSkillInstallCommand = (name: string): string =>
  `npx skills add -y -g ${name}`;

const buildReadSkillCommand = (path: string): string =>
  `read ${shellQuote(path)}`;

const isNestedWorkflowRigSandboxExecution = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const sandboxExecution = env.JOELCLAW_SANDBOX_EXECUTION?.trim().toLowerCase() === "true";
  const workflowId = env.JOELCLAW_SANDBOX_WORKFLOW_ID?.trim();
  const allowNested = env.JOELCLAW_ALLOW_NESTED_WORKFLOW_RIG?.trim().toLowerCase() === "true";

  return sandboxExecution && Boolean(workflowId) && !allowNested;
};

function isLocalSandboxState(value: string): value is LocalSandboxState {
  return (LOCAL_SANDBOX_STATES as readonly string[]).includes(value);
}

function normalizeOptionalFlagText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined;
  const normalized = value.value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function splitCsvValues(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function summarizeLocalSandboxEntries(entries: LocalSandboxRegistryEntry[], now: Date) {
  const byState: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  let expiredCount = 0;
  let missingOnDiskCount = 0;

  for (const entry of entries) {
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    byMode[entry.mode] = (byMode[entry.mode] ?? 0) + 1;
    if (isLocalSandboxEntryExpired(entry, now)) expiredCount += 1;
    if (!existsSync(entry.path)) missingOnDiskCount += 1;
  }

  return {
    byState,
    byMode,
    expiredCount,
    missingOnDiskCount,
  };
}

function toLocalSandboxListEntry(entry: LocalSandboxRegistryEntry, now: Date) {
  const cleanupAt = entry.cleanupAfter ? Date.parse(entry.cleanupAfter) : Number.NaN;
  const cleanupDue = isLocalSandboxEntryExpired(entry, now);
  const cleanupInMs = Number.isFinite(cleanupAt) ? cleanupAt - now.getTime() : null;

  return {
    sandboxId: entry.sandboxId,
    requestId: entry.requestId,
    workflowId: entry.workflowId,
    storyId: entry.storyId,
    state: entry.state,
    mode: entry.mode,
    teardownState: entry.teardownState,
    retentionPolicy: entry.retentionPolicy ?? "active",
    cleanupAfter: entry.cleanupAfter,
    cleanupDue,
    cleanupInMs,
    existsOnDisk: existsSync(entry.path),
    path: entry.path,
    repoPath: entry.repoPath,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    composeProjectName: entry.composeProjectName,
  };
}

const inferWorkloadSkillRecommendations = (
  input: NormalizedPlannerInput,
  request: WorkloadRequest,
): WorkloadSkillRecommendation[] => {
  const repo = request.targets[0]?.repo ?? process.cwd();
  const paths = request.targets[0]?.paths ?? [];
  const recommendations = new Map<string, { reason: string; sourceRoot?: string }>();

  const addSkill = (name: string, reason: string, sourceRoot?: string) => {
    if (!recommendations.has(name)) {
      recommendations.set(name, { reason, sourceRoot });
    }
  };

  addSkill(
    "workflow-rig",
    "Canonical front door for workload planning, dispatch posture, runtime mode selection, and handoff contracts",
  );

  if (repo.includes("/joelclaw")) {
    if (
      paths.some(
        (path) => path.startsWith("packages/cli") || path === "docs/cli.md",
      )
    ) {
      addSkill("cli-design", "Work touches the CLI contract and next-action UX");
    }

    if (
      paths.some(
        (path) => path.startsWith("skills/") || path === "docs/skills.md",
      )
    ) {
      addSkill(
        "skill-review",
        "Work changes skill maintenance reality and should keep the skill garden honest",
      );
    }

    if (
      paths.some(
        (path) =>
          path.startsWith("packages/system-bus") || path.startsWith("k8s/"),
      ) || request.kind === "runtime.proof"
    ) {
      addSkill(
        "system-architecture",
        "Cross-cutting runtime work should follow the canonical topology map",
      );
    }
  }

  if (repo.includes("/badass-courses/gremlin") || /\bgremlin\b|\bwizardshit\b/iu.test(input.intent)) {
    addSkill(
      "gremlin",
      "Gremlin repo-local truth and active package/runtime context",
      repo,
    );
  }

  return [...recommendations.entries()].map(([name, config]) => {
    const canonicalPath = resolveCanonicalSkillPath(name, config.sourceRoot);
    const installedConsumers = detectInstalledSkillConsumers(name);
    const missingConsumers = (
      ["agents", "pi", "claude"] as const
    ).filter((consumer) => !installedConsumers.includes(consumer));

    return {
      name,
      reason: config.reason,
      ...(config.sourceRoot ? { sourceRoot: config.sourceRoot } : {}),
      ...(canonicalPath ? { canonicalPath } : {}),
      installedConsumers: [...installedConsumers],
      missingConsumers: [...missingConsumers],
      ...(canonicalPath
        ? { ensureCommand: buildEnsureSkillCommand(name, config.sourceRoot) }
        : {
            externalInstallCommand: buildExternalSkillInstallCommand(name),
          }),
      readPath:
        canonicalPath ??
        (installedConsumers.includes("pi")
          ? join(SKILL_CONSUMER_DIRS.pi, name, "SKILL.md")
          : undefined),
    };
  });
};

const matchAnyPattern = (value: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

const inferAdrCoverage = (
  input: NormalizedPlannerInput,
  request: WorkloadRequest,
): WorkloadGuidance["adrCoverage"] => {
  const repo = request.targets[0]?.repo ?? process.cwd();
  const paths = request.targets[0]?.paths ?? [];

  if (repo.includes("/badass-courses/gremlin")) {
    const records = new Set<string>();
    const combinedText = `${input.intent}\n${paths.join("\n")}`;
    const harnessPatterns = [
      /(^|\n)README\.md($|\n)/u,
      /(^|\n)docs\/dev-log\.md($|\n)/u,
      /(^|\n)docs\/adr\//u,
      /(^|\n)\.pi\//u,
      /(^|\n)plugins\//u,
      /repo[- ]honesty/iu,
      /\bharness\b/iu,
      /\boperator discovery\b/iu,
      /\bagent-first\b/iu,
    ];
    const authPatterns = [
      /\bauth\b/iu,
      /\/api\/gremlin\/(session|rpc)/iu,
      /gremlin-operator-plane/iu,
      /docs\/setup-new-project\.md/iu,
      /handler\.ts$/iu,
    ];
    const rateLimitPatterns = [
      /\brate[- ]limit/iu,
      /\bbudget\b/iu,
      /\bmetered\b/iu,
      /\bpublic[- ]read\b/iu,
      /\b429\b/iu,
      /retry-after/iu,
      /\/api\/(search|content)/iu,
      /\/path\.md/iu,
    ];
    const knowledgePatterns = [
      /\/api\/gremlin\/knowledge/iu,
      /\bknowledge plane\b/iu,
      /\bdevelopment guide\b/iu,
      /\bguide and memory\b/iu,
      /\boperator knowledge\b/iu,
      /\bdev[- ]log\b/iu,
      /\bknowledge routes?\b/iu,
      /gremlin-cms/iu,
    ];
    const mcpPatterns = [
      /\bmcp\b/iu,
      /\/api\/gremlin\/mcp/iu,
      /\btool(s|ing)?\b/iu,
      /\bresource(s)?\b/iu,
      /\bprompt(s)?\b/iu,
      /\bstreamable http\b/iu,
      /\badapter(s)?\b/iu,
    ];

    if (matchAnyPattern(combinedText, harnessPatterns)) {
      records.add("ADR-0038");
      records.add("ADR-0039");
    }

    if (matchAnyPattern(combinedText, authPatterns)) {
      records.add("ADR-0040");
    }

    const touchesRateLimits = matchAnyPattern(combinedText, rateLimitPatterns);
    const touchesKnowledge = matchAnyPattern(combinedText, knowledgePatterns);
    const touchesMcp = matchAnyPattern(combinedText, mcpPatterns);

    if (touchesRateLimits) {
      records.add("ADR-0042");
    }

    if (touchesKnowledge) {
      records.add("ADR-0038");
      records.add("ADR-0039");
      records.add("ADR-0043");
    }

    if (touchesMcp) {
      records.add("ADR-0038");
      records.add("ADR-0042");
      records.add("ADR-0044");
    }

    if (touchesMcp && touchesKnowledge) {
      records.add("ADR-0043");
      records.add("ADR-0044");
      records.add("ADR-0042");
    }

    const resolvedRecords = [...records].sort();
    const repoLocalClusterDetected =
      resolvedRecords.some((record) => /^ADR-004[2-4]$/u.test(record)) &&
      resolvedRecords.some((record) => /^ADR-003[89]$/u.test(record));

    return {
      records:
        resolvedRecords.length > 0
          ? resolvedRecords
          : ["ADR-0038", "ADR-0039"],
      note:
        repoLocalClusterDetected
          ? "This Gremlin slice appears to touch a live repo-local ADR cluster. Treat the listed ADRs as high-signal coverage, then reconcile against nearby fresh ADRs before claiming the slice is fully covered."
          : resolvedRecords.length > 0
            ? "This Gremlin slice is already covered by existing repo ADRs; only add a new ADR if the scope expands into new repo policy."
            : "This Gremlin slice looks like harness/repo-truth work already covered by the existing repo ADRs.",
    };
  }

  return {
    records: ["ADR-0217"],
    note:
      "Workload planning and dispatch posture are covered by ADR-0217; only open another ADR if this changes the workload model itself.",
  };
};

const buildExecutionExamples = (
  input: NormalizedPlannerInput,
  request: WorkloadRequest,
): WorkloadExecutionExample[] => {
  const repo = request.targets[0]?.repo ?? process.cwd();
  const paths = request.targets[0]?.paths?.join(",") ?? "";
  const repoArg = `--repo ${shellQuote(repo)}`;
  const pathsArg = paths ? ` --paths ${shellQuote(paths)}` : "";

  return [
    {
      shape: "serial",
      title: "One agent, ordered checkpoints",
      setup: [
        "Pin the repo and path scope before touching code.",
        "Use serial when stage B depends on stage A being right.",
        "Load/install any missing repo skills first so the same agent is not guessing mid-flight.",
      ],
      execute: [
        "Reserve the scoped files.",
        "Implement the change.",
        "Run narrow verification.",
        "Update docs/skills truth immediately after code truth.",
      ],
      exampleTask:
        "Refactor a CLI command, rerun its tests, then update the matching docs.",
      exampleCommand: `joelclaw workload plan ${shellQuote(
        "Refactor the CLI surface, verify with narrow tests, then update the matching docs",
      )} --shape serial ${repoArg}${pathsArg}`,
    },
    {
      shape: "parallel",
      title: "Independent spikes with one synthesis owner",
      setup: [
        "Split the work into read-only or non-overlapping branches.",
        "Name one synthesis owner before any branch starts.",
        "Do not let two workers mutate the same files without an explicit merge plan.",
      ],
      execute: [
        "Dispatch one branch per approach or codepath.",
        "Collect findings as artifacts instead of chat residue.",
        "Run a synthesis pass that chooses the next path.",
      ],
      exampleTask:
        "Compare two implementation strategies or two codepaths before choosing one.",
      exampleCommand: `joelclaw workload plan ${shellQuote(
        "Compare two implementation strategies, keep branches independent, then synthesize the recommendation",
      )} --shape parallel ${repoArg}${pathsArg}`,
    },
    {
      shape: "chained",
      title: "Stage-specialized handoff with explicit artifacts",
      setup: [
        "Use chained when implementation, verification, and closeout want different stages or owners.",
        "Write the plan artifact up front so later stages do not reconstruct the task from chat.",
        "Treat dispatch as a contract surface, not code-execution theatre.",
      ],
      execute: [
        "Stage 1 implements.",
        "Stage 2 verifies independently.",
        "Stage 3 updates docs/ADR truth and closes out remaining gates.",
      ],
      exampleTask:
        "Implement a change, verify it separately, then groom docs/ADR truth before closeout.",
      exampleCommand: `joelclaw workload plan ${shellQuote(
        "Implement the change, verify it independently, then update docs and ADR truth before closeout",
      )} --shape chained ${repoArg}${pathsArg} --write-plan ${shellQuote(
        defaultPlanArtifactPath("WL_YYYYMMDD_HHMMSS"),
      )}`,
    },
  ];
};

const buildPlanExecutionLoop = (options: {
  recommendation: WorkloadRecommendedExecution;
  scopedPaths: string[];
}): WorkloadExecutionLoop => {
  const approvalPrompt =
    "Present the shaped workload, confirm the scoped paths and acceptance criteria, then ask 'approved?' before mutating code or dispatching another agent.";

  let approvedNextStep: string;

  switch (options.recommendation) {
    case "blocked-clarify-first":
      approvedNextStep =
        "Do not execute yet. Resolve the missing blocker questions, tighten the contract, and rerun the planner.";
      break;
    case "execute-inline-now":
      approvedNextStep =
        options.scopedPaths.length > 0
          ? "If approved, reserve the scoped files and execute the bounded slice directly. Do not widen it into dispatch, queue, or adjacent ops theatre."
          : "If approved, execute the bounded slice directly and keep the blast radius tight.";
      break;
    case "tighten-scope-first":
      approvedNextStep =
        "If approved in principle, tighten the path scope first, rerun the planner, then come back with the narrower slice instead of guessing in-repo.";
      break;
    case "dispatch-after-health-check":
      approvedNextStep =
        "If approved, check runtime health first, then dispatch through the managed path instead of pretending inline execution will stay tidy.";
      break;
    case "write-plan-then-dispatch":
    default:
      approvedNextStep =
        "If approved, write the plan artifact and dispatch the right stage/owner explicitly so the next worker does not reconstruct the task from chat.";
      break;
  }

  return {
    approvalPrompt,
    approvedNextStep,
    progressUpdateExpectation:
      "While the work is running, let the pi extension/TUI show real stage status and only interrupt the operator for blockers, changed scope, or a decision that actually needs human input.",
    completionExpectation:
      options.recommendation === "execute-inline-now"
        ? "When the slice lands, report what changed, what was verified, what remains, and whether the operator wants the commit pushed."
        : "When the workload lands, report the outcome, verification, remaining gates, and whether the next move is dispatch, push, or stop.",
  };
};

const buildWorkloadGuidance = (
  input: NormalizedPlannerInput,
  request: WorkloadRequest,
  plan: WorkloadPlan,
): WorkloadGuidance => {
  const recommendedSkills = inferWorkloadSkillRecommendations(input, request);
  const missingSkills = recommendedSkills.filter(
    (skill) => skill.missingConsumers.length > 0,
  );

  let recommendedExecution: WorkloadRecommendedExecution;
  let operatorSummary: string;

  if (plan.mode === "blocked") {
    recommendedExecution = "blocked-clarify-first";
    operatorSummary =
      "The planner found unresolved blockers. Clarify the missing risk/scope questions before handing this to another agent.";
  } else if (
    plan.mode === "inline" &&
    request.targets[0]?.repo &&
    request.targets[0]?.paths &&
    request.targets[0]?.paths!.length > 0
  ) {
    recommendedExecution = "execute-inline-now";
    operatorSummary =
      "This is a bounded local slice with explicit file scope. Execute inline now; dispatch only if you want separate ownership or a clean baton pass.";
  } else if (plan.mode === "inline") {
    recommendedExecution = "tighten-scope-first";
    operatorSummary =
      "This plan is still too wide for clean execution. Tighten the path scope before editing so the next agent does not guess.";
  } else if (
    plan.mode === "durable" ||
    plan.mode === "loop" ||
    plan.mode === "sandbox"
  ) {
    recommendedExecution = "dispatch-after-health-check";
    operatorSummary =
      "This work wants a managed runtime path. Check system health first, then dispatch instead of pretending inline execution will stay tidy.";
  } else {
    recommendedExecution = "write-plan-then-dispatch";
    operatorSummary =
      "Write the plan artifact and dispatch it explicitly so the next stage does not have to reconstruct intent from chat.";
  }

  if (missingSkills.length > 0) {
    operatorSummary = `${operatorSummary} Install or repair the recommended skills first so the agent is not operating half-blind.`;
  }

  const scopedPaths = request.targets[0]?.paths ?? [];

  return {
    recommendedExecution,
    operatorSummary,
    adrCoverage: inferAdrCoverage(input, request),
    recommendedSkills,
    executionExamples: buildExecutionExamples(input, request),
    executionLoop: buildPlanExecutionLoop({
      recommendation: recommendedExecution,
      scopedPaths,
    }),
  };
};

const writeDispatchArtifact = (
  path: string,
  envelope: JoelclawEnvelope,
): WorkloadDispatchArtifact => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return {
    written: true,
    path,
    format: "joelclaw-envelope",
  };
};

const readJsonArtifact = (path: string): unknown => {
  const absolute = resolve(expandHome(path));
  if (!existsSync(absolute)) {
    throw new Error(`Artifact path does not exist: ${absolute}`);
  }

  const raw = readFileSync(absolute, "utf8").trim();
  if (raw.length === 0) {
    throw new Error(`Artifact file is empty: ${absolute}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Artifact file is not valid JSON: ${absolute} (${detail})`);
  }
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const parseWorkloadPlanArtifact = (
  path: string,
): {
  absolutePath: string;
  envelope: JoelclawEnvelope;
  result: WorkloadPlanningResult;
} => {
  const absolutePath = resolve(expandHome(path));
  const parsed = readJsonArtifact(absolutePath);
  const envelope = asObject(parsed);
  if (!envelope) {
    throw new Error(
      `Artifact file does not contain a joelclaw envelope: ${absolutePath}`,
    );
  }

  const command = typeof envelope.command === "string" ? envelope.command : "";
  if (!/joelclaw\s+workload\s+plan$/u.test(command)) {
    throw new Error(
      `Artifact is not a joelclaw workload plan envelope: ${absolutePath}`,
    );
  }

  if (envelope.ok !== true) {
    throw new Error(
      `Artifact is not a successful workload plan: ${absolutePath}`,
    );
  }

  const result = asObject(envelope.result);
  const request = asObject(result?.request);
  const plan = asObject(result?.plan);
  const stages = Array.isArray(plan?.stages) ? plan?.stages : undefined;

  if (
    !result ||
    !request ||
    !plan ||
    typeof plan.workloadId !== "string" ||
    !stages ||
    stages.length === 0
  ) {
    throw new Error(
      `Artifact is missing the canonical workload request/plan payload: ${absolutePath}`,
    );
  }

  return {
    absolutePath,
    envelope: envelope as unknown as JoelclawEnvelope,
    result: result as unknown as WorkloadPlanningResult,
  };
};

const selectDispatchStage = (
  result: WorkloadPlanningResult,
  explicitStageId: string | undefined,
): WorkloadStage => {
  const stages = result.plan.stages;
  if (stages.length === 0) {
    throw new Error(
      `Workload ${result.plan.workloadId} has no stages to dispatch`,
    );
  }

  if (!explicitStageId) {
    return stages[0]!;
  }

  const stage = stages.find((candidate) => candidate.id === explicitStageId);
  if (!stage) {
    throw new Error(
      `Stage ${explicitStageId} does not exist in workload ${result.plan.workloadId}`,
    );
  }

  return stage;
};

const buildDispatchId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WD_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

const buildDispatchMailSubject = (
  workloadId: string,
  stage: WorkloadStage,
): string =>
  `Task: ${workloadId} ${stage.id} ${toStageName(stage.name, stage.id)}`;

const buildDispatchMailBody = (options: {
  sourcePlanPath: string;
  target: WorkloadTarget;
  handoff: WorkloadHandoff;
}): string => {
  const targetPaths = options.target.paths?.length
    ? options.target.paths.join(", ")
    : "repo-wide";
  const branchDetail = options.target.branch
    ? `${options.target.branch}${options.target.baseSha ? ` @ ${options.target.baseSha}` : ""}`
    : (options.target.baseSha ?? "unknown");

  return [
    `Dispatch contract for ${options.handoff.workloadId}`,
    "",
    `- source plan: ${options.sourcePlanPath}`,
    `- stage: ${options.handoff.stageId} — ${options.handoff.goal}`,
    `- repo: ${options.target.repo}`,
    `- branch/base: ${branchDetail}`,
    `- scoped paths: ${targetPaths}`,
    `- next action: ${options.handoff.nextAction}`,
    "",
    "Remaining gates:",
    ...options.handoff.remainingGates.map((gate) => `- ${gate}`),
    "",
    "Handoff JSON:",
    "```json",
    JSON.stringify(options.handoff, null, 2),
    "```",
  ].join("\n");
};

const buildDispatchExecutionLoop = (options: {
  recommendation: WorkloadDispatchRecommendation;
  reservedPaths: string[];
  hasRecipient: boolean;
}): WorkloadExecutionLoop => {
  const approvalPrompt = options.hasRecipient
    ? "Present the stage-specific dispatch contract, confirm the recipient/stage, then ask 'approved?' before sending the baton."
    : "Present the dispatch contract, make the recipient explicit, then ask 'approved?' before sending anything.";

  let approvedNextStep: string;

  switch (options.recommendation) {
    case "clarify-recipient-before-sending":
      approvedNextStep =
        "Do not send yet. Name the receiving agent explicitly or keep the stage local; a dispatch contract without an owner is just paperwork.";
      break;
    case "dispatch-is-overkill-keep-it-inline":
      approvedNextStep =
        options.reservedPaths.length > 0
          ? "If approval already exists, stop bouncing the slice around: reserve the scoped files and execute the selected stage now."
          : "If approval already exists, keep the stage inline and execute it now instead of inventing handoff theatre.";
      break;
    case "dispatch-after-health-check":
      approvedNextStep =
        "If approved, check runtime health first, then send or execute the selected stage through the managed path.";
      break;
    case "execute-dispatched-stage-now":
    default:
      approvedNextStep =
        "If approved, reserve the scoped files, send the contract if another agent owns the stage, and execute without re-planning it from scratch.";
      break;
  }

  return {
    approvalPrompt,
    approvedNextStep,
    progressUpdateExpectation:
      "While the stage is running, let the pi extension/TUI show handoff and execution status. Only interrupt the operator for blockers, changed scope, or a genuine decision point.",
    completionExpectation:
      "Finish with the selected stage outcome, verification, remaining gates, and whether another handoff, a push, or a stop is warranted.",
  };
};

const buildDispatchGuidance = (options: {
  result: WorkloadPlanningResult;
  stage: WorkloadStage;
  reservedPaths: string[];
  to?: string;
  explicitStageId?: string;
}): WorkloadDispatchGuidance => {
  const stageIsFirst = options.result.plan.stages[0]?.id === options.stage.id;
  const stageReason = options.explicitStageId
    ? `Caller explicitly chose ${options.stage.id}; dispatch is honoring that pinned stage instead of guessing.`
    : stageIsFirst
      ? `${options.stage.id} is the first executable stage in the saved plan, so dispatch defaults to it.`
      : `${options.stage.id} is the next stage selected from the saved plan.`;

  let recommendation: WorkloadDispatchRecommendation;
  let summary: string;

  if (!options.to) {
    recommendation = "clarify-recipient-before-sending";
    summary =
      "The dispatch contract is valid, but sending it is pointless until you name the receiving agent. Keep it local or set --to explicitly.";
  } else if (
    options.result.guidance.recommendedExecution === "execute-inline-now" &&
    stageIsFirst
  ) {
    recommendation = "dispatch-is-overkill-keep-it-inline";
    summary =
      "This workload was already a bounded inline slice. Dispatch exists if you want a formal baton pass, but the honest default is to execute the stage now instead of bouncing it around.";
  } else if (
    options.result.guidance.recommendedExecution ===
    "dispatch-after-health-check"
  ) {
    recommendation = "dispatch-after-health-check";
    summary =
      "This stage wants managed runtime posture. Check system health before you send the baton so the handoff does not land on a sick runtime.";
  } else {
    recommendation = "execute-dispatched-stage-now";
    summary =
      "The dispatch contract is ready. Reserve the scoped paths and execute the selected stage instead of re-planning it from scratch.";
  }

  if (options.reservedPaths.length === 0) {
    summary = `${summary} Path scope is still repo-wide, so tighten ownership before editing if the stage starts to sprawl.`;
  }

  return {
    recommendation,
    summary,
    stageReason,
    adrCoverage: options.result.guidance.adrCoverage,
    recommendedSkills: options.result.guidance.recommendedSkills,
    executionLoop: buildDispatchExecutionLoop({
      recommendation,
      reservedPaths: options.reservedPaths,
      hasRecipient: Boolean(options.to),
    }),
  };
};

const buildDispatchContract = (options: {
  sourcePlanPath: string;
  result: WorkloadPlanningResult;
  stageId?: string;
  from?: string;
  to?: string;
  now?: Date;
}): WorkloadDispatchResult => {
  const stage = selectDispatchStage(options.result, options.stageId);
  const stageIndex = options.result.plan.stages.findIndex(
    (candidate) => candidate.id === stage.id,
  );
  const target = options.result.request.targets[0]!;
  const reservedPaths = dedupe(stage.reservedPaths ?? target.paths ?? []);
  const remainingGates = options.result.plan.stages
    .slice(stageIndex)
    .map((candidate) => `${candidate.id}: ${candidate.name}`);
  const guidance = buildDispatchGuidance({
    result: options.result,
    stage,
    reservedPaths,
    to: options.to,
    explicitStageId: options.stageId,
  });
  const handoff: WorkloadHandoff = {
    workloadId: options.result.plan.workloadId,
    stageId: stage.id,
    goal: stage.name,
    currentState: `planned from ${options.sourcePlanPath}; ${stage.id} is the next executable stage`,
    artifactsProduced: [options.sourcePlanPath],
    verificationDone: options.result.plan.verification,
    remainingGates,
    reservedPaths,
    releasedPaths: [],
    risks: options.result.plan.risks,
    nextAction:
      guidance.recommendation === "dispatch-after-health-check"
        ? `check system health, then execute ${stage.id}: ${stage.name}`
        : `execute ${stage.id}: ${stage.name}`,
  };

  return {
    version: WORKLOAD_VERSION,
    dispatchId: buildDispatchId(options.now),
    sourcePlan: {
      path: options.sourcePlanPath,
      workloadId: options.result.plan.workloadId,
    },
    selectedStage: stage,
    target,
    guidance,
    handoff,
    mail: {
      subject: buildDispatchMailSubject(options.result.plan.workloadId, stage),
      body: buildDispatchMailBody({
        sourcePlanPath: options.sourcePlanPath,
        target,
        handoff,
      }),
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
    },
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

const buildRunId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WR_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

const resolveRepoUrlForRun = (
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

const buildWorkloadRunTask = (options: {
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

const buildWorkloadRunResult = (options: {
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

const buildRunNextActions = (
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

const resolvePresetDefaults = (input: PlannerInput): PlannerInputResolution => {
  if (!input.preset) {
    return {
      normalized: { ...input },
    };
  }

  const definition = WORKLOAD_PRESET_DEFINITIONS[input.preset];
  const appliedDefaults: string[] = [];

  const kind =
    input.kind === "auto" && definition.kind ? definition.kind : input.kind;
  if (input.kind === "auto" && definition.kind) {
    appliedDefaults.push(`kind=${definition.kind}`);
  }

  const shape =
    input.shape === "auto" && definition.shape ? definition.shape : input.shape;
  if (input.shape === "auto" && definition.shape) {
    appliedDefaults.push(`shape=${definition.shape}`);
  }

  const riskText =
    input.riskText ??
    (definition.risk && definition.risk.length > 0
      ? definition.risk.join(",")
      : undefined);
  if (!input.riskText && definition.risk && definition.risk.length > 0) {
    appliedDefaults.push(`risk=${definition.risk.join(",")}`);
  }

  const artifactsText =
    input.artifactsText ??
    (definition.artifacts && definition.artifacts.length > 0
      ? definition.artifacts.join(",")
      : undefined);
  if (
    !input.artifactsText &&
    definition.artifacts &&
    definition.artifacts.length > 0
  ) {
    appliedDefaults.push(`artifacts=${definition.artifacts.join(",")}`);
  }

  const acceptanceText =
    input.acceptanceText ??
    (definition.acceptance && definition.acceptance.length > 0
      ? definition.acceptance.join("|")
      : undefined);
  if (
    !input.acceptanceText &&
    definition.acceptance &&
    definition.acceptance.length > 0
  ) {
    appliedDefaults.push("acceptance=from-preset");
  }

  return {
    normalized: {
      ...input,
      kind,
      shape,
      riskText,
      artifactsText,
      acceptanceText,
    },
    preset:
      appliedDefaults.length > 0
        ? {
            name: input.preset,
            description: definition.description,
            appliedDefaults,
          }
        : undefined,
  };
};

const inferKind = (
  intent: string,
  provided: WorkloadKindChoice,
): Resolution<WorkloadKind> => {
  if (provided !== "auto") {
    return {
      value: provided,
      inferred: false,
      reason: `kind pinned by caller to ${provided}`,
    };
  }

  const value = lower(intent);

  if (
    hasAny(value, [
      "cross repo",
      "cross-repo",
      "multi repo",
      "multi-repo",
      "two repos",
      "multiple repos",
      "external repo",
    ])
  ) {
    return {
      value: "cross-repo.integration",
      inferred: true,
      reason: "intent references multi-repo or external-repo work",
    };
  }

  if (
    hasAny(value, [
      "canary",
      "soak",
      "proof window",
      "live proof",
      "runtime proof",
      "drill",
      "observer",
      "pause/resume",
    ])
  ) {
    return {
      value: "runtime.proof",
      inferred: true,
      reason: "intent reads like a live proof, canary, soak, or runtime drill",
    };
  }

  if (
    hasAny(value, [
      "research",
      "spike",
      "compare",
      "comparison",
      "investigate",
      "explore",
      "evaluate",
    ])
  ) {
    return {
      value: "research.spike",
      inferred: true,
      reason: "intent reads like investigation or comparison work",
    };
  }

  if (
    hasAny(value, [
      "refactor",
      "extend",
      "migrate",
      "rename",
      "extract",
      "reshape",
      "restructure",
      "cleanup",
    ])
  ) {
    return {
      value: "repo.refactor",
      inferred: true,
      reason:
        "intent describes structural code change with likely regression risk, even if docs follow-up is part of the work",
    };
  }

  if (
    hasAny(value, [
      "review",
      "audit",
      "verify",
      "inspection",
      "inspect",
      "check",
    ]) &&
    !hasAny(value, [
      "implement",
      "fix",
      "refactor",
      "extend",
      "write",
      "add",
      "ship",
    ])
  ) {
    return {
      value: "repo.review",
      inferred: true,
      reason:
        "intent emphasizes review or verification without primary implementation language",
    };
  }

  if (
    hasAny(value, [
      "adr",
      "docs",
      "documentation",
      "readme",
      "truth",
      "groom",
      "writeup",
    ])
  ) {
    return {
      value: "repo.docs",
      inferred: true,
      reason: "intent emphasizes docs, ADRs, or truth-grooming work",
    };
  }

  return {
    value: "repo.patch",
    inferred: true,
    reason:
      "defaulted to repo.patch because the intent looks like direct implementation work",
  };
};

const chooseShape = (
  intent: string,
  kind: WorkloadKind,
  provided: WorkloadShapeChoice,
): ShapeResolution => {
  if (provided !== "auto") {
    return {
      value: provided,
      inferred: false,
      reason: `shape pinned by caller to ${provided}`,
    };
  }

  const value = lower(intent);

  if (
    hasAny(value, [
      "parallel",
      "fan out",
      "fan-out",
      "compare",
      "spike",
      "branches",
    ])
  ) {
    return {
      value: "parallel",
      inferred: true,
      reason: "intent asks for branching or comparative work",
    };
  }

  if (
    hasAny(value, [
      "chained",
      "handoff",
      "then verify",
      "then document",
      "implement then",
      "review after",
    ])
  ) {
    return {
      value: "chained",
      inferred: true,
      reason: "intent explicitly implies stage-specialized handoff",
    };
  }

  switch (kind) {
    case "research.spike":
      return {
        value: "parallel",
        inferred: true,
        reason:
          "research spikes benefit from independent branches and later synthesis",
      };
    case "repo.refactor":
    case "cross-repo.integration":
      return {
        value: "chained",
        inferred: true,
        reason: `${kind} usually benefits from explicit implementation → verification → handoff stages`,
      };
    case "runtime.proof":
    case "repo.patch":
    case "repo.docs":
    case "repo.review":
    default:
      return {
        value: "serial",
        inferred: true,
        reason: `${kind} defaults to ordered gates because one stage depends on the previous one being correct`,
      };
  }
};

const inferRisks = (
  intent: string,
  kind: WorkloadKind,
  autonomy: AutonomyLevel,
  explicitRiskText: string | undefined,
): { values: RiskPosture[]; inferred: boolean; warnings: string[] } => {
  const parsed = parseEnumList(explicitRiskText, RISK_POSTURES);
  const warnings = parsed.unknown.map(
    (risk) => `ignored unknown risk posture: ${risk}`,
  );
  const values = [...parsed.values];
  const value = lower(intent);

  if (!values.includes("reversible-only")) {
    values.push("reversible-only");
  }

  if (hasExplicitDeployIntent(value) && !values.includes("deploy-allowed")) {
    values.push("deploy-allowed");
  }

  if (
    (autonomy === "afk" || hasExplicitIsolationIntent(value)) &&
    !values.includes("sandbox-required") &&
    kind !== "runtime.proof"
  ) {
    values.push("sandbox-required");
  }

  if (kind === "runtime.proof" && !values.includes("human-signoff")) {
    values.push("human-signoff");
  }

  if (
    !values.includes("sandbox-required") &&
    !values.includes("host-okay") &&
    autonomy !== "blocked" &&
    kind !== "runtime.proof"
  ) {
    values.push("host-okay");
  }

  return {
    values: dedupe(values),
    inferred: !explicitRiskText || parsed.values.length === 0,
    warnings,
  };
};

const chooseMode = (
  kind: WorkloadKind,
  autonomy: AutonomyLevel,
  proof: ProofPosture,
  risks: readonly RiskPosture[],
): Resolution<ExecutionMode> => {
  if (autonomy === "blocked") {
    return {
      value: "blocked",
      inferred: false,
      reason: "autonomy was explicitly set to blocked",
    };
  }

  if (risks.includes("sandbox-required")) {
    return {
      value: "sandbox",
      inferred: true,
      reason:
        "risk posture requires isolation before any mutation or delegation",
    };
  }

  if (autonomy === "afk") {
    return {
      value: "loop",
      inferred: true,
      reason:
        "AFK autonomy implies an explicit autonomous loop rather than manual inline work",
    };
  }

  if (kind === "runtime.proof") {
    return {
      value: "durable",
      inferred: true,
      reason:
        "runtime proof work wants a tracked durable path instead of an ad-hoc inline session",
    };
  }

  if (kind === "cross-repo.integration") {
    return {
      value: "durable",
      inferred: true,
      reason:
        "cross-repo integration work usually benefits from an explicit bridgeable durable path",
    };
  }

  if (proof === "canary" || proof === "soak") {
    return {
      value: "inline",
      inferred: true,
      reason:
        "proof posture alone does not force durable execution for supervised repo work",
    };
  }

  return {
    value: "inline",
    inferred: true,
    reason:
      "nothing about the workload justifies background durability or isolation yet",
  };
};

const chooseBackend = (
  kind: WorkloadKind,
  mode: ExecutionMode,
  autonomy: AutonomyLevel,
): Resolution<BackendClass> => {
  switch (mode) {
    case "blocked":
      return {
        value: "none",
        inferred: false,
        reason: "blocked work has no execution backend yet",
      };
    case "inline":
      return {
        value: "host",
        inferred: true,
        reason:
          "inline planning or execution defaults to the local host session",
      };
    case "sandbox":
      return {
        value: autonomy === "afk" ? "k8s-sandbox" : "local-sandbox",
        inferred: true,
        reason:
          autonomy === "afk"
            ? "AFK isolated work wants a stronger remote sandbox boundary"
            : "sandboxed supervised work defaults to a local isolated sandbox",
      };
    case "loop":
      return {
        value: "local-sandbox",
        inferred: true,
        reason:
          "loop-driven code work should still mutate in an isolated sandbox boundary",
      };
    case "durable":
      return {
        value: kind === "cross-repo.integration" ? "queue" : "restate",
        inferred: true,
        reason:
          kind === "cross-repo.integration"
            ? "cross-repo durable work enters through the queue/bridge boundary"
            : "durable workload planning defaults to the Restate-backed tracked executor path",
      };
  }
};

const inferArtifacts = (
  intent: string,
  kind: WorkloadKind,
  shape: WorkloadShape,
  explicitArtifactsText: string | undefined,
): { values: ArtifactName[]; inferred: boolean; warnings: string[] } => {
  const parsed = parseEnumList(explicitArtifactsText, ARTIFACT_NAMES);
  const warnings = parsed.unknown.map(
    (artifact) => `ignored unknown artifact: ${artifact}`,
  );
  const values = [...parsed.values];
  const value = lower(intent);

  if (values.length === 0) {
    switch (kind) {
      case "repo.patch":
        values.push("patch", "verification", "summary");
        break;
      case "repo.refactor":
        values.push("patch", "tests", "verification", "summary");
        break;
      case "repo.docs":
        values.push("docs", "summary");
        break;
      case "repo.review":
        values.push("verification", "summary", "handoff");
        break;
      case "research.spike":
        values.push("research-note", "summary");
        break;
      case "runtime.proof":
        values.push("telemetry-proof", "summary", "rollback-plan");
        break;
      case "cross-repo.integration":
        values.push("handoff", "summary", "verification");
        break;
    }
  }

  if (hasAny(value, ["adr"]) && !values.includes("adr")) values.push("adr");
  if (
    hasAny(value, ["docs", "documentation", "readme"]) &&
    !values.includes("docs")
  ) {
    values.push("docs");
  }
  if (hasAny(value, ["test", "tests"]) && !values.includes("tests")) {
    values.push("tests");
  }
  if (shape === "chained" && !values.includes("handoff")) {
    values.push("handoff");
  }
  if (
    shape === "parallel" &&
    kind === "research.spike" &&
    !values.includes("comparison")
  ) {
    values.push("comparison");
  }
  if (kind === "runtime.proof" && !values.includes("telemetry-proof")) {
    values.push("telemetry-proof");
  }
  if (kind === "runtime.proof" && !values.includes("rollback-plan")) {
    values.push("rollback-plan");
  }

  return {
    values: dedupe(values),
    inferred: parsed.values.length === 0,
    warnings,
  };
};

const defaultAcceptance = (
  kind: WorkloadKind,
  shape: WorkloadShape,
  mode: ExecutionMode,
): string[] => {
  const base = [
    `the planner classifies this as ${kind}`,
    `the execution shape is ${shape} with explicit reasoning`,
    `the execution mode is ${mode} without requiring runtime-internal knowledge from the caller`,
  ];

  if (kind === "runtime.proof") {
    base.push(
      "the proof window, telemetry evidence, and rollback posture are explicit before execution",
    );
  }

  if (kind === "repo.docs") {
    base.push("shipped behavior is kept separate from planned surfaces");
  }

  if (shape === "chained") {
    base.push("handoff artifacts between stages are explicit");
  }

  return base;
};

const buildVerification = (
  kind: WorkloadKind,
  shape: WorkloadShape,
  mode: ExecutionMode,
  artifacts: readonly ArtifactName[],
): string[] => {
  const checks = [
    "request and plan use the canonical fields from docs/workloads.md",
    "the chosen shape, mode, and backend are explained in plain language",
  ];

  if (artifacts.includes("tests")) {
    checks.push("test scope is named before execution starts");
  }

  if (shape === "parallel") {
    checks.push(
      "parallel branches have an explicit synthesis owner before dispatch",
    );
  }

  if (kind === "runtime.proof") {
    checks.push(
      "anchors, run ids, and rollback criteria are named before any live proof starts",
    );
  }

  if (mode === "durable" || mode === "loop" || mode === "sandbox") {
    checks.push(
      "runtime health should be checked before dispatching beyond the planning surface",
    );
  }

  return dedupe(checks);
};

const buildStages = ({
  kind,
  shape,
  mode,
  artifacts,
  intent,
  acceptance,
  targetPaths,
}: {
  kind: WorkloadKind;
  shape: WorkloadShape;
  mode: ExecutionMode;
  artifacts: readonly ArtifactName[];
  intent: string;
  acceptance: readonly string[];
  targetPaths?: readonly string[];
}): WorkloadStage[] => {
  const reservedPaths =
    targetPaths && targetPaths.length > 0 ? dedupe(targetPaths) : undefined;
  const executionOwner = mode === "inline" ? "planner" : "worker";
  const implementationOutputs = artifacts.filter(
    (artifact) => artifact !== "handoff" && artifact !== "summary",
  );

  if (shape === "parallel") {
    return [
      {
        id: "stage-1a",
        name: "branch A",
        owner: "worker-a",
        mode,
        inputs: ["workload request", "shared acceptance criteria"],
        outputs: artifacts.includes("research-note")
          ? ["research-note"]
          : [artifacts[0] ?? "summary"],
        reservedPaths,
        verification: ["branch scope stays independent"],
        stopConditions: ["file overlap or branch scope ambiguity appears"],
      },
      {
        id: "stage-1b",
        name: "branch B",
        owner: "worker-b",
        mode,
        inputs: ["workload request", "shared acceptance criteria"],
        outputs: artifacts.includes("comparison")
          ? ["comparison"]
          : [artifacts[0] ?? "summary"],
        reservedPaths,
        verification: ["branch scope stays independent"],
        stopConditions: ["file overlap or branch scope ambiguity appears"],
      },
      {
        id: "stage-2",
        name: "synthesize and choose a path",
        owner: "planner",
        mode: "inline",
        inputs: ["branch A results", "branch B results"],
        outputs: [
          "summary",
          ...(artifacts.includes("comparison") ? ["comparison"] : []),
        ],
        verification: ["one synthesis owner makes the recommendation explicit"],
        stopConditions: ["no branch produced a clear recommendation"],
        dependsOn: ["stage-1a", "stage-1b"],
      },
    ];
  }

  if (shape === "chained") {
    const goalMilestones =
      kind === "repo.patch" || kind === "repo.refactor"
        ? extractGoalMilestones(intent).slice(0, 6)
        : [];
    const stages: WorkloadStage[] = [];

    if (goalMilestones.length > 1) {
      for (const [index, milestone] of goalMilestones.entries()) {
        const stageId = `stage-${index + 1}`;
        const previousStageId = index > 0 ? `stage-${index}` : undefined;
        const isLastMilestone = index === goalMilestones.length - 1;

        stages.push({
          id: stageId,
          name: toStageName(milestone, `execute milestone ${index + 1}`),
          owner: executionOwner,
          mode,
          inputs:
            index === 0
              ? ["workload request", "acceptance criteria"]
              : [`${previousStageId} outputs`, "remaining scoped goals"],
          outputs: isLastMilestone
            ? implementationOutputs
            : [`milestone-${index + 1}-complete`],
          reservedPaths,
          verification: [
            `milestone ${index + 1} is explicit before the next stage starts`,
          ],
          stopConditions: ["scope expands beyond the planned boundary"],
          ...(previousStageId ? { dependsOn: [previousStageId] } : {}),
        });
      }
    } else {
      stages.push({
        id: "stage-1",
        name:
          kind === "repo.docs"
            ? "produce canonical docs change"
            : "execute primary work",
        owner: executionOwner,
        mode,
        inputs: ["workload request", "acceptance criteria"],
        outputs: implementationOutputs,
        reservedPaths,
        verification: [
          "primary artifact lands before verification stage starts",
        ],
        stopConditions: ["scope expands beyond the planned boundary"],
      });
    }

    const verificationStageId = `stage-${stages.length + 1}`;
    const implementationStageId = stages.at(-1)?.id ?? "stage-1";

    stages.push({
      id: verificationStageId,
      name: "verify independently",
      owner: "reviewer",
      mode: "inline",
      inputs: [`${implementationStageId} outputs`],
      outputs: artifacts.includes("verification")
        ? ["verification"]
        : ["summary"],
      verification: ["verification is recorded separately from implementation"],
      stopConditions: [
        "verification cannot explain what changed or what remains",
      ],
      dependsOn: [implementationStageId],
    });

    let priorStageId = verificationStageId;

    if (shouldInsertReflectionStage(intent, acceptance)) {
      const reflectionStageId = `stage-${stages.length + 1}`;
      stages.push({
        id: reflectionStageId,
        name: "reflect and update plan",
        owner: "planner",
        mode: "inline",
        inputs: [`${verificationStageId} outputs`, "acceptance criteria"],
        outputs: ["reflection-note", "plan-update"],
        verification: [
          "reflection changes the plan or explains why the plan still holds",
        ],
        stopConditions: [
          "reflection only restates the current plan without updating anything",
        ],
        dependsOn: [verificationStageId],
      });
      priorStageId = reflectionStageId;
    }

    stages.push({
      id: `stage-${stages.length + 1}`,
      name: "handoff and closeout",
      owner: "planner",
      mode: "inline",
      inputs: [
        `${implementationStageId} outputs`,
        `${verificationStageId} outputs`,
        ...(priorStageId !== verificationStageId
          ? [`${priorStageId} outputs`]
          : []),
      ],
      outputs: dedupe([
        ...(artifacts.includes("handoff") ? ["handoff"] : []),
        "summary",
      ]),
      verification: [
        "handoff and closeout use the same workload vocabulary as the plan",
      ],
      stopConditions: [
        "the next worker would need raw chat instead of structured artifacts",
      ],
      dependsOn: [priorStageId],
    });

    return stages;
  }

  return [
    {
      id: "stage-1",
      name: "scope and prepare",
      owner: "planner",
      mode: "inline",
      inputs: ["intent", "acceptance criteria"],
      outputs: ["workload plan"],
      verification: ["scope boundary and artifacts are explicit"],
      stopConditions: ["acceptance criteria are still mush"],
    },
    {
      id: "stage-2",
      name:
        kind === "runtime.proof" ? "run proof window" : "execute primary task",
      owner: executionOwner,
      mode,
      inputs: ["workload plan"],
      outputs: artifacts.filter((artifact) => artifact !== "summary"),
      reservedPaths,
      verification: [
        kind === "runtime.proof"
          ? "proof evidence is anchored"
          : "primary artifact is produced",
      ],
      stopConditions: ["execution drifts outside planned boundaries"],
      dependsOn: ["stage-1"],
    },
    {
      id: "stage-3",
      name: "verify and summarize",
      owner: "planner",
      mode: "inline",
      inputs: ["stage-2 outputs"],
      outputs: dedupe([
        ...(artifacts.includes("summary") ? ["summary"] : []),
        ...(artifacts.includes("handoff") ? ["handoff"] : []),
      ]),
      verification: ["result and next action are explicit"],
      stopConditions: ["closeout cannot explain done vs remaining work"],
      dependsOn: ["stage-2"],
    },
  ];
};

const buildWorkloadId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WL_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

const resolveTarget = (
  repoText: string | undefined,
  pathsText: string | undefined,
  pathsFromText: string | undefined,
): TargetResolution => {
  const warnings: string[] = [];
  const explicitPaths = splitCsv(pathsText);
  const directive = parsePathsFrom(pathsFromText);
  const candidate = repoText ? expandHome(repoText) : process.cwd();
  const looksLikeLocalPath =
    !repoText ||
    candidate.startsWith("/") ||
    candidate.startsWith(".") ||
    candidate.startsWith("~");

  if (looksLikeLocalPath) {
    const absolute = resolve(candidate);
    if (!existsSync(absolute)) {
      throw new Error(`Local repo path does not exist: ${absolute}`);
    }

    const branch = runGit(absolute, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const baseSha = runGit(absolute, ["rev-parse", "--short", "HEAD"]);

    if (!branch || !baseSha) {
      warnings.push(
        repoText
          ? `could not infer git branch/baseSha for local target ${absolute}`
          : `current working directory ${absolute} is not a git repo; pass --repo to pin the intended workload target`,
      );
    }

    let resolvedPaths: string[] | undefined;
    let scope: PathScopeSeed = {
      source: "repo-wide",
      pathCount: 0,
    };

    if (explicitPaths.length > 0) {
      resolvedPaths = explicitPaths;
      scope = {
        source: "explicit-paths",
        pathCount: explicitPaths.length,
      };

      if (directive) {
        warnings.push(
          `ignored --paths-from ${directive.raw} because explicit --paths was provided`,
        );
      }
    } else if (directive) {
      if (!branch || !baseSha) {
        throw new Error(
          `Target ${absolute} is not a git repo; --paths-from ${directive.raw} requires local git history`,
        );
      }

      const derived = collectPathsFromDirective(absolute, directive);
      scope = derived.scope;
      if (derived.paths.length > 0) {
        resolvedPaths = derived.paths;
      } else {
        warnings.push(
          `path scope helper ${directive.raw} produced no files; pass --paths explicitly if you want a scoped plan`,
        );
      }
    }

    return {
      value: {
        repo: absolute,
        branch: branch ?? undefined,
        baseSha: baseSha ?? undefined,
        paths: resolvedPaths,
      },
      inferred: !repoText,
      localRepo: true,
      warnings,
      scope,
    };
  }

  if (directive) {
    throw new Error(
      `Non-local repo target ${candidate} cannot use --paths-from ${directive.raw}; pass explicit --paths instead`,
    );
  }

  warnings.push(
    `treating ${candidate} as a non-local repo identifier; branch/baseSha were not inferred`,
  );

  return {
    value: {
      repo: candidate,
      paths: explicitPaths.length > 0 ? explicitPaths : undefined,
    },
    inferred: false,
    localRepo: false,
    warnings,
    scope:
      explicitPaths.length > 0
        ? {
            source: "explicit-paths",
            pathCount: explicitPaths.length,
          }
        : {
            source: "repo-wide",
            pathCount: 0,
          },
  };
};

const buildPlanLevelActions = (
  input: NormalizedPlannerInput,
  workloadId: string,
  target: TargetResolution,
  kind: Resolution<WorkloadKind>,
  shape: ShapeResolution,
  mode: Resolution<ExecutionMode>,
  artifactWritten: boolean,
): Array<{ command: string; description: string }> => {
  const actions: Array<{ command: string; description: string }> = [
    {
      command: `joelclaw workload plan ${shellQuote(input.intent)} --kind ${kind.value} --shape ${shape.value}`,
      description:
        "Re-run the planner with the inferred kind/shape pinned explicitly",
    },
  ];

  if (target.localRepo && !target.value.paths?.length) {
    actions.push({
      command: `joelclaw workload plan ${shellQuote(input.intent)} --repo ${shellQuote(target.value.repo)} --paths-from recent:3`,
      description:
        "Seed path scope from recent repo activity before trying to schedule repo-wide work",
    });
  }

  if (!artifactWritten) {
    actions.push({
      command: `joelclaw workload plan ${shellQuote(input.intent)} --repo ${shellQuote(target.value.repo)}${target.value.paths?.length ? ` --paths ${shellQuote(target.value.paths.join(","))}` : target.scope.source !== "repo-wide" && target.scope.detail ? ` --paths-from ${target.scope.detail}` : ""} --write-plan ${shellQuote(defaultPlanArtifactPath(workloadId))}`,
      description:
        "Write the full workload envelope to a reusable handoff artifact",
    });
  }

  if (
    mode.value === "durable" ||
    mode.value === "loop" ||
    mode.value === "sandbox"
  ) {
    actions.push({
      command: "joelclaw status",
      description: "Check runtime health before dispatching beyond planning",
    });
  }

  return actions;
};

const planWorkload = (
  rawInput: PlannerInput,
  now = new Date(),
): WorkloadPlanningResult => {
  const workloadId = buildWorkloadId(now);
  const inputResolution = resolvePresetDefaults(rawInput);
  const input = inputResolution.normalized;
  const kind = inferKind(input.intent, input.kind);
  const shape = chooseShape(input.intent, kind.value, input.shape);
  const risks = inferRisks(
    input.intent,
    kind.value,
    input.autonomy,
    input.riskText,
  );
  const mode = chooseMode(
    kind.value,
    input.autonomy,
    input.proof,
    risks.values,
  );
  const backend = chooseBackend(kind.value, mode.value, input.autonomy);
  const artifacts = inferArtifacts(
    input.intent,
    kind.value,
    shape.value,
    input.artifactsText,
  );
  const target = resolveTarget(
    input.repoText,
    input.pathsText,
    input.pathsFromText,
  );
  const acceptance =
    splitDelimited(input.acceptanceText).length > 0
      ? splitDelimited(input.acceptanceText)
      : extractAcceptanceFromIntent(input.intent);

  const request: WorkloadRequest = {
    version: WORKLOAD_VERSION,
    kind: kind.value,
    intent: input.intent,
    requestedBy: input.requestedBy,
    shape: shape.value,
    autonomy: input.autonomy,
    proof: input.proof,
    risk: risks.values,
    targets: [target.value],
    acceptance:
      acceptance.length > 0
        ? acceptance
        : defaultAcceptance(kind.value, shape.value, mode.value),
    artifacts: artifacts.values,
    constraints: {
      mustFollow: [
        "use clawmail for shared-file work",
        "keep shipped docs separate from planned CLI behavior",
      ],
      avoid: ["pretending unshipped workload subcommands already exist"],
    },
    context: {
      adr: ["ADR-0217"],
      steering: "agent-first workload ergonomics",
      notes: ["planner-only CLI surface shipped in Phase 4.2"],
    },
  };

  const plan: WorkloadPlan = {
    workloadId,
    version: WORKLOAD_VERSION,
    status: "planned",
    kind: kind.value,
    shape: shape.value,
    mode: mode.value,
    backend: backend.value,
    summary: `${shape.value} ${kind.value} planned for ${mode.value} execution on ${backend.value}`,
    why: [kind.reason, shape.reason, mode.reason, backend.reason],
    risks: risks.values.map((risk) => `risk posture: ${risk}`),
    artifacts: artifacts.values,
    verification: buildVerification(
      kind.value,
      shape.value,
      mode.value,
      artifacts.values,
    ),
    stages: buildStages({
      kind: kind.value,
      shape: shape.value,
      mode: mode.value,
      artifacts: artifacts.values,
      intent: input.intent,
      acceptance,
      targetPaths: target.value.paths,
    }),
    next_actions: buildPlanLevelActions(
      input,
      workloadId,
      target,
      kind,
      shape,
      mode,
      false,
    ),
  };

  const guidance = buildWorkloadGuidance(input, request, plan);

  return {
    request,
    plan,
    guidance,
    inference: {
      kind,
      shape,
      mode,
      backend,
      risks: { value: risks.values, inferred: risks.inferred },
      artifacts: { value: artifacts.values, inferred: artifacts.inferred },
      target: {
        value: target.value,
        inferred: target.inferred,
        localRepo: target.localRepo,
        scope: target.scope,
      },
    },
    warnings: dedupe([
      ...risks.warnings,
      ...artifacts.warnings,
      ...target.warnings,
      ...(acceptance.length === 0
        ? [
            "no explicit acceptance criteria were provided; the planner inferred defaults",
          ]
        : []),
      ...(!target.value.paths || target.value.paths.length === 0
        ? [
            "no explicit path scope was provided; the workload is currently repo-wide",
          ]
        : []),
    ]),
    ...(inputResolution.preset ? { preset: inputResolution.preset } : {}),
    shipped: {
      plan: true,
      run: true,
      status: false,
      explain: false,
      cancel: false,
    },
  };
};

const planIntentArg = Args.text({ name: "intent" }).pipe(
  Args.withDescription("Natural-language workload intent"),
);

const presetOption = Options.choice("preset", WORKLOAD_PRESETS).pipe(
  Options.withDescription(
    "Reusable planning preset for common workload shapes",
  ),
  Options.optional,
);

const kindOption = Options.choice("kind", WORKLOAD_KIND_CHOICES).pipe(
  Options.withDescription("Workload kind (or auto-infer it)"),
  Options.withDefault("auto"),
);

const shapeOption = Options.choice("shape", WORKLOAD_SHAPES).pipe(
  Options.withDescription("Execution shape (or auto-infer it)"),
  Options.withDefault("auto"),
);

const autonomyOption = Options.choice("autonomy", AUTONOMY_LEVELS).pipe(
  Options.withDescription("Autonomy level for the planned workload"),
  Options.withDefault("supervised"),
);

const proofOption = Options.choice("proof", PROOF_POSTURES).pipe(
  Options.withDescription("Proof posture for the planned workload"),
  Options.withDefault("none"),
);

const riskOption = Options.text("risk").pipe(
  Options.withDescription("Comma-separated risk postures"),
  Options.optional,
);

const artifactsOption = Options.text("artifacts").pipe(
  Options.withDescription("Comma-separated artifact names"),
  Options.optional,
);

const acceptanceOption = Options.text("acceptance").pipe(
  Options.withDescription("Pipe-delimited acceptance criteria"),
  Options.optional,
);

const repoOption = Options.text("repo").pipe(
  Options.withDescription(
    "Repo path or owner/repo identifier (defaults to current working directory)",
  ),
  Options.optional,
);

const pathsOption = Options.text("paths").pipe(
  Options.withDescription("Comma-separated path scope within the target repo"),
  Options.optional,
);

const pathsFromOption = Options.text("paths-from").pipe(
  Options.withDescription(
    "Seed path scope from repo activity: status, head, or recent:<n>",
  ),
  Options.optional,
);

const writePlanOption = Options.text("write-plan").pipe(
  Options.withDescription(
    "Write the full workload envelope to a reusable JSON artifact",
  ),
  Options.optional,
);

const requestedByOption = Options.text("requested-by").pipe(
  Options.withDescription("Who requested the workload"),
  Options.withDefault("Joel"),
);

const dispatchPlanArtifactArg = Args.text({ name: "plan-artifact" }).pipe(
  Args.withDescription("Path to a saved workload plan envelope"),
);

const dispatchStageOption = Options.text("stage").pipe(
  Options.withDescription(
    "Which stage id to dispatch (defaults to the first stage)",
  ),
  Options.optional,
);

const dispatchProjectOption = Options.text("project").pipe(
  Options.withDescription("Mail project key for optional task dispatch"),
  Options.withDefault("/Users/joel/Code/joelhooks/joelclaw"),
);

const dispatchFromOption = Options.text("from").pipe(
  Options.withDescription("Sender agent name for optional mail dispatch"),
  Options.withDefault("MaroonReef"),
);

const dispatchToOption = Options.text("to").pipe(
  Options.withDescription("Recipient agent name for optional mail dispatch"),
  Options.optional,
);

const sendMailOption = Options.boolean("send-mail").pipe(
  Options.withDescription("Send the dispatch contract through joelclaw mail"),
  Options.withDefault(false),
);

const writeDispatchOption = Options.text("write-dispatch").pipe(
  Options.withDescription(
    "Write the dispatch contract to a reusable JSON artifact",
  ),
  Options.optional,
);

const runPlanArtifactArg = Args.text({ name: "plan-artifact" }).pipe(
  Args.withDescription("Path to a saved workload plan envelope"),
);

const runStageOption = Options.text("stage").pipe(
  Options.withDescription("Which stage id to enqueue (defaults to the first stage)"),
  Options.optional,
);

const runToolOption = Options.text("tool").pipe(
  Options.withDescription("Background agent tool for the runtime request"),
  Options.withDefault("pi"),
);

const runTimeoutOption = Options.integer("timeout").pipe(
  Options.withDescription("Runtime timeout in seconds"),
  Options.optional,
);

const runModelOption = Options.text("model").pipe(
  Options.withDescription("Optional model override for the runtime worker"),
  Options.optional,
);

const runExecutionModeOption = Options.text("execution-mode").pipe(
  Options.withDescription("Execution mode override: auto, host, or sandbox"),
  Options.withDefault("auto"),
);

const runSandboxBackendOption = Options.text("sandbox-backend").pipe(
  Options.withDescription("Sandbox backend override when sandbox mode is selected"),
  Options.withDefault("local"),
);

const runSandboxModeOption = Options.text("sandbox-mode").pipe(
  Options.withDescription("Local sandbox mode override when sandbox mode is selected: minimal or full"),
  Options.withDefault("minimal"),
);

const runRepoUrlOption = Options.text("repo-url").pipe(
  Options.withDescription("Explicit repo URL when the workload target is not a local checkout"),
  Options.optional,
);

const runDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Print the canonical runtime request without enqueueing it"),
  Options.withDefault(false),
);

const sandboxesStateOption = Options.text("state").pipe(
  Options.withDescription("Filter local sandboxes by state"),
  Options.optional,
);

const sandboxesModeOption = Options.text("mode").pipe(
  Options.withDescription("Filter local sandboxes by mode: minimal or full"),
  Options.optional,
);

const sandboxesLimitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of sandbox entries to return"),
  Options.withDefault(25),
);

const sandboxesExpiredOption = Options.boolean("expired").pipe(
  Options.withDescription("Only include or clean up sandboxes whose TTL has expired"),
  Options.withDefault(false),
);

const sandboxesRequestIdOption = Options.text("request-id").pipe(
  Options.withDescription("Comma-separated request ids to target for cleanup"),
  Options.optional,
);

const sandboxesSandboxIdOption = Options.text("sandbox-id").pipe(
  Options.withDescription("Comma-separated sandbox ids to target for cleanup"),
  Options.optional,
);

const sandboxesAllTerminalOption = Options.boolean("all-terminal").pipe(
  Options.withDescription("Target every terminal local sandbox for cleanup"),
  Options.withDefault(false),
);

const sandboxesForceOption = Options.boolean("force").pipe(
  Options.withDescription("Allow cleanup of non-terminal sandboxes"),
  Options.withDefault(false),
);

const sandboxesDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Describe the cleanup/janitor action without deleting anything"),
  Options.withDefault(false),
);

const buildPlanNextActions = (
  input: NormalizedPlannerInput,
  result: WorkloadPlanningResult,
): NextAction[] => {
  const actions: NextAction[] = [];
  const scopedPaths = result.inference.target.value.paths ?? [];

  for (const skill of result.guidance.recommendedSkills) {
    if (skill.missingConsumers.length > 0) {
      actions.push({
        command:
          "skills ensure <skill> [--source-root <repo>] [--consumer <consumer>]",
        description: `Install or repair the ${skill.name} skill before continuing`,
        params: {
          skill: {
            description: "Skill name",
            value: skill.name,
            required: true,
          },
          ...(skill.sourceRoot
            ? {
                repo: {
                  description: "Repo root containing skills/<name>/SKILL.md",
                  value: skill.sourceRoot,
                },
              }
            : {}),
          consumer: {
            description: "Which agent consumer dirs to maintain",
            value: "all",
            enum: ["all", "agents", "pi", "claude"],
          },
        },
      });
    }

    if (skill.readPath) {
      actions.push({
        command: "read <path>",
        description: `Load ${skill.name} before acting on this workload`,
        params: {
          path: {
            description: "Skill file path",
            value: skill.readPath,
            required: true,
          },
        },
      });
    }
  }

  if (
    result.guidance.recommendedExecution === "tighten-scope-first" &&
    result.inference.target.localRepo
  ) {
    actions.push({
      command: "workload plan <intent> --repo <repo> --paths-from <paths-from>",
      description:
        "Tighten the path scope from real repo activity before editing anything",
      params: {
        intent: {
          description: "Natural-language workload intent",
          value: input.intent,
          required: true,
        },
        repo: {
          description: "Local repo path",
          value: result.inference.target.value.repo,
          required: true,
        },
        "paths-from": {
          description: "Path scope helper",
          value: "recent:3",
          required: true,
        },
      },
    });
  }

  if (
    result.guidance.recommendedExecution === "execute-inline-now" &&
    scopedPaths.length > 0
  ) {
    actions.push({
      command: "mail reserve --paths <paths> --agent <agent>",
      description:
        "If approved, reserve the scoped files and execute inline now instead of over-dispatching the slice",
      params: {
        paths: {
          description: "Comma-separated file paths",
          value: scopedPaths.join(","),
          required: true,
        },
        agent: {
          description: "Agent name reserving the work",
          value: "AGENT_NAME",
          required: true,
        },
      },
    });
  }

  if (
    result.guidance.recommendedExecution === "dispatch-after-health-check"
  ) {
    actions.push({
      command: "status",
      description:
        "Check system health before dispatching this beyond planning",
    });
  }

  actions.push({
    command:
      "workload plan <intent> [--preset <preset>] [--kind <kind>] [--shape <shape>] [--autonomy <autonomy>] [--proof <proof>] [--repo <repo>] [--paths <paths>] [--paths-from <paths-from>] [--write-plan <path>]",
    description: "Refine the plan with explicit overrides",
    params: {
      intent: {
        description: "Natural-language workload intent",
        value: input.intent,
        required: true,
      },
      ...(result.preset
        ? {
            preset: {
              description: "Planning preset",
              value: result.preset.name,
              enum: WORKLOAD_PRESETS,
            },
          }
        : {}),
      kind: {
        description: "Workload kind override",
        value: result.plan.kind,
      },
      shape: {
        description: "Execution shape override",
        value: result.plan.shape,
      },
      autonomy: {
        description: "Autonomy level",
        value: result.request.autonomy,
      },
      proof: { description: "Proof posture", value: result.request.proof },
      repo: {
        description: "Repo path or repo identifier",
        value: result.inference.target.value.repo,
      },
      paths: {
        description: "Comma-separated path scope",
        value: scopedPaths.join(","),
      },
      ...(result.inference.target.scope.source !== "repo-wide"
        ? {
            "paths-from": {
              description: "Path scope helper",
              value:
                result.inference.target.scope.detail ??
                (result.inference.target.scope.source === "git-status"
                  ? "status"
                  : result.inference.target.scope.source === "git-head"
                    ? "head"
                    : "recent:3"),
            },
          }
        : {}),
      ...(result.artifact
        ? {
            "write-plan": {
              description: "Existing plan artifact path",
              value: result.artifact.path,
            },
          }
        : {
            "write-plan": {
              description: "Where to write the plan JSON",
              value: defaultPlanArtifactPath(result.plan.workloadId),
            },
          }),
    },
  });

  if (!result.artifact) {
    actions.push({
      command:
        "workload plan <intent> [--repo <repo>] [--paths <paths>] [--paths-from <paths-from>] --write-plan <path>",
      description:
        result.guidance.recommendedExecution === "execute-inline-now"
          ? "If approval already exists, write the plan artifact only when you deliberately want a reusable handoff instead of keeping the slice inline"
          : "Write the plan to a reusable artifact for handoff instead of retyping it later",
      params: {
        intent: {
          description: "Natural-language workload intent",
          value: input.intent,
          required: true,
        },
        repo: {
          description: "Repo path or repo identifier",
          value: result.inference.target.value.repo,
        },
        paths: {
          description: "Comma-separated path scope",
          value: scopedPaths.join(","),
        },
        "paths-from": {
          description: "Path scope helper",
          value:
            result.inference.target.scope.detail ??
            (result.inference.target.localRepo ? "recent:3" : ""),
        },
        path: {
          description: "Where to write the plan JSON",
          value: defaultPlanArtifactPath(result.plan.workloadId),
          required: true,
        },
      },
    });
  } else {
    actions.push({
      command:
        "workload dispatch <plan-artifact> [--stage <stage-id>] [--write-dispatch <path>]",
      description:
        result.guidance.recommendedExecution === "execute-inline-now"
          ? "If approval already exists, dispatch only when you deliberately want another agent to own the next stage"
          : "Turn the saved plan artifact into a reusable dispatch contract",
      params: {
        "plan-artifact": {
          description: "Path to the workload plan envelope",
          value: result.artifact.path,
          required: true,
        },
        "stage-id": {
          description: "Which stage to dispatch",
          value: result.plan.stages[0]?.id ?? "stage-1",
        },
        path: {
          description: "Where to write the dispatch JSON",
          value: defaultDispatchArtifactPath(
            result.plan.workloadId.replace(/^WL_/u, "WD_"),
          ),
        },
      },
    });
    actions.push({
      command:
        "workload run <plan-artifact> [--stage <stage-id>] [--tool <tool>] [--execution-mode <mode>] [--dry-run]",
      description:
        result.guidance.recommendedExecution === "execute-inline-now"
          ? "If approval already exists, enqueue the saved plan only when you deliberately want managed runtime tracking instead of keeping the slice inline"
          : "Normalize the saved plan into the canonical runtime request and enqueue it",
      params: {
        "plan-artifact": {
          description: "Path to the workload plan envelope",
          value: result.artifact.path,
          required: true,
        },
        "stage-id": {
          description: "Which stage to enqueue",
          value: result.plan.stages[0]?.id ?? "stage-1",
        },
        tool: {
          description: "Background worker tool",
          value: "pi",
          enum: ["pi", "codex", "claude"],
        },
        mode: {
          description: "Execution mode override",
          value: result.plan.mode === "sandbox" ? "sandbox" : "auto",
          enum: ["auto", "host", "sandbox"],
        },
      },
    });
  }

  return actions;
};

const buildDispatchNextActions = (
  planArtifactPath: string,
  result: WorkloadDispatchResult,
  project: string,
): NextAction[] => {
  const actions: NextAction[] = [];

  for (const skill of result.guidance.recommendedSkills) {
    if (skill.missingConsumers.length > 0) {
      actions.push({
        command:
          "skills ensure <skill> [--source-root <repo>] [--consumer <consumer>]",
        description: `Install or repair the ${skill.name} skill before executing the dispatched stage`,
        params: {
          skill: {
            description: "Skill name",
            value: skill.name,
            required: true,
          },
          ...(skill.sourceRoot
            ? {
                repo: {
                  description: "Repo root containing skills/<name>/SKILL.md",
                  value: skill.sourceRoot,
                },
              }
            : {}),
          consumer: {
            description: "Which agent consumer dirs to maintain",
            value: "all",
            enum: ["all", "agents", "pi", "claude"],
          },
        },
      });
    }

    if (skill.readPath) {
      actions.push({
        command: "read <path>",
        description: `Load ${skill.name} before acting on the dispatched stage`,
        params: {
          path: {
            description: "Skill file path",
            value: skill.readPath,
            required: true,
          },
        },
      });
    }
  }

  actions.push({
    command:
      "workload dispatch <plan-artifact> [--stage <stage-id>] [--to <to>] [--from <from>] [--send-mail] [--write-dispatch <path>]",
    description: "Refine the dispatch contract or target a different stage",
    params: {
      "plan-artifact": {
        description: "Path to the saved workload plan envelope",
        value: planArtifactPath,
        required: true,
      },
      "stage-id": {
        description: "Which stage to dispatch",
        value: result.selectedStage.id,
      },
      to: {
        description: "Recipient agent for optional mail dispatch",
        value: result.mail.to ?? "AGENT_NAME",
      },
      from: {
        description: "Sender agent name",
        value: result.mail.from ?? "MaroonReef",
      },
      path: {
        description: "Where to write the dispatch JSON",
        value:
          result.artifact?.path ?? defaultDispatchArtifactPath(result.dispatchId),
      },
    },
  });

  actions.push({
    command:
      "workload run <plan-artifact> [--stage <stage-id>] [--tool <tool>] [--execution-mode <mode>] [--dry-run]",
    description:
      result.guidance.recommendation === "dispatch-is-overkill-keep-it-inline"
        ? "If you still need the managed runtime despite the overkill warning, enqueue the selected stage through the canonical workload bridge"
        : "Enqueue the selected stage through the canonical workload/runtime bridge",
    params: {
      "plan-artifact": {
        description: "Path to the saved workload plan envelope",
        value: planArtifactPath,
        required: true,
      },
      "stage-id": {
        description: "Which stage to enqueue",
        value: result.selectedStage.id,
      },
      tool: {
        description: "Background worker tool",
        value: "pi",
        enum: ["pi", "codex", "claude"],
      },
      mode: {
        description: "Execution mode override",
        value:
          result.selectedStage.mode === "sandbox" ? "sandbox" : "auto",
        enum: ["auto", "host", "sandbox"],
      },
    },
  });

  if (
    result.guidance.recommendation === "dispatch-is-overkill-keep-it-inline"
  ) {
    actions.push({
      command: "mail reserve --paths <paths> --agent <agent>",
      description:
        "If approval already exists, reserve the scoped files and execute the selected stage now instead of bouncing the slice between agents",
      params: {
        paths: {
          description: "Comma-separated file paths",
          value: result.handoff.reservedPaths.join(","),
          required: true,
        },
        agent: {
          description: "Agent taking the dispatched stage",
          value: result.mail.to ?? "AGENT_NAME",
          required: true,
        },
      },
    });
  } else {
    actions.push({
      command: "mail reserve --paths <paths> --agent <agent>",
      description: "If approval already exists, reserve the dispatched file scope before the worker starts",
      params: {
        paths: {
          description: "Comma-separated file paths",
          value: result.handoff.reservedPaths.join(","),
          required: true,
        },
        agent: {
          description: "Agent taking the dispatched stage",
          value: result.mail.to ?? "AGENT_NAME",
          required: true,
        },
      },
    });
  }

  if (result.guidance.recommendation === "dispatch-after-health-check") {
    actions.push({
      command: "status",
      description:
        "Check runtime health before sending or executing this dispatched stage",
    });
  }

  if (!result.delivery) {
    actions.push({
      command:
        "mail send --project <project> --from <from> --to <to> --subject <subject> <body>",
      description:
        result.guidance.recommendation === "clarify-recipient-before-sending"
          ? "Send the dispatch contract only after naming the receiving agent explicitly"
          : "Send the dispatch contract through clawmail",
      params: {
        project: {
          description: "Mail project key",
          value: project,
          required: true,
        },
        to: {
          description: "Recipient agent",
          value: result.mail.to ?? "AGENT_NAME",
          required: true,
        },
        from: {
          description: "Sender agent",
          value: result.mail.from ?? "MaroonReef",
          required: true,
        },
        subject: {
          description: "Mail subject",
          value: result.mail.subject,
          required: true,
        },
        body: {
          description: "Mail body",
          value: result.mail.body,
          required: true,
        },
      },
    });
  } else {
    actions.push({
      command: "mail inbox --project <project> --agent <agent>",
      description: "Check the recipient inbox after dispatch",
      params: {
        project: {
          description: "Mail project key",
          value: project,
          required: true,
        },
        agent: {
          description: "Recipient agent",
          value: result.delivery.to,
          required: true,
        },
      },
    });
  }

  return actions;
};

const planCmd = Command.make(
  "plan",
  {
    intent: planIntentArg,
    preset: presetOption,
    kind: kindOption,
    shape: shapeOption,
    autonomy: autonomyOption,
    proof: proofOption,
    risk: riskOption,
    artifacts: artifactsOption,
    acceptance: acceptanceOption,
    repo: repoOption,
    paths: pathsOption,
    pathsFrom: pathsFromOption,
    writePlan: writePlanOption,
    requestedBy: requestedByOption,
  },
  ({
    intent,
    preset,
    kind,
    shape,
    autonomy,
    proof,
    risk,
    artifacts,
    acceptance,
    repo,
    paths,
    pathsFrom,
    writePlan,
    requestedBy,
  }) =>
    Effect.gen(function* () {
      const repoText = repo._tag === "Some" ? repo.value : undefined;
      const riskText = risk._tag === "Some" ? risk.value : undefined;
      const artifactsText =
        artifacts._tag === "Some" ? artifacts.value : undefined;
      const acceptanceText =
        acceptance._tag === "Some" ? acceptance.value : undefined;
      const pathsText = paths._tag === "Some" ? paths.value : undefined;
      const pathsFromText =
        pathsFrom._tag === "Some" ? pathsFrom.value : undefined;
      const writePlanText =
        writePlan._tag === "Some" ? writePlan.value : undefined;
      const presetValue = preset._tag === "Some" ? preset.value : undefined;

      const planResultEither = yield* Effect.try({
        try: () =>
          planWorkload(
            {
              intent,
              preset: presetValue,
              kind,
              shape,
              autonomy,
              proof,
              riskText,
              artifactsText,
              acceptanceText,
              repoText,
              pathsText,
              pathsFromText,
              requestedBy,
            },
            new Date(),
          ),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (planResultEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload plan",
            planResultEither.left.message,
            "WORKLOAD_PLAN_INVALID_INPUT",
            "Provide a valid repo target or path-scope helper, then retry",
            [
              {
                command:
                  "workload plan <intent> [--repo <repo>] [--paths <paths>] [--paths-from <paths-from>]",
                description: "Retry with a valid repo target and scope helper",
                params: {
                  intent: {
                    description: "Natural-language workload intent",
                    value: intent,
                    required: true,
                  },
                  repo: {
                    description: "Repo path or owner/repo identifier",
                    value: repoText ?? process.cwd(),
                  },
                  paths: {
                    description: "Comma-separated path scope",
                    value: pathsText ?? "docs/,skills/",
                  },
                  "paths-from": {
                    description: "Path scope helper",
                    value: pathsFromText ?? "recent:3",
                  },
                },
              },
            ],
          ),
        );
        return;
      }

      const baseResult = planResultEither.right;
      const normalizedInput = resolvePresetDefaults({
        intent,
        preset: presetValue,
        kind,
        shape,
        autonomy,
        proof,
        riskText,
        artifactsText,
        acceptanceText,
        repoText,
        pathsText,
        pathsFromText,
        requestedBy,
      }).normalized;

      const artifactPath = writePlanText
        ? resolvePlanArtifactPath(writePlanText, baseResult.plan.workloadId)
        : undefined;

      const result: WorkloadPlanningResult = artifactPath
        ? {
            ...baseResult,
            artifact: {
              written: true,
              path: artifactPath,
              format: "joelclaw-envelope",
            },
            plan: {
              ...baseResult.plan,
              next_actions: buildPlanLevelActions(
                normalizedInput,
                baseResult.plan.workloadId,
                {
                  value: baseResult.inference.target.value,
                  inferred: baseResult.inference.target.inferred,
                  localRepo: baseResult.inference.target.localRepo,
                  warnings: [],
                  scope: baseResult.inference.target.scope,
                },
                baseResult.inference.kind,
                baseResult.inference.shape,
                baseResult.inference.mode,
                true,
              ),
            },
          }
        : baseResult;

      const nextActions = buildPlanNextActions(normalizedInput, result);

      if (artifactPath) {
        const artifactEnvelope = buildSuccessEnvelope(
          "workload plan",
          result,
          nextActions,
        );
        writePlanArtifact(artifactPath, artifactEnvelope);
      }

      yield* Console.log(respond("workload plan", result, nextActions));
    }),
).pipe(
  Command.withDescription(
    "Plan a coding/repo workload using the ADR-0217 Phase 4 schema",
  ),
);

const dispatchCmd = Command.make(
  "dispatch",
  {
    planArtifact: dispatchPlanArtifactArg,
    stage: dispatchStageOption,
    project: dispatchProjectOption,
    from: dispatchFromOption,
    to: dispatchToOption,
    sendMail: sendMailOption,
    writeDispatch: writeDispatchOption,
  },
  ({ planArtifact, stage, project, from, to, sendMail, writeDispatch }) =>
    Effect.gen(function* () {
      const stageId = stage._tag === "Some" ? stage.value.trim() : undefined;
      const toAgent = to._tag === "Some" ? to.value.trim() : undefined;
      const writeDispatchText =
        writeDispatch._tag === "Some" ? writeDispatch.value : undefined;

      const parsedEither = yield* Effect.try({
        try: () => parseWorkloadPlanArtifact(planArtifact),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (parsedEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload dispatch",
            parsedEither.left.message,
            "WORKLOAD_DISPATCH_INVALID_PLAN_ARTIFACT",
            "Pass a valid plan artifact created by `joelclaw workload plan --write-plan ...`",
            [
              {
                command:
                  "workload dispatch <plan-artifact> [--stage <stage-id>] [--write-dispatch <path>]",
                description: "Retry with a valid plan artifact",
                params: {
                  "plan-artifact": {
                    description: "Path to a workload plan envelope",
                    value: planArtifact,
                    required: true,
                  },
                  "stage-id": {
                    description: "Optional stage id",
                    value: stageId ?? "stage-1",
                  },
                  path: {
                    description: "Where to write the dispatch JSON",
                    value: defaultDispatchArtifactPath("WD_YYYYMMDD_HHMMSS"),
                  },
                },
              },
            ],
          ),
        );
        return;
      }

      if (sendMail && !toAgent) {
        yield* Console.log(
          respondError(
            "workload dispatch",
            "--send-mail requires --to <agent>",
            "WORKLOAD_DISPATCH_MISSING_RECIPIENT",
            "Provide a recipient agent with --to before sending the dispatch contract",
            [
              {
                command:
                  "workload dispatch <plan-artifact> --to <to> --from <from> --send-mail",
                description: "Retry with an explicit mail recipient",
                params: {
                  "plan-artifact": {
                    description: "Path to a workload plan envelope",
                    value: planArtifact,
                    required: true,
                  },
                  to: {
                    description: "Recipient agent",
                    value: "AGENT_NAME",
                    required: true,
                  },
                  from: {
                    description: "Sender agent",
                    value: from,
                    required: true,
                  },
                },
              },
            ],
          ),
        );
        return;
      }

      const parsed = parsedEither.right;
      const dispatchBaseEither = yield* Effect.try({
        try: () =>
          buildDispatchContract({
            sourcePlanPath: parsed.absolutePath,
            result: parsed.result,
            stageId,
            from,
            to: toAgent,
            now: new Date(),
          }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (dispatchBaseEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload dispatch",
            dispatchBaseEither.left.message,
            "WORKLOAD_DISPATCH_INVALID_STAGE",
            "Choose a valid stage id from the saved plan and retry",
            [
              {
                command:
                  "workload dispatch <plan-artifact> [--stage <stage-id>]",
                description: "Retry with a valid stage id",
                params: {
                  "plan-artifact": {
                    description: "Path to a workload plan envelope",
                    value: parsed.absolutePath,
                    required: true,
                  },
                  "stage-id": {
                    description: "Stage id to dispatch",
                    value: parsed.result.plan.stages[0]?.id ?? "stage-1",
                  },
                },
              },
            ],
          ),
        );
        return;
      }

      const dispatchArtifactPath = writeDispatchText
        ? resolvePlanArtifactPath(
            writeDispatchText,
            dispatchBaseEither.right.dispatchId,
          )
        : undefined;

      let result: WorkloadDispatchResult = dispatchArtifactPath
        ? {
            ...dispatchBaseEither.right,
            artifact: {
              written: true,
              path: dispatchArtifactPath,
              format: "joelclaw-envelope",
            },
          }
        : dispatchBaseEither.right;

      if (sendMail && toAgent) {
        const deliveryEither = yield* executeCapabilityCommand<
          Record<string, unknown>
        >({
          capability: "mail",
          subcommand: "send",
          args: {
            project,
            from,
            to: toAgent,
            subject: result.mail.subject,
            body: result.mail.body,
          },
        }).pipe(Effect.either);

        if (deliveryEither._tag === "Left") {
          yield* Console.log(
            respondError(
              "workload dispatch",
              deliveryEither.left.message,
              deliveryEither.left.code || "WORKLOAD_DISPATCH_MAIL_FAILED",
              deliveryEither.left.fix ??
                "Retry the dispatch without --send-mail or fix joelclaw mail first",
              [
                {
                  command:
                    "mail send --project <project> --from <from> --to <to> --subject <subject> <body>",
                  description: "Retry the mail dispatch directly",
                  params: {
                    project: {
                      description: "Mail project key",
                      value: project,
                      required: true,
                    },
                    from: {
                      description: "Sender agent",
                      value: from,
                      required: true,
                    },
                    to: {
                      description: "Recipient agent",
                      value: toAgent,
                      required: true,
                    },
                    subject: {
                      description: "Mail subject",
                      value: result.mail.subject,
                      required: true,
                    },
                    body: {
                      description: "Mail body",
                      value: result.mail.body,
                      required: true,
                    },
                  },
                },
              ],
            ),
          );
          return;
        }

        result = {
          ...result,
          delivery: {
            sent: true,
            project,
            from,
            to: toAgent,
            result: deliveryEither.right,
          },
        };
      }

      const nextActions = buildDispatchNextActions(
        parsed.absolutePath,
        result,
        project,
      );

      if (dispatchArtifactPath) {
        writeDispatchArtifact(
          dispatchArtifactPath,
          buildSuccessEnvelope("workload dispatch", result, nextActions),
        );
      }

      yield* Console.log(respond("workload dispatch", result, nextActions));
    }),
).pipe(
  Command.withDescription(
    "Turn a saved workload plan artifact into a dispatch/handoff contract",
  ),
);

const runCmd = Command.make(
  "run",
  {
    planArtifact: runPlanArtifactArg,
    stage: runStageOption,
    tool: runToolOption,
    timeout: runTimeoutOption,
    model: runModelOption,
    executionMode: runExecutionModeOption,
    sandboxBackend: runSandboxBackendOption,
    sandboxMode: runSandboxModeOption,
    repoUrl: runRepoUrlOption,
    dryRun: runDryRunOption,
  },
  ({
    planArtifact,
    stage,
    tool,
    timeout,
    model,
    executionMode,
    sandboxBackend,
    sandboxMode,
    repoUrl,
    dryRun,
  }) =>
    Effect.gen(function* () {
      const stageId = stage._tag === "Some" ? stage.value.trim() : undefined;
      const modelText = model._tag === "Some" ? model.value.trim() : undefined;
      const repoUrlText =
        repoUrl._tag === "Some" ? repoUrl.value.trim() : undefined;
      const timeoutSeconds = timeout._tag === "Some" ? timeout.value : undefined;
      const normalizedTool = tool.trim().toLowerCase();
      const normalizedExecutionMode = executionMode.trim().toLowerCase();
      const normalizedSandboxBackend = sandboxBackend.trim().toLowerCase();
      const normalizedSandboxMode = sandboxMode.trim().toLowerCase();

      if (!["pi", "codex", "claude"].includes(normalizedTool)) {
        yield* Console.log(
          respondError(
            "workload run",
            `Invalid --tool ${tool}`,
            "WORKLOAD_RUN_INVALID_TOOL",
            "Choose pi, codex, or claude for the runtime worker",
            [],
          ),
        );
        return;
      }

      if (!["auto", "host", "sandbox"].includes(normalizedExecutionMode)) {
        yield* Console.log(
          respondError(
            "workload run",
            `Invalid --execution-mode ${executionMode}`,
            "WORKLOAD_RUN_INVALID_EXECUTION_MODE",
            "Choose auto, host, or sandbox for workload run",
            [],
          ),
        );
        return;
      }

      if (!["local", "k8s"].includes(normalizedSandboxBackend)) {
        yield* Console.log(
          respondError(
            "workload run",
            `Invalid --sandbox-backend ${sandboxBackend}`,
            "WORKLOAD_RUN_INVALID_SANDBOX_BACKEND",
            "Choose local or k8s for the sandbox backend",
            [],
          ),
        );
        return;
      }

      if (!["minimal", "full"].includes(normalizedSandboxMode)) {
        yield* Console.log(
          respondError(
            "workload run",
            `Invalid --sandbox-mode ${sandboxMode}`,
            "WORKLOAD_RUN_INVALID_SANDBOX_MODE",
            "Choose minimal or full for the local sandbox mode",
            [],
          ),
        );
        return;
      }

      if (!dryRun && isNestedWorkflowRigSandboxExecution()) {
        yield* Console.log(
          respondError(
            "workload run",
            "Nested workflow-rig execution is blocked inside sandboxed stage runs",
            "WORKLOAD_RUN_NESTED_SANDBOX_RECURSION_BLOCKED",
            "Run direct proof commands inside the sandbox, or set JOELCLAW_ALLOW_NESTED_WORKFLOW_RIG=true only for deliberate recursion debugging",
            [],
          ),
        );
        return;
      }

      const parsedEither = yield* Effect.try({
        try: () => parseWorkloadPlanArtifact(planArtifact),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (parsedEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload run",
            parsedEither.left.message,
            "WORKLOAD_RUN_INVALID_PLAN_ARTIFACT",
            "Pass a valid plan artifact created by `joelclaw workload plan --write-plan ...`",
            [
              {
                command:
                  "workload run <plan-artifact> [--stage <stage-id>] [--tool <tool>] [--execution-mode <mode>] [--dry-run]",
                description: "Retry with a valid plan artifact",
                params: {
                  "plan-artifact": {
                    description: "Path to a workload plan envelope",
                    value: planArtifact,
                    required: true,
                  },
                  "stage-id": {
                    description: "Optional stage id",
                    value: stageId ?? "stage-1",
                  },
                  tool: {
                    description: "Background worker tool",
                    value: normalizedTool,
                    enum: ["pi", "codex", "claude"],
                  },
                  mode: {
                    description: "Execution mode",
                    value: normalizedExecutionMode,
                    enum: ["auto", "host", "sandbox"],
                  },
                },
              },
            ],
          ),
        );
        return;
      }

      const parsed = parsedEither.right;
      const runBaseEither = yield* Effect.try({
        try: () =>
          buildWorkloadRunResult({
            sourcePlanPath: parsed.absolutePath,
            result: parsed.result,
            stageId,
            tool: normalizedTool as "pi" | "codex" | "claude",
            timeout: timeoutSeconds,
            model: modelText,
            executionMode: normalizedExecutionMode as "auto" | "host" | "sandbox",
            sandboxBackend: normalizedSandboxBackend as "local" | "k8s",
            sandboxMode: normalizedSandboxMode as "minimal" | "full",
            repoUrl: repoUrlText,
            now: new Date(),
          }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (runBaseEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload run",
            runBaseEither.left.message,
            "WORKLOAD_RUN_INVALID_RUNTIME_REQUEST",
            "Use a local repo target or pass --repo-url so the runtime request has a real checkout source",
            [],
          ),
        );
        return;
      }

      let result: WorkloadRunResult = {
        ...runBaseEither.right,
        dryRun,
      };

      if (!dryRun) {
        const queueEither = yield* Effect.tryPromise({
          try: () =>
            enqueueQueueEventViaWorker({
              name: result.event.family,
              data: result.runtimeRequest as unknown as Record<string, unknown>,
              source: "workload",
            }),
          catch: (error) =>
            error instanceof Error
              ? error
              : new Error(String(error)),
        }).pipe(Effect.either);

        if (queueEither._tag === "Left") {
          yield* Console.log(
            respondError(
              "workload run",
              queueEither.left.message,
              "WORKLOAD_RUN_QUEUE_ADMISSION_FAILED",
              "Check the queue registry/worker admission surface, or retry with --dry-run to inspect the normalized runtime request",
              [],
            ),
          );
          return;
        }

        result = {
          ...result,
          queue: {
            streamId: queueEither.right.streamId,
            eventId: queueEither.right.eventId,
            priority: queueEither.right.priority,
            triageMode: queueEither.right.triageMode,
            triage: queueEither.right.triage,
          },
        };
      }

      const nextActions = buildRunNextActions(parsed.absolutePath, result);
      yield* Console.log(respond("workload run", result, nextActions));
    }),
).pipe(
  Command.withDescription(
    "Normalize a saved workload plan into a canonical runtime request and enqueue it",
  ),
);

const sandboxesListCmd = Command.make(
  "list",
  {
    state: sandboxesStateOption,
    mode: sandboxesModeOption,
    limit: sandboxesLimitOption,
    expired: sandboxesExpiredOption,
  },
  ({ state, mode, limit, expired }) =>
    Effect.gen(function* () {
      const normalizedState = normalizeOptionalFlagText(state);
      const normalizedMode = normalizeOptionalFlagText(mode);

      if (normalizedState && !isLocalSandboxState(normalizedState)) {
        yield* Console.log(
          respondError(
            "workload sandboxes list",
            `Invalid --state ${state.value}`,
            "WORKLOAD_SANDBOXES_INVALID_STATE",
            "Choose pending, running, completed, failed, or cancelled",
            [],
          ),
        );
        return;
      }

      if (normalizedMode && !["minimal", "full"].includes(normalizedMode)) {
        yield* Console.log(
          respondError(
            "workload sandboxes list",
            `Invalid --mode ${mode.value}`,
            "WORKLOAD_SANDBOXES_INVALID_MODE",
            "Choose minimal or full",
            [],
          ),
        );
        return;
      }

      const now = new Date();
      const reconciled = yield* Effect.tryPromise({
        try: () => reconcileLocalSandboxRegistry(),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      });
      const registry = reconciled.registry;

      const filtered = registry.entries
        .filter((entry) => !normalizedState || entry.state === normalizedState)
        .filter((entry) => !normalizedMode || entry.mode === normalizedMode)
        .filter((entry) => !expired || isLocalSandboxEntryExpired(entry, now))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      const result = {
        checkedAt: now.toISOString(),
        registryPath: defaultLocalSandboxRegistryPath(),
        totalEntries: registry.entries.length,
        filteredEntries: filtered.length,
        reconciledSandboxIds: reconciled.reconciledSandboxIds,
        reconciledCount: reconciled.reconciledSandboxIds.length,
        summary: summarizeLocalSandboxEntries(registry.entries, now),
        entries: filtered.slice(0, Math.max(1, limit)).map((entry) => toLocalSandboxListEntry(entry, now)),
      };

      yield* Console.log(
        respond("workload sandboxes list", result, [
          {
            command: "joelclaw workload sandboxes janitor [--dry-run]",
            description: "Run the dedicated expired-sandbox janitor path",
            params: {
              "dry-run": { default: true, description: "Preview janitor removals before deleting anything" },
            },
          },
          {
            command: "joelclaw workload sandboxes cleanup [--request-id <ids>] [--sandbox-id <ids>] [--expired] [--all-terminal] [--force] [--dry-run]",
            description: "Remove specific or terminal local sandboxes from the registry and filesystem",
          },
        ]));
    }),
).pipe(Command.withDescription("List local sandbox registry entries with retention and filesystem state"));

const sandboxesCleanupCmd = Command.make(
  "cleanup",
  {
    requestId: sandboxesRequestIdOption,
    sandboxId: sandboxesSandboxIdOption,
    expired: sandboxesExpiredOption,
    allTerminal: sandboxesAllTerminalOption,
    force: sandboxesForceOption,
    dryRun: sandboxesDryRunOption,
  },
  ({ requestId, sandboxId, expired, allTerminal, force, dryRun }) =>
    Effect.gen(function* () {
      const requestIds = splitCsvValues(
        requestId._tag === "Some" ? requestId.value.trim() : undefined,
      );
      const sandboxIds = splitCsvValues(
        sandboxId._tag === "Some" ? sandboxId.value.trim() : undefined,
      );

      if (requestIds.length === 0 && sandboxIds.length === 0 && !expired && !allTerminal) {
        yield* Console.log(
          respondError(
            "workload sandboxes cleanup",
            "Cleanup requires --request-id, --sandbox-id, --expired, or --all-terminal",
            "WORKLOAD_SANDBOXES_CLEANUP_SELECTOR_REQUIRED",
            "Choose a bounded selector before deleting sandbox state",
            [],
          ),
        );
        return;
      }

      const result = yield* Effect.tryPromise({
        try: () => cleanupLocalSandboxes({
          requestIds,
          sandboxIds,
          expiredOnly: expired,
          allTerminal,
          force,
          dryRun,
        }),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      });

      yield* Console.log(
        respond("workload sandboxes cleanup", {
          checkedAt: new Date().toISOString(),
          registryPath: defaultLocalSandboxRegistryPath(),
          dryRun: result.dryRun,
          selectors: {
            requestIds,
            sandboxIds,
            expired,
            allTerminal,
            force,
          },
          matchedSandboxIds: result.matchedSandboxIds,
          removedSandboxIds: result.removedSandboxIds,
          skipped: result.skipped,
          reconciledSandboxIds: result.reconciledSandboxIds,
          reconciledCount: result.reconciledSandboxIds.length,
          remainingEntries: result.registry.entries.length,
        }, [
          {
            command: "joelclaw workload sandboxes list [--limit <limit>]",
            description: "Inspect registry state after cleanup",
            params: {
              limit: { default: 25, description: "Maximum number of sandboxes to return" },
            },
          },
        ]),
      );
    }),
).pipe(Command.withDescription("Clean up local sandbox registry entries and their filesystem state"));

const sandboxesJanitorCmd = Command.make(
  "janitor",
  {
    dryRun: sandboxesDryRunOption,
  },
  ({ dryRun }) =>
    Effect.gen(function* () {
      const now = new Date();
      const reconciled = yield* Effect.tryPromise({
        try: () => reconcileLocalSandboxRegistry(),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      });
      const registry = reconciled.registry;
      const candidates = registry.entries.filter((entry) => isLocalSandboxEntryExpired(entry, now));

      if (dryRun) {
        yield* Console.log(
          respond("workload sandboxes janitor", {
            checkedAt: now.toISOString(),
            registryPath: defaultLocalSandboxRegistryPath(),
            dryRun: true,
            reconciledSandboxIds: reconciled.reconciledSandboxIds,
            reconciledCount: reconciled.reconciledSandboxIds.length,
            candidateCount: candidates.length,
            truncated: candidates.length > 25,
            candidates: candidates.slice(0, 25).map((entry) => ({
              sandboxId: entry.sandboxId,
              requestId: entry.requestId,
              state: entry.state,
              cleanupAfter: entry.cleanupAfter,
              path: entry.path,
            })),
          }, [
            {
              command: "joelclaw workload sandboxes janitor",
              description: "Remove expired sandbox directories and trim the registry",
            },
          ]),
        );
        return;
      }

      const pruned = yield* Effect.tryPromise({
        try: () => pruneExpiredLocalSandboxes({ now }),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      });

      yield* Console.log(
        respond("workload sandboxes janitor", {
          checkedAt: now.toISOString(),
          registryPath: defaultLocalSandboxRegistryPath(),
          dryRun: false,
          reconciledSandboxIds: pruned.reconciledSandboxIds,
          reconciledCount: pruned.reconciledSandboxIds.length,
          removedSandboxIds: pruned.removedSandboxIds,
          removedCount: pruned.removedSandboxIds.length,
          retainedCount: pruned.retainedSandboxIds.length,
          retainedSample: pruned.retainedSandboxIds.slice(0, 10),
          truncated: pruned.retainedSandboxIds.length > 10,
        }, [
          {
            command: "joelclaw workload sandboxes list [--limit <limit>]",
            description: "Inspect sandbox registry state after janitor cleanup",
            params: {
              limit: { default: 25, description: "Maximum number of sandboxes to return" },
            },
          },
        ]),
      );
    }),
).pipe(Command.withDescription("Run the dedicated expired-sandbox janitor path"));

const sandboxesCmd = Command.make("sandboxes", {}, () =>
  Console.log(
    respond(
      "workload sandboxes",
      {
        description: "Operator surfaces for local sandbox registry inspection and cleanup",
        subcommands: {
          list: "joelclaw workload sandboxes list [--state <state>] [--mode <mode>] [--limit <limit>] [--expired]",
          cleanup:
            "joelclaw workload sandboxes cleanup [--request-id <ids>] [--sandbox-id <ids>] [--expired] [--all-terminal] [--force] [--dry-run]",
          janitor: "joelclaw workload sandboxes janitor [--dry-run]",
        },
      },
      [
        {
          command: "joelclaw workload sandboxes list [--limit <limit>]",
          description: "Inspect local sandbox registry state and filesystem truth",
          params: {
            limit: { default: 25, description: "Maximum number of sandboxes to return" },
          },
        },
        {
          command: "joelclaw workload sandboxes janitor [--dry-run]",
          description: "Preview or execute the dedicated expired-sandbox janitor path",
          params: {
            "dry-run": { default: true, description: "Preview janitor removals before deleting anything" },
          },
        },
      ],
    ),
  ),
).pipe(
  Command.withDescription("Inspect and clean up local sandbox state under ADR-0221"),
  Command.withSubcommands([sandboxesListCmd, sandboxesCleanupCmd, sandboxesJanitorCmd]),
);

export const workloadCmd = Command.make("workload", {}, () =>
  Console.log(
    respond(
      "workload",
      {
        description: "Agent-first workload planning, dispatch, and runtime bridge surfaces",
        shipped: {
          plan: "joelclaw workload plan <intent> [--preset docs-truth|research-compare|refactor-handoff] [--kind auto|repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration] [--shape auto|serial|parallel|chained] [--paths-from status|head|recent:<n>] [--write-plan <path>]",
          dispatch:
            "joelclaw workload dispatch <plan-artifact> [--stage <stage-id>] [--to <to>] [--from <from>] [--send-mail] [--write-dispatch <path>]",
          run:
            "joelclaw workload run <plan-artifact> [--stage <stage-id>] [--tool pi|codex|claude] [--execution-mode auto|host|sandbox] [--sandbox-backend local|k8s] [--dry-run]",
          sandboxes:
            "joelclaw workload sandboxes list|cleanup|janitor",
        },
        planned: {
          status: "planned, not yet shipped",
          explain: "planned, not yet shipped",
          cancel: "planned, not yet shipped",
        },
      },
      [
        {
          command: `joelclaw workload plan ${shellQuote("shape active gremlin refactor work")} --preset refactor-handoff --repo ${shellQuote("/Users/joel/Code/badass-courses/gremlin")} --paths-from recent:3 --write-plan ${shellQuote("~/.joelclaw/workloads/")}`,
          description:
            "Plan active repo work with a preset, git-derived path scope, and a saved plan artifact",
        },
        {
          command: `joelclaw workload dispatch ${shellQuote("~/.joelclaw/workloads/WL_YYYYMMDD_HHMMSS.json")} --write-dispatch ${shellQuote("~/.joelclaw/workloads/")}`,
          description:
            "Turn a saved plan artifact into a reusable dispatch contract",
        },
        {
          command: `joelclaw workload run ${shellQuote("~/.joelclaw/workloads/WL_YYYYMMDD_HHMMSS.json")} --tool pi --dry-run`,
          description:
            "Normalize a saved plan into the canonical runtime request before enqueueing it",
        },
        {
          command: "joelclaw workload sandboxes list --limit 10",
          description:
            "Inspect live local sandbox registry state and cleanup posture",
        },
      ],
    ),
  ),
).pipe(Command.withSubcommands([planCmd, dispatchCmd, runCmd, sandboxesCmd]));

export const __workloadTestUtils = {
  splitCsv,
  splitDelimited,
  splitLines,
  parsePathsFrom,
  inferKind,
  chooseShape,
  inferRisks,
  chooseMode,
  chooseBackend,
  inferArtifacts,
  buildVerification,
  buildStages,
  buildWorkloadId,
  buildDispatchId,
  buildRunId,
  defaultPlanArtifactPath,
  defaultDispatchArtifactPath,
  resolvePlanArtifactPath,
  writePlanArtifact,
  writeDispatchArtifact,
  readJsonArtifact,
  parseWorkloadPlanArtifact,
  selectDispatchStage,
  buildDispatchContract,
  buildWorkloadRunResult,
  buildRunNextActions,
  resolvePresetDefaults,
  resolveTarget,
  buildExecutionExamples,
  buildPlanNextActions,
  planWorkload,
  isNestedWorkflowRigSandboxExecution,
};
