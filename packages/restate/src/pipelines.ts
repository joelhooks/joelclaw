import type { DagNodeInput, DagRunRequest } from "./workflows/dag-orchestrator";

const shellEscape = (value: string): string => `'${value.replace(/'/g, `"'"'`)}'`;

const buildTier1RunnerCommand = (
  task: string,
  args: Record<string, unknown> = {},
): string => {
  const repoRoot = process.env.JOELCLAW_ROOT ?? `${process.env.HOME ?? "/Users/joel"}/Code/joelhooks/joelclaw`;
  const argsJson = JSON.stringify(args);

  return [
    `cd ${shellEscape(repoRoot)}`,
    `bun run scripts/restate/run-tier1-task.ts --task ${shellEscape(task)} --args-json ${shellEscape(argsJson)}`,
  ].join(" && ");
};

export type RestateCronPipelineDefinition = {
  jobName: string;
  displayName: string;
  pipeline: string;
  schedule: string;
  timezone: string;
  workflowIdPrefix: string;
  migratedFrom: string;
  buildRequest: (requestId?: string) => DagRunRequest;
};

export const buildHealthPipeline = (): DagNodeInput[] => [
  {
    id: "k8s-pods",
    task: "check k8s pod health",
    handler: "shell",
    config: {
      command:
        "kubectl get pods -n joelclaw -o json 2>&1 | jq -r '.items[] | \"\\(.metadata.name) \\(.status.phase) \\(.status.containerStatuses[0].restartCount // 0) restarts\"' 2>/dev/null || echo \"kubectl unavailable\"",
    },
  },
  {
    id: "inngest-health",
    task: "check Inngest server health",
    handler: "http",
    config: { url: "http://localhost:8288/health" },
  },
  {
    id: "restate-health",
    task: "check Restate admin health",
    handler: "http",
    config: { url: "http://localhost:9070/health" },
  },
  {
    id: "redis-ping",
    task: "check Redis connectivity",
    handler: "shell",
    config: {
      command:
        'kubectl exec -n joelclaw redis-0 -- redis-cli ping 2>&1 || echo "redis unreachable"',
    },
  },
  {
    id: "synthesize",
    task: "synthesize system health report",
    handler: "infer",
    dependsOn: ["k8s-pods", "inngest-health", "restate-health", "redis-ping"],
    config: {
      prompt: [
        "You are a system health analyst for a personal AI infrastructure.",
        "Analyze these health check results and produce a brief operational status report.",
        "Be specific about what's healthy and what needs attention. No fluff.",
        "",
        "## k8s pods",
        "{{k8s-pods}}",
        "",
        "## Inngest server",
        "{{inngest-health}}",
        "",
        "## Restate admin",
        "{{restate-health}}",
        "",
        "## Redis",
        "{{redis-ping}}",
      ].join("\n"),
      system:
        "You are a terse ops analyst. Output a structured health report: overall status (healthy/degraded/down), per-component status, and any action items. Keep it under 200 words.",
    },
  },
];

export const buildHealthDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "health",
  nodes: buildHealthPipeline(),
});

export const buildSkillGardenPipeline = (): DagNodeInput[] => [
  {
    id: "skill-garden-audit",
    task: "run direct skill-garden audit",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("skill-garden", { deep: false }),
    },
  },
];

export const buildSkillGardenDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "skill-garden",
  nodes: buildSkillGardenPipeline(),
});

export const buildTypesenseFullSyncPipeline = (): DagNodeInput[] => [
  {
    id: "vault-index",
    task: "index vault notes into Typesense",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("typesense-vault-sync"),
    },
  },
  {
    id: "blog-index",
    task: "index blog posts into Typesense",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("typesense-blog-sync"),
    },
  },
  {
    id: "slog-index",
    task: "index system log into Typesense",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("typesense-system-log-sync"),
    },
  },
  {
    id: "knowledge-sync",
    task: "index ADRs and skills into system knowledge",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("typesense-system-knowledge-sync"),
    },
  },
  {
    id: "summarize",
    task: "summarize full sync results",
    handler: "infer",
    dependsOn: ["vault-index", "blog-index", "slog-index", "knowledge-sync"],
    config: {
      prompt: [
        "You are summarizing a Typesense full sync run.",
        "Return a terse operator report with collection counts, errors, and whether follow-up is needed.",
        "",
        "## Vault sync",
        "{{vault-index}}",
        "",
        "## Blog sync",
        "{{blog-index}}",
        "",
        "## System log sync",
        "{{slog-index}}",
        "",
        "## System knowledge sync",
        "{{knowledge-sync}}",
      ].join("\n"),
      system:
        "You are a terse ops analyst. Output JSON with keys overallStatus, collections, errors, actionItems.",
    },
  },
];

export const buildTypesenseFullSyncDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "typesense-full-sync",
  nodes: buildTypesenseFullSyncPipeline(),
});

export const buildDailyDigestPipeline = (): DagNodeInput[] => [
  {
    id: "daily-digest",
    task: "generate the daily digest directly",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("daily-digest"),
    },
  },
];

export const buildDailyDigestDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "daily-digest",
  nodes: buildDailyDigestPipeline(),
});

export const buildSubscriptionCheckFeedsPipeline = (): DagNodeInput[] => [
  {
    id: "subscription-check-feeds",
    task: "check due subscriptions directly",
    handler: "shell",
    config: {
      command: buildTier1RunnerCommand("subscription-check-feeds", { forceAll: false }),
    },
  },
];

export const buildSubscriptionCheckFeedsDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "subscription-check-feeds",
  nodes: buildSubscriptionCheckFeedsPipeline(),
});

export type PiMonoSyncPipelineOptions = {
  repo?: string;
  localClonePath?: string;
  fullBackfill?: boolean;
  maxPages?: number;
  perPage?: number;
  materializeProfile?: boolean;
};

export const buildPiMonoArtifactsSyncPipeline = (
  options: PiMonoSyncPipelineOptions = {},
): DagNodeInput[] => {
  const repo = options.repo ?? "badlogic/pi-mono";
  const args = {
    repo,
    ...(options.localClonePath ? { localClonePath: options.localClonePath } : {}),
    ...(options.fullBackfill ? { fullBackfill: true } : {}),
    ...(typeof options.maxPages === "number" ? { maxPages: options.maxPages } : {}),
    ...(typeof options.perPage === "number" ? { perPage: options.perPage } : {}),
    ...(options.materializeProfile === false ? { materializeProfile: false } : { materializeProfile: true }),
  };

  return [
    {
      id: "sync-artifacts",
      task: `sync ${repo} artifacts into Typesense`,
      handler: "shell",
      config: {
        command: buildTier1RunnerCommand("pi-mono-artifacts-sync", args),
      },
    },
    {
      id: "summarize-sync",
      task: `summarize ${repo} sync outcome`,
      handler: "infer",
      dependsOn: ["sync-artifacts"],
      config: {
        prompt: [
          `You are summarizing a pi-mono corpus sync for ${repo}.`,
          "Use the sync JSON below to produce an operator report.",
          "State whether the run did a full backfill or incremental sync, what artifact kinds were imported, and whether follow-up is needed.",
          "",
          "## Sync result",
          "{{sync-artifacts}}",
        ].join("\n"),
        system:
          "You are a terse ops analyst. Output JSON with keys status, summary, importedKinds, followUp, and operatorCommands.",
      },
    },
  ];
};

export const buildPiMonoArtifactsSyncDagRequest = (
  options: PiMonoSyncPipelineOptions = {},
  requestId?: string,
): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: `pi-mono-sync:${options.repo ?? "badlogic/pi-mono"}`,
  nodes: buildPiMonoArtifactsSyncPipeline(options),
});

export const RESTATE_CRON_PIPELINES: Record<string, RestateCronPipelineDefinition> = {
  health: {
    jobName: "restate-health-check",
    displayName: "Restate health check",
    pipeline: "health",
    schedule: "0 7 * * * *",
    timezone: "America/Los_Angeles",
    workflowIdPrefix: "restate-health-scheduled",
    migratedFrom: "check/system-health-signals-schedule",
    buildRequest: buildHealthDagRequest,
  },
  "skill-garden": {
    jobName: "restate-skill-garden",
    displayName: "Restate skill garden",
    pipeline: "skill-garden",
    schedule: "0 0 6 * * *",
    timezone: "America/Los_Angeles",
    workflowIdPrefix: "restate-skill-garden-scheduled",
    migratedFrom: "skill-garden",
    buildRequest: buildSkillGardenDagRequest,
  },
  "typesense-full-sync": {
    jobName: "restate-typesense-full-sync",
    displayName: "Restate Typesense full sync",
    pipeline: "typesense-full-sync",
    schedule: "0 0 11 * * *",
    timezone: "America/Los_Angeles",
    workflowIdPrefix: "restate-typesense-full-sync-scheduled",
    migratedFrom: "typesense/full-sync",
    buildRequest: buildTypesenseFullSyncDagRequest,
  },
  "daily-digest": {
    jobName: "restate-daily-digest",
    displayName: "Restate daily digest",
    pipeline: "daily-digest",
    schedule: "0 55 7 * * *",
    timezone: "America/Los_Angeles",
    workflowIdPrefix: "restate-daily-digest-scheduled",
    migratedFrom: "memory/digest-daily",
    buildRequest: buildDailyDigestDagRequest,
  },
  "subscription-check-feeds": {
    jobName: "restate-subscription-check-feeds",
    displayName: "Restate subscription check feeds",
    pipeline: "subscription-check-feeds",
    schedule: "0 0 * * * *",
    timezone: "America/Los_Angeles",
    workflowIdPrefix: "restate-subscription-check-feeds-scheduled",
    migratedFrom: "subscription/check-feeds",
    buildRequest: buildSubscriptionCheckFeedsDagRequest,
  },
};

export const RESTATE_TIER1_PIPELINE_KEYS = [
  "health",
  "skill-garden",
  "typesense-full-sync",
  "daily-digest",
  "subscription-check-feeds",
] as const;
