import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { executeCapabilityCommand } from "../capabilities/runtime";
import { type FleetHostExpectation, loadFleetManifest } from "../commands/fleet/manifest";
import { probeFleetHost } from "../commands/fleet/probe";
import type {
  MemoryReviewBrainEvidence,
  MemoryReviewFlowingEvidence,
  MemoryReviewGitEvidence,
  MemoryReviewHost,
  MemoryReviewIssue,
  MemoryReviewOtelEvidence,
  MemoryReviewStatus,
} from "./contract";
import type {
  BrainLaneData,
  FlowingLaneData,
  GitLaneData,
  MemoryReviewDependencies,
  OtelLaneData,
  SessionsLaneData,
} from "./review";

const SESSION_INDEX_PATH =
  process.env.SESSION_INDEX_PATH || join(homedir(), ".joelclaw", "search", "sessions.db");
const BRAIN_REGISTRY_PATH =
  process.env.JOELCLAW_BRAIN_ROOTS ||
  join(homedir(), "Code", "joelhooks", "dark-wizard", "brain-roots.json");
const FLOWING_STATUS_COMMAND_FALLBACK = join(homedir(), ".local", "bin", "flowing-memory-status");
const GIT_SCAN_TIMEOUT_MS = 30_000;

function issue(
  source: MemoryReviewIssue["source"],
  code: string,
  message: string,
  host: string | null = null,
): MemoryReviewIssue {
  return { source, code, message, host };
}

function iso(value: number | undefined): string | undefined {
  return value && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 20;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

type SessionRow = {
  run_id: string;
  conversation_id: string | null;
  machine_id: string;
  agent_runtime: string;
  ended_at: number;
  turn_count: number;
};

type HostCountRow = { machine_id: string; count: number; latest: number };

export function collectSessionsFromDatabase(
  path: string,
  input: Parameters<MemoryReviewDependencies["collectSessions"]>[0],
): SessionsLaneData {
  if (!existsSync(path)) {
    return {
      status: "unavailable",
      issues: [
        issue("sessions", "session_index_missing", "The accepted-run session index is unavailable"),
      ],
      sessions: [],
      total: 0,
      excludedCurrent: 0,
      byHost: {},
      lastVerifiedByHost: {},
    };
  }

  const db = new Database(path, { readonly: true });
  try {
    const currentIds = input.currentSessionIds;
    const exclusionSql =
      currentIds.length > 0
        ? `AND COALESCE(conversation_id, run_id) NOT IN (${currentIds.map(() => "?").join(",")})`
        : "";
    const commonArgs = [input.cutoffMs, ...currentIds];
    const totalRow = db
      .query(`
      SELECT count(*) AS count FROM (
        SELECT COALESCE(conversation_id, run_id) AS session_key
        FROM runs
        WHERE ended_at >= ? ${exclusionSql}
        GROUP BY session_key
      )
    `)
      .get(...commonArgs) as { count: number };
    const rows = db
      .query(`
      WITH ranked AS (
        SELECT run_id, conversation_id, machine_id, agent_runtime, ended_at, turn_count,
          row_number() OVER (
            PARTITION BY COALESCE(conversation_id, run_id)
            ORDER BY ended_at DESC, captured_at DESC, run_id DESC
          ) AS position
        FROM runs
        WHERE ended_at >= ? ${exclusionSql}
      )
      SELECT run_id, conversation_id, machine_id, agent_runtime, ended_at, turn_count
      FROM ranked
      WHERE position = 1
      ORDER BY ended_at DESC
      LIMIT ?
    `)
      .all(...commonArgs, boundedLimit(input.limit)) as SessionRow[];
    const excludedRow =
      currentIds.length === 0
        ? { count: 0 }
        : (db
            .query(
              `SELECT count(DISTINCT COALESCE(conversation_id, run_id)) AS count FROM runs WHERE ended_at >= ? AND COALESCE(conversation_id, run_id) IN (${currentIds.map(() => "?").join(",")})`,
            )
            .get(input.cutoffMs, ...currentIds) as { count: number });
    const hostRows = db
      .query(`
      SELECT machine_id, count(DISTINCT COALESCE(conversation_id, run_id)) AS count, max(ended_at) AS latest
      FROM runs
      GROUP BY machine_id
    `)
      .all() as HostCountRow[];
    const currentHostRows = db
      .query(`
      WITH ranked AS (
        SELECT machine_id,
          row_number() OVER (
            PARTITION BY COALESCE(conversation_id, run_id)
            ORDER BY ended_at DESC, captured_at DESC, run_id DESC
          ) AS position
        FROM runs
        WHERE ended_at >= ? ${exclusionSql}
      )
      SELECT machine_id, count(*) AS count
      FROM ranked
      WHERE position = 1
      GROUP BY machine_id
    `)
      .all(...commonArgs) as Array<{ machine_id: string; count: number }>;

    const scoped = Boolean(input.project || input.workstream);
    const scopeIssues = scoped
      ? [
          issue(
            "sessions",
            "scope_filter_unavailable",
            "Session metadata has no trusted project/workstream field; use sessions search for explicit drill-down",
          ),
        ]
      : [];
    return {
      status: scoped ? "partial" : "available",
      issues: scopeIssues,
      sessions: scoped
        ? []
        : rows.map((row) => ({
            runId: row.run_id,
            conversationId: row.conversation_id,
            host: row.machine_id,
            runtime: row.agent_runtime,
            endedAt: new Date(row.ended_at).toISOString(),
            turnCount: row.turn_count,
          })),
      total: scoped ? 0 : nonNegativeInteger(totalRow.count),
      excludedCurrent: scoped ? 0 : nonNegativeInteger(excludedRow.count),
      byHost: scoped
        ? {}
        : Object.fromEntries(
            currentHostRows.map((row) => [row.machine_id, nonNegativeInteger(row.count)]),
          ),
      lastVerifiedByHost: Object.fromEntries(
        hostRows.map((row) => [row.machine_id, iso(Number(row.latest))]),
      ),
    };
  } finally {
    db.close();
  }
}

export async function collectSessions(
  input: Parameters<MemoryReviewDependencies["collectSessions"]>[0],
): Promise<SessionsLaneData> {
  return collectSessionsFromDatabase(SESSION_INDEX_PATH, input);
}

export async function collectHosts(
  lastVerifiedByHost: Readonly<Record<string, string | undefined>>,
): Promise<readonly MemoryReviewHost[]> {
  const manifest = loadFleetManifest();
  const currentHostname = hostname().split(".")[0] ?? "";
  return manifest.hosts.map((host) => {
    const probeHostname =
      currentHostname.toLowerCase() === host.expectedHostname.toLowerCase()
        ? host.expectedHostname
        : currentHostname;
    const result = probeFleetHost(host, undefined, probeHostname);
    const failures = result.failures.filter(
      (failure) =>
        !(
          failure.code === "identity_mismatch" &&
          result.facts.hostname?.toLowerCase() === host.expectedHostname.toLowerCase()
        ),
    );
    const hardFailure = failures.some((failure) =>
      ["ssh_failed", "timeout", "identity_mismatch"].includes(failure.code),
    );
    const status: MemoryReviewStatus = hardFailure
      ? "unavailable"
      : failures.length === 0
        ? "available"
        : "partial";
    return {
      alias: host.alias,
      current: !hardFailure,
      lastVerifiedAt: lastVerifiedByHost[host.alias] ?? null,
      status,
    };
  });
}

const GIT_SCAN_SCRIPT = String.raw`
set -uo pipefail
cutoff="$1"
project="$2"
workstream="$3"
limit="$4"
[ "$project" = '-' ] && project=''
[ "$workstream" = '-' ] && workstream=''
count=0
repos_seen=0
if [ ! -d "$HOME/Code" ]; then
  printf '__issue__\x1froot_unavailable\n'
  exit 0
fi
while IFS= read -r -d '' marker; do
  repo=$(dirname "$marker")
  case "$repo" in *'/.worktrees/'*|*'/node_modules/'*) continue;; esac
  repos_seen=$((repos_seen + 1))
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    printf '__issue__\x1frepository_unreadable\n'
    continue
  fi
  remote=$(git -C "$repo" config --get remote.origin.url 2>/dev/null || true)
  canonical=''
  case "$remote" in
    https://github.com/*) canonical=$(printf '%s' "$remote" | sed -E 's#^https://github\.com/##; s#\.git$##');;
    git@github.com:*) canonical=$(printf '%s' "$remote" | sed -E 's#^git@github\.com:##; s#\.git$##');;
    ssh://git@github.com/*|ssh://github.com/*) canonical=$(printf '%s' "$remote" | sed -E 's#^ssh://(git@)?github\.com/##; s#\.git$##');;
  esac
  canonical=$(printf '%s' "$canonical" | tr '[:upper:]' '[:lower:]')
  case "$canonical" in ''|*[!a-z0-9._/-]*)
    digest=$(printf '%s' "$repo" | shasum -a 256 | awk '{print $1}' | cut -c1-16)
    canonical="local/$digest"
  ;; esac
  if [ -n "$project" ]; then
    projectSlash=$(printf '%s' "$project" | sed -E 's#\.#/#')
    case "$canonical" in "$project"|"$projectSlash") ;; *) continue;; esac
  fi
  branch='all'
  ref_args='--all'
  if [ -n "$workstream" ]; then
    ref_args=''
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$workstream"; then
      ref_args="refs/heads/$workstream"
    fi
    if git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$workstream"; then
      ref_args="$ref_args refs/remotes/origin/$workstream"
    fi
    [ -n "$ref_args" ] || continue
    branch="$workstream"
  fi
  if ! log=$(git -C "$repo" log $ref_args --since="@$cutoff" --format='%H%x1f%aI%x1f%s' -n 20 2>/dev/null); then
    printf '__issue__\x1flog_unavailable\n'
    continue
  fi
  while IFS=$'\x1f' read -r hash at subject; do
    [ -n "$hash" ] || continue
    printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\n' "$canonical" "$branch" "$hash" "$at" "$subject"
    count=$((count + 1))
    [ "$count" -lt "$limit" ] || exit 0
  done <<< "$log"
done < <(find "$HOME/Code" -mindepth 2 -maxdepth 4 \
  \( -name node_modules -o -name .build -o -name vendor -o -name .agent_sources -o -name .agent-sources -o -name .worktrees \) -prune -o \
  \( -type d -o -type f \) -name .git -print0 2>/dev/null)
[ "$repos_seen" -gt 0 ] || printf '__issue__\x1fno_repositories\n'
`;

function runGitScan(
  host: FleetHostExpectation,
  input: { cutoffMs: number; project?: string; workstream?: string; limit: number },
): { ok: boolean; stdout: string; stderr: string; timedOut: boolean } {
  const args = [
    String(Math.floor(input.cutoffMs / 1000)),
    input.project ?? "-",
    input.workstream ?? "-",
    String(boundedLimit(input.limit)),
  ];
  const local = hostname().split(".")[0]?.toLowerCase() === host.expectedHostname.toLowerCase();
  const result = local
    ? spawnSync("bash", ["-s", "--", ...args], {
        input: GIT_SCAN_SCRIPT,
        encoding: "utf8",
        timeout: GIT_SCAN_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      })
    : spawnSync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "ServerAliveInterval=5",
          "-o",
          "ServerAliveCountMax=1",
          "--",
          host.sshTarget,
          "bash",
          "-s",
          "--",
          ...args,
        ],
        {
          input: GIT_SCAN_SCRIPT,
          encoding: "utf8",
          timeout: GIT_SCAN_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function gitIssueCount(stdout: string): number {
  return stdout.split("\n").filter((line) => line.startsWith("__issue__\x1f")).length;
}

function parseGitEvidence(host: string, stdout: string): MemoryReviewGitEvidence[] {
  return stdout.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const [repository, branch, hash, at, subject] = line.split("\x1f");
    if (
      !repository ||
      !branch ||
      !hash ||
      !at ||
      subject === undefined ||
      !Number.isFinite(Date.parse(at))
    )
      return [];
    return [{ repository, branch, hash, at, subject, host }];
  });
}

export async function collectGit(
  input: Parameters<MemoryReviewDependencies["collectGit"]>[0],
): Promise<GitLaneData> {
  const manifest = loadFleetManifest();
  const hostState = new Map(input.hosts.map((host) => [host.alias, host]));
  const commits: MemoryReviewGitEvidence[] = [];
  const issues: MemoryReviewIssue[] = [];

  for (const host of manifest.hosts) {
    const current = hostState.get(host.alias);
    if (!current?.current) {
      issues.push(
        issue(
          "git",
          "host_unavailable",
          "Git activity could not be read from this host",
          host.alias,
        ),
      );
      continue;
    }
    const result = runGitScan(host, { ...input, limit: 500 });
    if (!result.ok) {
      issues.push(
        issue(
          "git",
          result.timedOut ? "git_scan_timeout" : "git_scan_failed",
          "Git activity scan failed",
          host.alias,
        ),
      );
      continue;
    }
    const repositoryIssues = gitIssueCount(result.stdout);
    if (repositoryIssues > 0) {
      issues.push(
        issue(
          "git",
          "repository_scan_partial",
          `${repositoryIssues} Git repositories could not be read`,
          host.alias,
        ),
      );
    }
    commits.push(...parseGitEvidence(host.alias, result.stdout));
  }

  const uniqueCommits = [
    ...new Map(
      commits.map(
        (commit) => [`${commit.host}:${commit.repository}:${commit.hash}`, commit] as const,
      ),
    ).values(),
  ];
  uniqueCommits.sort(
    (left, right) =>
      Date.parse(right.at) - Date.parse(left.at) || left.hash.localeCompare(right.hash),
  );
  const limited = uniqueCommits.slice(0, boundedLimit(input.limit));
  return {
    status: issues.length === 0 ? "available" : limited.length > 0 ? "partial" : "unavailable",
    issues,
    commits: limited,
    total: uniqueCommits.length,
    repositories: new Set(uniqueCommits.map((commit) => `${commit.host}:${commit.repository}`))
      .size,
  };
}

type BrainRootEntry = { name: string; repo: string; checkout: string; brainPath: string };

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function walkSvx(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".svx")) paths.push(path);
    }
  }
  return paths;
}

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const entries: Array<[string, string]> = [];
  for (const line of text.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    entries.push([
      line.slice(0, separator).trim(),
      line
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/gu, ""),
    ]);
  }
  return Object.fromEntries(entries);
}

function matchesBrainProject(rootRepo: string, project: string | undefined): boolean {
  if (!project) return true;
  const separator = project.indexOf(".");
  const projectRepo =
    separator >= 0 ? `${project.slice(0, separator)}/${project.slice(separator + 1)}` : project;
  return rootRepo === project || rootRepo === projectRepo;
}

function reviewDates(cutoffMs: number, nowMs: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(cutoffMs);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= nowMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function collectBrain(
  input: Parameters<MemoryReviewDependencies["collectBrain"]>[0],
): Promise<BrainLaneData> {
  if (!existsSync(BRAIN_REGISTRY_PATH)) {
    return {
      status: "unavailable",
      issues: [issue("brain", "brain_registry_missing", "The Brain root registry is unavailable")],
      pages: [],
      total: 0,
      omittedSensitive: 0,
    };
  }
  const raw = JSON.parse(readFileSync(BRAIN_REGISTRY_PATH, "utf8")) as { roots?: unknown };
  if (!Array.isArray(raw.roots)) throw new Error("Brain root registry has no roots");
  const roots = raw.roots.filter((value): value is BrainRootEntry => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return [item.name, item.repo, item.checkout, item.brainPath].every(
      (field) => typeof field === "string",
    );
  });
  const pages: MemoryReviewBrainEvidence[] = [];
  let omittedSensitive = 0;
  const issues: MemoryReviewIssue[] = [];
  for (const root of roots) {
    if (!matchesBrainProject(root.repo, input.project)) continue;
    const brainRoot = resolve(expandHome(root.checkout), root.brainPath);
    if (!existsSync(brainRoot)) {
      issues.push(
        issue("brain", "brain_root_missing", `Registered Brain root ${root.name} is unavailable`),
      );
      continue;
    }
    for (const path of walkSvx(brainRoot)) {
      const stat = statSync(path);
      if (stat.mtimeMs < input.cutoffMs) continue;
      const metadata = frontmatter(readFileSync(path, "utf8").slice(0, 16_384));
      const pathSegments = relative(brainRoot, path).split(/[\\/]/u);
      if (
        input.workstream &&
        !pathSegments.includes(input.workstream) &&
        metadata.workstream !== input.workstream
      )
        continue;
      const privacy = metadata.privacy;
      if (privacy !== "public" && privacy !== "private") {
        omittedSensitive += 1;
        continue;
      }
      const refDigest = createHash("sha256")
        .update(`${root.name}\u0000${relative(brainRoot, path)}`)
        .digest("hex")
        .slice(0, 16);
      pages.push({
        modifiedAt: stat.mtime.toISOString(),
        ref: `brain:${root.name}:${refDigest}`,
        privacy,
        root: root.name,
        title: metadata.title || basename(path, ".svx"),
      });
    }
  }

  if (!input.project && !input.workstream) {
    const dailyRoot = join(homedir(), ".joelclaw", "workspace", "memory");
    const missingDates = reviewDates(input.cutoffMs, Date.now()).filter(
      (date) => !existsSync(join(dailyRoot, `${date}.md`)),
    );
    if (missingDates.length > 0) {
      issues.push(
        issue(
          "brain",
          "daily_memory_missing",
          `${missingDates.length} daily memory files are missing in the review window`,
        ),
      );
    }
  }
  pages.sort(
    (left, right) =>
      Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
      left.ref.localeCompare(right.ref),
  );
  return {
    status: issues.length === 0 ? "available" : pages.length > 0 ? "partial" : "stale",
    issues,
    pages: pages.slice(0, boundedLimit(input.limit)),
    total: pages.length,
    omittedSensitive,
  };
}

type OtelCapabilityResult = {
  readonly found?: unknown;
  readonly events?: unknown;
  readonly facets?: unknown;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function otelErrors(facets: unknown): number {
  if (!Array.isArray(facets)) return 0;
  const level = facets.map(object).find((facet) => facet?.field_name === "level");
  if (!Array.isArray(level?.counts)) return 0;
  return level.counts.map(object).reduce((total, count) => {
    const value = text(count?.value);
    return total + (value === "error" || value === "fatal" ? nonNegativeInteger(count?.count) : 0);
  }, 0);
}

export async function collectOtel(
  input: Parameters<MemoryReviewDependencies["collectOtel"]>[0],
): Promise<OtelLaneData> {
  if (input.project || input.workstream) {
    return {
      status: "partial",
      issues: [
        issue(
          "otel",
          "scope_filter_unavailable",
          "OTEL rows have no trusted project/workstream field; use otel search for explicit drill-down",
        ),
      ],
      events: [],
      total: 0,
      errors: 0,
    };
  }
  const subcommand = "list";
  const result = await Effect.runPromise(
    executeCapabilityCommand<OtelCapabilityResult>({
      capability: "otel",
      subcommand,
      args: {
        hours: input.sinceHours,
        limit: boundedLimit(input.limit),
        page: 1,
      },
    }).pipe(Effect.either),
  );
  if (result._tag === "Left") {
    return {
      status: "unavailable",
      issues: [issue("otel", "otel_unavailable", "OTEL source is unavailable")],
      events: [],
      total: 0,
      errors: 0,
    };
  }
  const payload = object(result.right) ?? {};
  const rawEvents = Array.isArray(payload.events) ? payload.events : [];
  const events: MemoryReviewOtelEvidence[] = rawEvents.flatMap((value) => {
    const event = object(value);
    if (!event) return [];
    const timestamp = text(event.ts);
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return [];
    return [
      {
        action: text(event.action),
        component: text(event.component),
        host: text(event.systemId) || null,
        level: text(event.level),
        success: event.success === true,
        timestamp,
      },
    ];
  });
  return {
    status: "available",
    issues: [],
    events,
    total: nonNegativeInteger(payload.found ?? events.length),
    errors: otelErrors(payload.facets),
  };
}

function hasCompleteStatus(output: string): boolean {
  return ["records", "active jobs", "blocked jobs"].every((field) => {
    const match = new RegExp(`^${field}:\\s*(\\d+)$`, "mu").exec(output);
    return match?.[1] !== undefined && String(nonNegativeInteger(match[1])) === match[1];
  });
}

function parseStatus(output: string): { records: number; activeJobs: number; blockedJobs: number } {
  const values = new Map<string, number>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const rawValue = line.slice(separator + 1).trim();
    const value = nonNegativeInteger(rawValue);
    if (String(value) === rawValue) values.set(line.slice(0, separator).trim(), value);
  }
  return {
    records: values.get("records") ?? 0,
    activeJobs: values.get("active jobs") ?? 0,
    blockedJobs: values.get("blocked jobs") ?? 0,
  };
}

function flowingItems(payload: unknown): {
  items: MemoryReviewFlowingEvidence[];
  issues: MemoryReviewIssue[];
} {
  const composed = object(object(payload)?.composed);
  const lanes = object(composed?.lanes);
  const items: MemoryReviewFlowingEvidence[] = [];
  const issues: MemoryReviewIssue[] = [];
  for (const [field, laneName] of [
    ["flowingReflections", "flowing-reflections"],
    ["flowingObservations", "flowing-observations"],
  ] as const) {
    const lane = object(lanes?.[field]);
    if (!lane) {
      issues.push(issue("flowing", "flowing_lane_missing", `${laneName} is missing`));
      continue;
    }
    if (lane._tag !== "RecallLaneAvailableV1") {
      issues.push(issue("flowing", "flowing_lane_unavailable", `${laneName} is unavailable`));
      continue;
    }
    const rawHealth = text(object(lane.health)?._tag);
    const health = ["Healthy", "Stale", "Failed", "Unknown"].includes(rawHealth)
      ? rawHealth
      : "Unknown";
    if (health !== "Healthy") {
      issues.push(
        issue(
          "flowing",
          `flowing_health_${health.toLowerCase()}`,
          `${laneName} health is ${health}`,
        ),
      );
    }
    if (!Array.isArray(lane.items)) continue;
    for (const value of lane.items) {
      const item = object(value);
      if (!item) continue;
      const rank = positiveInteger(item.rank);
      if (rank === undefined) {
        issues.push(
          issue("flowing", "flowing_item_invalid", `${laneName} contains an invalid item`),
        );
        continue;
      }
      items.push({
        health,
        id: text(item.id),
        kind: text(item.kind),
        lane: laneName,
        rank,
        title: text(item.title),
      });
    }
  }
  return { items, issues };
}

export async function collectFlowing(
  input: Parameters<MemoryReviewDependencies["collectFlowing"]>[0],
): Promise<FlowingLaneData> {
  const statusCommand =
    process.env.FLOWING_MEMORY_STATUS_COMMAND || FLOWING_STATUS_COMMAND_FALLBACK;
  const statusResult = spawnSync(statusCommand, [], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (statusResult.error) {
    return {
      status: "unavailable",
      issues: [
        issue("flowing", "flowing_status_unavailable", "Flowing memory status is unavailable"),
      ],
      items: [],
      records: 0,
      activeJobs: 0,
      blockedJobs: 0,
    };
  }
  const statusOutput = statusResult.stdout ?? "";
  if (!hasCompleteStatus(statusOutput)) {
    if (statusResult.status !== 0) {
      return {
        status: "unavailable",
        issues: [
          issue("flowing", "flowing_status_unavailable", "Flowing memory status is unavailable"),
        ],
        items: [],
        records: 0,
        activeJobs: 0,
        blockedJobs: 0,
      };
    }
    return {
      status: "failed",
      issues: [
        issue(
          "flowing",
          "flowing_status_malformed",
          "Flowing memory status omitted required counts",
        ),
      ],
      items: [],
      records: 0,
      activeJobs: 0,
      blockedJobs: 0,
    };
  }
  const status = parseStatus(statusOutput);
  const issues: MemoryReviewIssue[] = [];
  if (statusResult.status !== 0) {
    issues.push(
      issue(
        "flowing",
        "flowing_status_degraded",
        "Flowing memory status exited nonzero; counts were readable",
      ),
    );
  }
  if (status.blockedJobs > 0) {
    issues.push(
      issue(
        "flowing",
        "flowing_jobs_blocked",
        `${status.blockedJobs} flowing memory jobs are blocked`,
      ),
    );
  }
  let items: MemoryReviewFlowingEvidence[] = [];

  if (input.project && input.workstream) {
    const recall = await Effect.runPromise(
      executeCapabilityCommand<{ raw: boolean; payload?: unknown }>({
        capability: "recall",
        subcommand: "query",
        args: {
          allowedPrivacy: ["public", "private"],
          curatedLimit: Math.min(boundedLimit(input.limit), 20),
          decidedAt: new Date().toISOString(),
          includeSuperseded: false,
          observationLimit: Math.min(boundedLimit(input.limit), 20),
          principalRef: "operator:joel",
          project: input.project,
          purpose: "recent-memory-review",
          query: "recent work decisions changes failures",
          reflectionLimit: Math.min(boundedLimit(input.limit), 20),
          workstream: input.workstream,
        },
      }).pipe(Effect.either),
    );
    if (recall._tag === "Left") {
      issues.push(
        issue("flowing", "flowing_recall_unavailable", "Scoped flowing recall is unavailable"),
      );
    } else {
      const parsed = flowingItems(recall.right.payload);
      items = parsed.items;
      issues.push(...parsed.issues);
    }
  } else if (input.project || input.workstream) {
    issues.push(
      issue(
        "flowing",
        "exact_scope_required",
        "Flowing evidence requires both project and workstream filters",
      ),
    );
  }

  return {
    status: issues.length === 0 ? "available" : "partial",
    issues,
    items,
    ...status,
  };
}

export const defaultMemoryReviewDependencies: MemoryReviewDependencies = {
  now: () => Date.now(),
  currentSessionIds: () =>
    [
      process.env.PI_SESSION_ID,
      process.env.PI_INTERCOM_SESSION_ID,
      process.env.CLAUDE_CODE_SESSION_ID,
      process.env.CODEX_SESSION_ID,
      process.env.CURSOR_SESSION_ID,
      process.env.GROK_SESSION_ID,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  collectHosts,
  collectSessions,
  collectGit,
  collectBrain,
  collectOtel,
  collectFlowing,
};

export const __memoryReviewAdapterTestUtils = {
  GIT_SCAN_SCRIPT,
  frontmatter,
  gitIssueCount,
  parseGitEvidence,
  parseStatus,
  flowingItems,
  hasCompleteStatus,
  matchesBrainProject,
  otelErrors,
  reviewDates,
  runGitScan,
};
