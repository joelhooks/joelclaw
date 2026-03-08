import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
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

type WorkloadPlanningResult = {
  request: WorkloadRequest;
  plan: WorkloadPlan;
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
    run: false;
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

  return {
    request,
    plan,
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
      run: false,
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

const buildPlanNextActions = (
  input: NormalizedPlannerInput,
  result: WorkloadPlanningResult,
): NextAction[] => {
  const actions: NextAction[] = [
    {
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
          value: result.inference.target.value.paths?.join(",") ?? "",
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
    },
  ];

  if (
    result.inference.target.localRepo &&
    (!result.inference.target.value.paths ||
      result.inference.target.value.paths.length === 0)
  ) {
    actions.push({
      command: "workload plan <intent> --repo <repo> --paths-from <paths-from>",
      description:
        "Seed the path scope from recent repo activity before scheduling repo-wide work",
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
    result.inference.target.value.paths &&
    result.inference.target.value.paths.length > 0
  ) {
    actions.push({
      command: "mail reserve --paths <paths> --agent <agent>",
      description:
        "Reserve the scoped files before dispatching the planned work",
      params: {
        paths: {
          description: "Comma-separated file paths",
          value: result.inference.target.value.paths.join(","),
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

  if (!result.artifact) {
    actions.push({
      command:
        "workload plan <intent> [--repo <repo>] [--paths <paths>] [--paths-from <paths-from>] --write-plan <path>",
      description:
        "Write the plan to a reusable artifact for handoff instead of retyping it later",
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
          value: result.inference.target.value.paths?.join(",") ?? "",
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
  }

  if (
    result.plan.mode === "durable" ||
    result.plan.mode === "loop" ||
    result.plan.mode === "sandbox"
  ) {
    actions.push({
      command: "status",
      description:
        "Check system health before dispatching work beyond planning",
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

export const workloadCmd = Command.make("workload", {}, () =>
  Console.log(
    respond(
      "workload",
      {
        description: "Agent-first workload planning surfaces",
        shipped: {
          plan: "joelclaw workload plan <intent> [--preset docs-truth|research-compare|refactor-handoff] [--kind auto|repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration] [--shape auto|serial|parallel|chained] [--paths-from status|head|recent:<n>] [--write-plan <path>]",
        },
        planned: {
          run: "planned, not yet shipped",
          status: "planned, not yet shipped",
          explain: "planned, not yet shipped",
          cancel: "planned, not yet shipped",
        },
      },
      [
        {
          command: `joelclaw workload plan ${shellQuote("shape active gremlin refactor work")} --preset refactor-handoff --repo ${shellQuote("/Users/joel/Code/badass-courses/gremlin")} --paths-from recent:3`,
          description:
            "Plan active repo work with a preset and git-derived path scope",
        },
        {
          command: `joelclaw workload plan ${shellQuote("compare two sandbox approaches")} --preset research-compare --write-plan ${shellQuote("~/.joelclaw/workloads/")}`,
          description:
            "Write a reusable research plan artifact for later handoff",
        },
      ],
    ),
  ),
).pipe(Command.withSubcommands([planCmd]));

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
  defaultPlanArtifactPath,
  resolvePlanArtifactPath,
  writePlanArtifact,
  resolvePresetDefaults,
  resolveTarget,
  planWorkload,
};
