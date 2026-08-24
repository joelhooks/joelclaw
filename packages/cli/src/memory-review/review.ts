import { Schema } from "effect";
import {
  MEMORY_REVIEW_SCHEMA_VERSION,
  type MemoryReviewBrainEvidence,
  type MemoryReviewFlowingEvidence,
  type MemoryReviewGitEvidence,
  type MemoryReviewHost,
  type MemoryReviewIssue,
  type MemoryReviewOtelEvidence,
  type MemoryReviewResultV1,
  MemoryReviewResultV1Schema,
  type MemoryReviewSessionEvidence,
  type MemoryReviewStatus,
} from "./contract";

export type MemoryReviewInput = {
  readonly since: string;
  readonly project?: string;
  readonly workstream?: string;
  readonly limit: number;
};

export type SessionsLaneInput = {
  readonly cutoffMs: number;
  readonly currentSessionIds: readonly string[];
  readonly limit: number;
  readonly project?: string;
  readonly workstream?: string;
};

export type SessionsLaneData = {
  readonly status: MemoryReviewStatus;
  readonly issues: readonly MemoryReviewIssue[];
  readonly sessions: readonly MemoryReviewSessionEvidence[];
  readonly total: number;
  readonly excludedCurrent: number;
  readonly byHost: Readonly<Record<string, number>>;
  readonly lastVerifiedByHost: Readonly<Record<string, string | undefined>>;
};

export type GitLaneData = {
  readonly status: MemoryReviewStatus;
  readonly issues: readonly MemoryReviewIssue[];
  readonly commits: readonly MemoryReviewGitEvidence[];
  readonly total: number;
  readonly repositories: number;
};

export type BrainLaneData = {
  readonly status: MemoryReviewStatus;
  readonly issues: readonly MemoryReviewIssue[];
  readonly pages: readonly MemoryReviewBrainEvidence[];
  readonly total: number;
  readonly omittedSensitive: number;
};

export type OtelLaneData = {
  readonly status: MemoryReviewStatus;
  readonly issues: readonly MemoryReviewIssue[];
  readonly events: readonly MemoryReviewOtelEvidence[];
  readonly total: number;
  readonly errors: number;
};

export type FlowingLaneData = {
  readonly status: MemoryReviewStatus;
  readonly issues: readonly MemoryReviewIssue[];
  readonly items: readonly MemoryReviewFlowingEvidence[];
  readonly records: number;
  readonly activeJobs: number;
  readonly blockedJobs: number;
};

export type MemoryReviewDependencies = {
  readonly now: () => number;
  readonly currentSessionIds: () => readonly string[];
  readonly collectHosts: (
    lastVerifiedByHost: Readonly<Record<string, string | undefined>>,
  ) => Promise<readonly MemoryReviewHost[]>;
  readonly collectSessions: (input: SessionsLaneInput) => Promise<SessionsLaneData>;
  readonly collectGit: (input: {
    cutoffMs: number;
    project?: string;
    workstream?: string;
    limit: number;
    hosts: readonly MemoryReviewHost[];
  }) => Promise<GitLaneData>;
  readonly collectBrain: (input: {
    cutoffMs: number;
    project?: string;
    workstream?: string;
    limit: number;
  }) => Promise<BrainLaneData>;
  readonly collectOtel: (input: {
    sinceHours: number;
    project?: string;
    workstream?: string;
    currentSessionIds: readonly string[];
    limit: number;
  }) => Promise<OtelLaneData>;
  readonly collectFlowing: (input: {
    project?: string;
    workstream?: string;
    limit: number;
  }) => Promise<FlowingLaneData>;
};

const DURATION_PATTERN = /^(\d+)(m|h|d|w)$/u;

export function parseSince(
  input: string,
  nowMs: number,
): { readonly cutoffMs: number; readonly requested: string } {
  const value = input.trim().toLowerCase();
  const match = DURATION_PATTERN.exec(value);
  if (match) {
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new Error("--since duration must be positive");
    const multiplier =
      match[2] === "m"
        ? 60_000
        : match[2] === "h"
          ? 3_600_000
          : match[2] === "d"
            ? 86_400_000
            : 604_800_000;
    return { cutoffMs: nowMs - amount * multiplier, requested: value };
  }

  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || parsed >= nowMs) {
    throw new Error("--since must be a past ISO instant or a duration such as 48h");
  }
  return { cutoffMs: parsed, requested: input };
}

function sourceIssue(source: MemoryReviewIssue["source"], _error: unknown): MemoryReviewIssue {
  return {
    code: "collector_failed",
    host: null,
    message: `${source} collector failed`,
    source,
  };
}

function failedSessions(error: unknown): SessionsLaneData {
  return {
    status: "failed",
    issues: [sourceIssue("sessions", error)],
    sessions: [],
    total: 0,
    excludedCurrent: 0,
    byHost: {},
    lastVerifiedByHost: {},
  };
}

function failedGit(error: unknown): GitLaneData {
  return {
    status: "failed",
    issues: [sourceIssue("git", error)],
    commits: [],
    total: 0,
    repositories: 0,
  };
}

function failedBrain(error: unknown): BrainLaneData {
  return {
    status: "failed",
    issues: [sourceIssue("brain", error)],
    pages: [],
    total: 0,
    omittedSensitive: 0,
  };
}

function failedOtel(error: unknown): OtelLaneData {
  return {
    status: "failed",
    issues: [sourceIssue("otel", error)],
    events: [],
    total: 0,
    errors: 0,
  };
}

function failedFlowing(error: unknown): FlowingLaneData {
  return {
    status: "failed",
    issues: [sourceIssue("flowing", error)],
    items: [],
    records: 0,
    activeJobs: 0,
    blockedJobs: 0,
  };
}

function hostSummary(hosts: readonly MemoryReviewHost[]): string | undefined {
  const unavailable = hosts.filter((host) => host.status !== "available");
  if (unavailable.length === 0) return undefined;
  return unavailable
    .map((host) => {
      const last = host.lastVerifiedAt
        ? `; last verified activity ${host.lastVerifiedAt}`
        : "; no verified activity timestamp";
      return `${host.alias} is ${host.status}${last}`;
    })
    .join(". ");
}

function buildSummary(input: {
  readonly sessions: SessionsLaneData;
  readonly git: GitLaneData;
  readonly brain: BrainLaneData;
  readonly otel: OtelLaneData;
  readonly flowing: FlowingLaneData;
  readonly hosts: readonly MemoryReviewHost[];
}): readonly string[] {
  const summary = [
    `Accepted runs recorded ${input.sessions.total} session captures; Git recorded ${input.git.total} commits across ${input.git.repositories} repositories.`,
    `Brain recorded ${input.brain.total} updated pages; OTEL recorded ${input.otel.total} events including ${input.otel.errors} errors.`,
    `Flowing memory reports ${input.flowing.records} records, ${input.flowing.activeJobs} active jobs, and ${input.flowing.blockedJobs} blocked jobs.`,
  ];
  const availability = hostSummary(input.hosts);
  if (availability) summary.push(availability);
  const degraded = [
    ["sessions", input.sessions.status],
    ["git", input.git.status],
    ["brain", input.brain.status],
    ["otel", input.otel.status],
    ["flowing", input.flowing.status],
  ].filter(([, status]) => status !== "available");
  if (degraded.length > 0) {
    summary.push(
      `Source warnings: ${degraded.map(([source, status]) => `${source}=${status}`).join(", ")}.`,
    );
  }
  return summary;
}

export async function buildMemoryReview(
  input: MemoryReviewInput,
  dependencies: MemoryReviewDependencies,
): Promise<MemoryReviewResultV1> {
  const nowMs = dependencies.now();
  const window = parseSince(input.since, nowMs);
  const currentSessionIds = [
    ...new Set(
      dependencies
        .currentSessionIds()
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const sinceHours = Math.max((nowMs - window.cutoffMs) / 3_600_000, 1 / 60);

  const sessions = await dependencies
    .collectSessions({
      cutoffMs: window.cutoffMs,
      currentSessionIds,
      limit: input.limit,
      project: input.project,
      workstream: input.workstream,
    })
    .catch(failedSessions);
  const hosts = await dependencies.collectHosts(sessions.lastVerifiedByHost).catch(() => [
    {
      alias: "fleet",
      current: false,
      lastVerifiedAt: null,
      status: "failed" as const,
    },
  ]);

  const [git, brain, otel] = await Promise.all([
    dependencies
      .collectGit({
        cutoffMs: window.cutoffMs,
        project: input.project,
        workstream: input.workstream,
        limit: input.limit,
        hosts,
      })
      .catch(failedGit),
    dependencies
      .collectBrain({
        cutoffMs: window.cutoffMs,
        project: input.project,
        workstream: input.workstream,
        limit: input.limit,
      })
      .catch(failedBrain),
    dependencies
      .collectOtel({
        sinceHours,
        project: input.project,
        workstream: input.workstream,
        currentSessionIds,
        limit: input.limit,
      })
      .catch(failedOtel),
  ]);
  // A scoped flowing read emits recall telemetry. Run it after OTEL collection so
  // this review never counts telemetry produced by its own request.
  const flowing = await dependencies
    .collectFlowing({ project: input.project, workstream: input.workstream, limit: input.limit })
    .catch(failedFlowing);

  const publicSessions = {
    status: sessions.status,
    issues: [...sessions.issues],
    sessions: [...sessions.sessions],
    total: sessions.total,
    excludedCurrent: sessions.excludedCurrent,
    byHost: { ...sessions.byHost },
  };

  const result = {
    _tag: "MemoryReviewResultV1" as const,
    currentRequestExcluded: true,
    generatedAt: new Date(nowMs).toISOString(),
    hosts: [...hosts],
    lanes: {
      brain: { ...brain, issues: [...brain.issues], pages: [...brain.pages] },
      flowing: { ...flowing, issues: [...flowing.issues], items: [...flowing.items] },
      git: { ...git, issues: [...git.issues], commits: [...git.commits] },
      otel: { ...otel, issues: [...otel.issues], events: [...otel.events] },
      sessions: publicSessions,
    },
    schemaVersion: MEMORY_REVIEW_SCHEMA_VERSION,
    scope: {
      mode: input.project || input.workstream ? ("filtered" as const) : ("fleet" as const),
      project: input.project ?? null,
      workstream: input.workstream ?? null,
    },
    summary: [...buildSummary({ sessions, git, brain, otel, flowing, hosts })],
    window: {
      cutoff: new Date(window.cutoffMs).toISOString(),
      requested: window.requested,
    },
  };

  const decoded = Schema.decodeUnknownSync(MemoryReviewResultV1Schema)(result);
  return decoded;
}
