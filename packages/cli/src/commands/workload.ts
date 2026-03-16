import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
import { buildSuccessEnvelope, respond, respondError } from "../response";
import {
  AUTONOMY_LEVELS,
  PROOF_POSTURES,
  WORKLOAD_KIND_CHOICES,
  WORKLOAD_PRESETS,
  WORKLOAD_SHAPES,
  type WorkloadDispatchResult,
  type WorkloadPlanningResult,
  type WorkloadRunResult,
} from "./workload-types";
import {
  buildDispatchContract,
  buildDispatchId,
  buildDispatchNextActions,
  defaultDispatchArtifactPath,
  defaultPlanArtifactPath,
  parseWorkloadPlanArtifact,
  readJsonArtifact,
  resolvePlanArtifactPath,
  selectDispatchStage,
  writeDispatchArtifact,
  writePlanArtifact,
} from "./workload-dispatch";
import {
  buildExecutionExamples,
  buildPlanLevelActions,
  buildPlanNextActions,
  buildStages,
  buildVerification,
  buildWorkloadId,
  chooseBackend,
  chooseMode,
  chooseShape,
  inferArtifacts,
  inferKind,
  inferRisks,
  planWorkload,
  resolvePresetDefaults,
  resolveTarget,
} from "./workload-plan";
import {
  buildRunId,
  buildRunNextActions,
  buildWorkloadRunResult,
  isNestedWorkflowRigSandboxExecution,
  writeQueueAdmissionFailureInbox,
} from "./workload-run";
import {
  expandHome,
  isLocalSandboxState,
  normalizeOptionalFlagText,
  parsePathsFrom,
  shellQuote,
  splitCsv,
  splitCsvValues,
  splitDelimited,
  splitLines,
} from "./workload-utils";

export const SKILL_CONSUMER_DIRS = {
  agents: join(homedir(), ".agents", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
  claude: join(homedir(), ".claude", "skills"),
} as const;

export const resolveCanonicalSkillPath = (
  name: string,
  sourceRoot?: string,
): string | undefined => {
  const candidates = [
    ...(sourceRoot ? [join(resolve(expandHome(sourceRoot)), "skills", name, "SKILL.md")] : []),
    join(homedir(), "Code", "joelhooks", "joelclaw", "skills", name, "SKILL.md"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
};

export const detectInstalledSkillConsumers = (
  name: string,
): Array<"agents" | "pi" | "claude"> =>
  (Object.entries(SKILL_CONSUMER_DIRS) as Array<
    ["agents" | "pi" | "claude", string]
  >)
    .filter(([, dir]) => existsSync(join(dir, name, "SKILL.md")))
    .map(([consumer]) => consumer);

export const buildEnsureSkillCommand = (
  name: string,
  sourceRoot?: string,
): string =>
  `joelclaw skills ensure ${name}${sourceRoot ? ` --source-root ${shellQuote(sourceRoot)}` : ""}`;

export const buildExternalSkillInstallCommand = (name: string): string =>
  `npx skills add -y -g ${name}`;

export const buildReadSkillCommand = (path: string): string =>
  `read ${shellQuote(path)}`;

export function summarizeLocalSandboxEntries(entries: LocalSandboxRegistryEntry[], now: Date) {
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

export function toLocalSandboxListEntry(entry: LocalSandboxRegistryEntry, now: Date) {
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
          const failureInboxPath = writeQueueAdmissionFailureInbox(
            result.runtimeRequest,
            queueEither.left.message,
          );
          yield* Console.log(
            respondError(
              "workload run",
              queueEither.left.message,
              "WORKLOAD_RUN_QUEUE_ADMISSION_FAILED",
              `Check the queue registry/worker admission surface, or retry with --dry-run to inspect the normalized runtime request. Terminal inbox snapshot written to ${failureInboxPath}.`,
              [
                {
                  command: "joelclaw status [--agent-dispatch-canary]",
                  description: "Check worker health and the latest agent-dispatch proof surface",
                },
                {
                  command: "joelclaw queue stats [--hours <hours>]",
                  description: "Inspect recent queue dispatch and admission health",
                  params: {
                    hours: {
                      description: "Recent queue stats window",
                      value: 1,
                    },
                  },
                },
                {
                  command: "joelclaw workload sandboxes list --state <state>",
                  description: "Confirm no local sandbox residue was left behind",
                  params: {
                    state: {
                      description: "Sandbox state filter",
                      value: "running",
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
