import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { type NextAction, respond, respondError } from "../response";

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
    target: { value: WorkloadTarget; inferred: boolean; localRepo: boolean };
  };
  warnings: string[];
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

type TargetResolution = {
  value: WorkloadTarget;
  inferred: boolean;
  localRepo: boolean;
  warnings: string[];
};

type PlannerInput = {
  intent: string;
  kind: WorkloadKindChoice;
  shape: WorkloadShapeChoice;
  autonomy: AutonomyLevel;
  proof: ProofPosture;
  riskText?: string;
  artifactsText?: string;
  acceptanceText?: string;
  repoText?: string;
  pathsText?: string;
  requestedBy: string;
};

const lower = (value: string) => value.toLowerCase();

const dedupe = <T extends string>(values: readonly T[]): T[] => [
  ...new Set(values),
];

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

const expandHome = (value: string) =>
  value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value;

const runGit = (repoPath: string, args: string[]): string | undefined => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  return output.length > 0 ? output : undefined;
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
    !hasAny(value, ["implement", "fix", "refactor", "write", "add", "ship"])
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

  if (
    hasAny(value, ["deploy", "publish", "release"]) &&
    !values.includes("deploy-allowed")
  ) {
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

  if (kind === "runtime.proof" || proof === "canary" || proof === "soak") {
    return {
      value: "durable",
      inferred: true,
      reason:
        "runtime proof work wants a tracked durable path instead of an ad-hoc inline session",
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

  if (kind === "cross-repo.integration") {
    return {
      value: "durable",
      inferred: true,
      reason:
        "cross-repo integration work usually benefits from an explicit bridgeable durable path",
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
  )
    values.push("docs");
  if (hasAny(value, ["test", "tests"]) && !values.includes("tests"))
    values.push("tests");
  if (shape === "chained" && !values.includes("handoff"))
    values.push("handoff");
  if (
    shape === "parallel" &&
    kind === "research.spike" &&
    !values.includes("comparison")
  )
    values.push("comparison");
  if (kind === "runtime.proof" && !values.includes("telemetry-proof"))
    values.push("telemetry-proof");
  if (kind === "runtime.proof" && !values.includes("rollback-plan"))
    values.push("rollback-plan");

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

const buildStages = (
  kind: WorkloadKind,
  shape: WorkloadShape,
  mode: ExecutionMode,
  artifacts: readonly ArtifactName[],
): WorkloadStage[] => {
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
    return [
      {
        id: "stage-1",
        name:
          kind === "repo.docs"
            ? "produce canonical docs change"
            : "execute primary work",
        owner: mode === "inline" ? "planner" : "worker",
        mode,
        inputs: ["workload request", "acceptance criteria"],
        outputs: artifacts.filter(
          (artifact) => artifact !== "handoff" && artifact !== "summary",
        ),
        verification: [
          "primary artifact lands before verification stage starts",
        ],
        stopConditions: ["scope expands beyond the planned boundary"],
      },
      {
        id: "stage-2",
        name: "verify independently",
        owner: "reviewer",
        mode: "inline",
        inputs: ["stage-1 outputs"],
        outputs: artifacts.includes("verification")
          ? ["verification"]
          : ["summary"],
        verification: [
          "verification is recorded separately from implementation",
        ],
        stopConditions: [
          "verification cannot explain what changed or what remains",
        ],
        dependsOn: ["stage-1"],
      },
      {
        id: "stage-3",
        name: "handoff and closeout",
        owner: "planner",
        mode: "inline",
        inputs: ["stage-1 outputs", "stage-2 verification"],
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
        dependsOn: ["stage-2"],
      },
    ];
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
      owner: mode === "inline" ? "planner" : "worker",
      mode,
      inputs: ["workload plan"],
      outputs: artifacts.filter((artifact) => artifact !== "summary"),
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
): TargetResolution => {
  const warnings: string[] = [];
  const paths = splitCsv(pathsText);
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

    return {
      value: {
        repo: absolute,
        branch: branch ?? undefined,
        baseSha: baseSha ?? undefined,
        paths: paths.length > 0 ? paths : undefined,
      },
      inferred: !repoText,
      localRepo: true,
      warnings,
    };
  }

  warnings.push(
    `treating ${candidate} as a non-local repo identifier; branch/baseSha were not inferred`,
  );

  return {
    value: {
      repo: candidate,
      paths: paths.length > 0 ? paths : undefined,
    },
    inferred: false,
    localRepo: false,
    warnings,
  };
};

const planWorkload = (
  input: PlannerInput,
  now = new Date(),
): WorkloadPlanningResult => {
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
  const target = resolveTarget(input.repoText, input.pathsText);
  const acceptance = splitDelimited(input.acceptanceText);
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
    workloadId: buildWorkloadId(now),
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
    stages: buildStages(kind.value, shape.value, mode.value, artifacts.values),
    next_actions: [
      {
        command: `joelclaw workload plan \"${input.intent}\" --kind ${kind.value} --shape ${shape.value}`,
        description:
          "Re-run the planner with the inferred kind/shape pinned explicitly",
      },
      ...(mode.value === "durable" ||
      mode.value === "loop" ||
      mode.value === "sandbox"
        ? [
            {
              command: "joelclaw status",
              description:
                "Check runtime health before dispatching beyond planning",
            },
          ]
        : []),
    ],
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

const requestedByOption = Options.text("requested-by").pipe(
  Options.withDescription("Who requested the workload"),
  Options.withDefault("Joel"),
);

const buildPlanNextActions = (
  intent: string,
  result: WorkloadPlanningResult,
): NextAction[] => {
  const actions: NextAction[] = [
    {
      command:
        "workload plan <intent> [--kind <kind>] [--shape <shape>] [--autonomy <autonomy>] [--proof <proof>] [--repo <repo>] [--paths <paths>]",
      description: "Refine the plan with explicit overrides",
      params: {
        intent: {
          description: "Natural-language workload intent",
          value: intent,
          required: true,
        },
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
      },
    },
  ];

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
    kind: kindOption,
    shape: shapeOption,
    autonomy: autonomyOption,
    proof: proofOption,
    risk: riskOption,
    artifacts: artifactsOption,
    acceptance: acceptanceOption,
    repo: repoOption,
    paths: pathsOption,
    requestedBy: requestedByOption,
  },
  ({
    intent,
    kind,
    shape,
    autonomy,
    proof,
    risk,
    artifacts,
    acceptance,
    repo,
    paths,
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

      const planResultEither = yield* Effect.try({
        try: () =>
          planWorkload({
            intent,
            kind,
            shape,
            autonomy,
            proof,
            riskText,
            artifactsText,
            acceptanceText,
            repoText,
            pathsText,
            requestedBy,
          }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.either);

      if (planResultEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "workload plan",
            planResultEither.left.message,
            "WORKLOAD_PLAN_INVALID_TARGET",
            "Provide a valid local repo path or a repo identifier, then retry",
            [
              {
                command:
                  "workload plan <intent> [--repo <repo>] [--paths <paths>]",
                description: "Retry with a valid repo target",
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
                },
              },
            ],
          ),
        );
        return;
      }

      const result = planResultEither.right;

      yield* Console.log(
        respond("workload plan", result, buildPlanNextActions(intent, result)),
      );
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
          plan: "joelclaw workload plan <intent> [--kind auto|repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration] [--shape auto|serial|parallel|chained]",
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
          command:
            'joelclaw workload plan "groom ADR-0217 truth and docs" --kind repo.docs',
          description: "Plan a docs/truth workload explicitly",
        },
        {
          command: 'joelclaw workload plan "compare two sandbox approaches"',
          description:
            "Let the planner infer a research/parallelizable workload",
        },
      ],
    ),
  ),
).pipe(Command.withSubcommands([planCmd]));

export const __workloadTestUtils = {
  splitCsv,
  splitDelimited,
  inferKind,
  chooseShape,
  inferRisks,
  chooseMode,
  chooseBackend,
  inferArtifacts,
  buildVerification,
  buildStages,
  buildWorkloadId,
  planWorkload,
};
