import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { JoelclawEnvelope, NextAction } from "../response";
import { WORKLOAD_VERSION, type WorkloadDispatchArtifact, type WorkloadDispatchGuidance, type WorkloadDispatchRecommendation, type WorkloadDispatchResult, type WorkloadExecutionLoop, type WorkloadHandoff, type WorkloadPlanArtifact, type WorkloadPlanningResult, type WorkloadStage, type WorkloadTarget } from "./workload-types";
import { dedupe, expandHome, toStageName } from "./workload-utils";

export const defaultPlanArtifactPath = (workloadId: string) =>
  `~/.joelclaw/workloads/${workloadId}.json`;

export const resolvePlanArtifactPath = (value: string, workloadId: string): string => {
  const expanded = expandHome(value);
  const absolute = resolve(expanded);
  const looksLikeDirectory =
    value.endsWith("/") ||
    (existsSync(absolute) && statSync(absolute).isDirectory());

  return looksLikeDirectory ? join(absolute, `${workloadId}.json`) : absolute;
};

export const writePlanArtifact = (
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

export const defaultDispatchArtifactPath = (dispatchId: string) =>
  `~/.joelclaw/workloads/${dispatchId}.json`;


export const writeDispatchArtifact = (
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

export const readJsonArtifact = (path: string): unknown => {
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

export const parseWorkloadPlanArtifact = (
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

export const selectDispatchStage = (
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

export const buildDispatchId = (now = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `WD_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
};

export const buildDispatchMailSubject = (
  workloadId: string,
  stage: WorkloadStage,
): string =>
  `Task: ${workloadId} ${stage.id} ${toStageName(stage.name, stage.id)}`;

export const buildDispatchMailBody = (options: {
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

export const buildDispatchExecutionLoop = (options: {
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

export const buildDispatchGuidance = (options: {
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

export const buildDispatchContract = (options: {
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


export const buildDispatchNextActions = (
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
