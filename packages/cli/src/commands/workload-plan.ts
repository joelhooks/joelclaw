import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { NextAction } from "../response";
import { defaultDispatchArtifactPath, defaultPlanArtifactPath } from "./workload-dispatch";
import {
  ARTIFACT_NAMES,
  RISK_POSTURES,
  WORKLOAD_PRESETS,
  WORKLOAD_PRESET_DEFINITIONS,
  WORKLOAD_VERSION,
  type AppliedPreset,
  type ArtifactName,
  type AutonomyLevel,
  type BackendClass,
  type ExecutionMode,
  type NormalizedPlannerInput,
  type PlannerInput,
  type PlannerInputResolution,
  type Resolution,
  type RiskPosture,
  type ShapeResolution,
  type TargetResolution,
  type WorkloadExecutionExample,
  type WorkloadExecutionLoop,
  type WorkloadGuidance,
  type WorkloadKind,
  type WorkloadKindChoice,
  type WorkloadPlan,
  type WorkloadPlanningResult,
  type WorkloadPreset,
  type WorkloadRequest,
  type WorkloadRecommendedExecution,
  type WorkloadShape,
  type WorkloadShapeChoice,
  type WorkloadSkillRecommendation,
  type WorkloadStage,
} from "./workload-types";
import {
  collectPathsFromDirective,
  dedupe,
  expandHome,
  extractAcceptanceFromIntent,
  extractGoalMilestones,
  hasAny,
  hasExplicitDeployIntent,
  hasExplicitIsolationIntent,
  lower,
  parseEnumList,
  parsePathsFrom,
  runGit,
  shellQuote,
  shouldInsertReflectionStage,
  splitCsv,
  splitDelimited,
  toStageName,
} from "./workload-utils";

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

export const inferWorkloadSkillRecommendations = (
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

export const inferAdrCoverage = (
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

export const buildExecutionExamples = (
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

export const buildPlanExecutionLoop = (options: {
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

export const buildWorkloadGuidance = (
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

export const resolvePresetDefaults = (input: PlannerInput): PlannerInputResolution => {
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

export const inferKind = (
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

export const chooseShape = (
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

export const inferRisks = (
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

export const chooseMode = (
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

export const chooseBackend = (
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

export const inferArtifacts = (
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

export const buildVerification = (
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

export const buildStages = ({
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

export const buildWorkloadId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WL_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

export const resolveTarget = (
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

export const buildPlanLevelActions = (
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

export const planWorkload = (
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

export const buildPlanNextActions = (
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
