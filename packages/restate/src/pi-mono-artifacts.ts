import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const GITHUB_API_URL = "https://api.github.com";
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const PI_MONO_ARTIFACTS_COLLECTION = "pi_mono_artifacts";
const CHECKPOINT_KIND = "sync_state";
const PROFILE_KIND = "maintainer_profile";
const DEFAULT_REPO = "badlogic/pi-mono";
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_PER_PAGE = 100;
const MAX_CONTENT_CHARS = 16_000;
const MINI_LM_MODEL_CONFIG = {
  model_name: "ts/all-MiniLM-L12-v2",
  indexing_prefix: "",
  query_prefix: "",
};

export type PiMonoArtifactKind =
  | "repo_doc"
  | "issue"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment"
  | "commit"
  | "release"
  | "maintainer_profile"
  | "sync_state";

export type PiMonoArtifactDoc = {
  id: string;
  repo: string;
  kind: PiMonoArtifactKind;
  title?: string;
  content: string;
  url: string;
  number?: number;
  state?: string;
  author: string;
  author_role?: string;
  maintainer_signal?: boolean;
  package_scopes?: string[];
  labels?: string[];
  decision_tags?: string[];
  path?: string;
  sha?: string;
  tag?: string;
  thread_key?: string;
  created_at: number;
  updated_at?: number;
};

export type PiMonoSyncOptions = {
  repo?: string;
  localClonePath?: string;
  fullBackfill?: boolean;
  maxPages?: number;
  perPage?: number;
  materializeProfile?: boolean;
};

export type PiMonoSyncSummary = {
  repo: string;
  collection: string;
  mode: "full" | "incremental";
  checkpointUsed: boolean;
  checkpointIso: string | null;
  localClonePath: string;
  startedAt: string;
  completedAt: string;
  imported: number;
  byKind: Record<string, number>;
  pagesFetched: Record<string, number>;
  profileDocumentId: string | null;
  checkpointDocumentId: string;
};

type GitHubListIssue = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  url: string;
  state: string;
  user?: { login?: string | null } | null;
  labels?: Array<{ name?: string | null }>;
  created_at: string;
  updated_at: string;
  pull_request?: { url?: string };
  author_association?: string;
};

type GitHubIssueComment = {
  id: number;
  body?: string | null;
  html_url: string;
  issue_url: string;
  user?: { login?: string | null } | null;
  created_at: string;
  updated_at: string;
  author_association?: string;
};

type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  user?: { login?: string | null } | null;
  labels?: Array<{ name?: string | null }>;
  created_at: string;
  updated_at: string;
  author_association?: string;
};

type GitHubPullReviewComment = {
  id: number;
  body?: string | null;
  html_url: string;
  path?: string | null;
  pull_request_url: string;
  user?: { login?: string | null } | null;
  created_at: string;
  updated_at: string;
  author_association?: string;
};

type GitHubCommit = {
  sha: string;
  html_url: string;
  commit?: {
    message?: string | null;
    author?: { name?: string | null; email?: string | null; date?: string | null } | null;
  } | null;
  author?: { login?: string | null } | null;
};

type GitHubRelease = {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  author?: { login?: string | null } | null;
  created_at: string;
  published_at?: string | null;
};

type TypesenseCollectionResponse = {
  name?: string;
  num_documents?: number;
};

export const PI_MONO_ARTIFACTS_COLLECTION_SCHEMA = {
  name: PI_MONO_ARTIFACTS_COLLECTION,
  fields: [
    { name: "id", type: "string" as const },
    { name: "repo", type: "string" as const, facet: true },
    { name: "kind", type: "string" as const, facet: true },
    { name: "title", type: "string" as const, optional: true },
    { name: "content", type: "string" as const },
    { name: "url", type: "string" as const },
    { name: "number", type: "int32" as const, optional: true, facet: true },
    { name: "state", type: "string" as const, optional: true, facet: true },
    { name: "author", type: "string" as const, facet: true },
    { name: "author_role", type: "string" as const, optional: true, facet: true },
    { name: "maintainer_signal", type: "bool" as const, optional: true, facet: true },
    { name: "package_scopes", type: "string[]" as const, optional: true, facet: true },
    { name: "labels", type: "string[]" as const, optional: true, facet: true },
    { name: "decision_tags", type: "string[]" as const, optional: true, facet: true },
    { name: "path", type: "string" as const, optional: true, facet: true },
    { name: "sha", type: "string" as const, optional: true },
    { name: "tag", type: "string" as const, optional: true, facet: true },
    { name: "thread_key", type: "string" as const, optional: true, facet: true },
    { name: "created_at", type: "int64" as const },
    { name: "updated_at", type: "int64" as const, optional: true },
    {
      name: "embedding",
      type: "float[]" as const,
      embed: {
        from: ["title", "content"],
        model_config: MINI_LM_MODEL_CONFIG,
      },
    },
  ],
  default_sorting_field: "created_at",
} satisfies Record<string, unknown>;

const DOC_PATHS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/contribution.yml",
  ".github/workflows/pr-gate.yml",
  ".github/workflows/approve-contributor.yml",
  ".github/APPROVED_CONTRIBUTORS",
  "packages/ai/README.md",
  "packages/agent/README.md",
  "packages/coding-agent/README.md",
  "packages/coding-agent/docs/skills.md",
  "packages/tui/README.md",
  "packages/web-ui/README.md",
  "packages/mom/README.md",
  "packages/pods/README.md",
];

const REVIEW_TAG_PATTERNS: Array<{ tag: string; test: (text: string) => boolean }> = [
  { tag: "needs_repro", test: (text) => /repro|reproduce|how this can ever happen/.test(text) },
  { tag: "wrong_layer", test: (text) => /higher layer|wrong layer|provider implementations is broken/.test(text) },
  { tag: "extension_not_core", test: (text) => /extension|wrapper script|outside core|doesn'?t belong here/.test(text) },
  { tag: "tui_breakage", test: (text) => /breaks tui|break the tui|console\.log|console\.warn|stderr/.test(text) },
  { tag: "provider_boundary", test: (text) => /provider|model triggered|types clearly dictate/.test(text) },
  { tag: "unnecessary_config", test: (text) => /don't need a setting|no setting|too many options|nested property/.test(text) },
  { tag: "rewrite_needed", test: (text) => /implemented a cleaner version|rewrote|implementation is wrong|entirely unnecessary/.test(text) },
  { tag: "approved_with_direction", test: (text) => /lgtm|please send a pr|please use /.test(text) },
  { tag: "fixed_in_main", test: (text) => /fixed in|implemented on `main`|merged into main|closing this\./.test(text) },
  { tag: "upstream_dependency_wait", test: (text) => /wait for upstream|upstream fixes/.test(text) },
  { tag: "duplicate_or_confused_issue", test: (text) => /why would you open two issues/.test(text) },
  { tag: "core_minimal", test: (text) => /doesn'?t belong here|no need to complicate|no need to/.test(text) },
];

function runCommand(command: string, args: string[]): string {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim();
}

function resolveTypesenseApiKey(): string {
  const fromEnv = process.env.TYPESENSE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return runCommand("secrets", ["lease", "typesense_api_key", "--ttl", "15m"]);
}

function resolveGitHubToken(): string | null {
  const envKeys = [
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
    process.env.COPILOT_GITHUB_TOKEN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (envKeys.length > 0) return envKeys[0] ?? null;

  try {
    return runCommand("gh", ["auth", "token"]);
  } catch {
    return null;
  }
}

function typesenseHeaders() {
  return {
    "X-TYPESENSE-API-KEY": resolveTypesenseApiKey(),
    "Content-Type": "application/json",
  };
}

async function typesenseRequest(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${pathname}`, {
    ...(init ?? {}),
    headers: {
      ...typesenseHeaders(),
      ...(init?.headers ?? {}),
    },
  });
}

async function ensureCollection(name: string, schema: Record<string, unknown>): Promise<void> {
  const existing = await typesenseRequest(`/collections/${name}`, { method: "GET" });
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(`Typesense collection check failed (${existing.status}): ${await existing.text()}`);
  }

  const created = await typesenseRequest("/collections", {
    method: "POST",
    body: JSON.stringify(schema),
  });

  if (!created.ok) {
    const text = await created.text();
    if (created.status === 409 || text.toLowerCase().includes("already exists")) return;
    throw new Error(`Typesense collection create failed (${created.status}): ${text}`);
  }
}

async function bulkUpsert(docs: PiMonoArtifactDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const body = docs.map((doc) => JSON.stringify(doc)).join("\n");
  const response = await typesenseRequest(
    `/collections/${PI_MONO_ARTIFACTS_COLLECTION}/documents/import?action=upsert`,
    {
      method: "POST",
      body,
    },
  );

  if (!response.ok) {
    throw new Error(`Typesense bulk import failed (${response.status}): ${await response.text()}`);
  }
}

async function getCollectionInfo(): Promise<TypesenseCollectionResponse | null> {
  const response = await typesenseRequest(`/collections/${PI_MONO_ARTIFACTS_COLLECTION}`, { method: "GET" });
  if (!response.ok) return null;
  return (await response.json()) as TypesenseCollectionResponse;
}

async function getCheckpoint(repo: string): Promise<PiMonoArtifactDoc | null> {
  const checkpointId = checkpointDocumentId(repo);
  const response = await typesenseRequest(
    `/collections/${PI_MONO_ARTIFACTS_COLLECTION}/documents/${encodeURIComponent(checkpointId)}`,
    { method: "GET" },
  );

  if (!response.ok) return null;
  return (await response.json()) as PiMonoArtifactDoc;
}

async function loadMaintainerEvidence(repo: string, maintainer: string): Promise<PiMonoArtifactDoc[]> {
  const params = new URLSearchParams({
    q: maintainer,
    query_by: "author,title,content",
    per_page: "250",
    filter_by: `repo:=${repo} && maintainer_signal:=true && kind:!=${PROFILE_KIND} && kind:!=${CHECKPOINT_KIND}`,
    sort_by: "updated_at:desc",
    exclude_fields: "embedding",
  });

  const response = await typesenseRequest(
    `/collections/${PI_MONO_ARTIFACTS_COLLECTION}/documents/search?${params.toString()}`,
    { method: "GET" },
  );

  if (!response.ok) return [];
  const payload = (await response.json()) as { hits?: Array<{ document?: PiMonoArtifactDoc }> };
  return (payload.hits ?? [])
    .map((hit) => hit.document)
    .filter((doc): doc is PiMonoArtifactDoc => Boolean(doc));
}

function githubHeaders(token: string | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "joelclaw-pi-mono-artifacts-sync",
  };
}

async function githubJson<T>(repo: string, pathname: string): Promise<T> {
  const token = resolveGitHubToken();
  const response = await fetch(`${GITHUB_API_URL}/repos/${repo}${pathname}`, {
    headers: githubHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed (${response.status}) for ${pathname}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

function isoToMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function truncateText(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_CONTENT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated at ${MAX_CONTENT_CHARS} chars]`;
}

function repoDocId(repo: string, docPath: string): string {
  return `${repo}:repo_doc:${docPath}`;
}

function checkpointDocumentId(repo: string): string {
  return `${repo}:${CHECKPOINT_KIND}`;
}

function maintainerProfileDocumentId(repo: string, maintainer: string): string {
  return `${repo}:${PROFILE_KIND}:${maintainer}`;
}

function isMaintainer(author: string | null | undefined): boolean {
  return !!author && ["badlogic", "Mario Zechner"].includes(author);
}

function extractLabels(labels: Array<{ name?: string | null }> | undefined): string[] {
  return (labels ?? [])
    .map((label) => label.name?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractPackageScopes(input: {
  title?: string | null;
  path?: string | null;
  labels?: string[];
}): string[] {
  const scopes = new Set<string>();
  for (const label of input.labels ?? []) {
    if (label.startsWith("pkg:")) scopes.add(label.replace(/^pkg:/, ""));
  }

  const title = input.title ?? "";
  const scopeMatch = title.match(/^[a-z]+\(([^)]+)\):/i);
  if (scopeMatch?.[1]) scopes.add(scopeMatch[1]);

  const pathValue = input.path ?? "";
  const packageMatch = pathValue.match(/^packages\/([^/]+)/);
  if (packageMatch?.[1]) scopes.add(packageMatch[1]);
  if (pathValue.includes("packages/coding-agent")) scopes.add("coding-agent");
  if (pathValue.includes("packages/agent")) scopes.add("agent");
  if (pathValue.includes("packages/ai")) scopes.add("ai");
  if (pathValue.includes("packages/tui")) scopes.add("tui");
  if (pathValue.includes("packages/web-ui")) scopes.add("web-ui");
  if (pathValue.includes("packages/mom")) scopes.add("mom");
  if (pathValue.includes("packages/pods")) scopes.add("pods");

  return [...scopes].sort();
}

function inferDecisionTags(text: string): string[] {
  const haystack = text.toLowerCase();
  return REVIEW_TAG_PATTERNS.filter((pattern) => pattern.test(haystack)).map((pattern) => pattern.tag);
}

function issueThreadKey(number: number): string {
  return `issue:${number}`;
}

function prThreadKey(number: number): string {
  return `pr:${number}`;
}

function issueNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function prNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pulls?\/(\d+)/);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeRepoDoc(repo: string, localClonePath: string, docPath: string): PiMonoArtifactDoc | null {
  const absolutePath = path.join(localClonePath, docPath);
  if (!existsSync(absolutePath)) return null;

  const content = truncateText(readFileSync(absolutePath, "utf8"));
  const title = `${docPath} (${repo})`;
  return {
    id: repoDocId(repo, docPath),
    repo,
    kind: "repo_doc",
    title,
    content,
    url: `https://github.com/${repo}/blob/main/${docPath}`,
    author: "repo",
    maintainer_signal: false,
    package_scopes: extractPackageScopes({ title, path: docPath, labels: [] }),
    decision_tags: inferDecisionTags(`${title}\n${content}`),
    path: docPath,
    thread_key: `repo_doc:${docPath}`,
    created_at: Date.now(),
    updated_at: existsSync(absolutePath) ? Date.now() : undefined,
  };
}

function normalizeIssue(repo: string, issue: GitHubListIssue): PiMonoArtifactDoc | null {
  if (issue.pull_request) return null;
  const labels = extractLabels(issue.labels);
  const content = truncateText(issue.body);
  return {
    id: `${repo}:issue:${issue.number}`,
    repo,
    kind: "issue",
    title: issue.title,
    content,
    url: issue.html_url,
    number: issue.number,
    state: issue.state,
    author: issue.user?.login?.trim() || "unknown",
    author_role: issue.author_association,
    maintainer_signal: isMaintainer(issue.user?.login ?? null),
    package_scopes: extractPackageScopes({ title: issue.title, labels }),
    labels,
    decision_tags: inferDecisionTags(`${issue.title}\n${content}`),
    thread_key: issueThreadKey(issue.number),
    created_at: isoToMs(issue.created_at) ?? Date.now(),
    updated_at: isoToMs(issue.updated_at),
  };
}

function normalizeIssueComment(repo: string, comment: GitHubIssueComment): PiMonoArtifactDoc {
  const issueNumber = issueNumberFromUrl(comment.issue_url);
  const content = truncateText(comment.body);
  const author = comment.user?.login?.trim() || "unknown";
  return {
    id: `${repo}:issue_comment:${comment.id}`,
    repo,
    kind: "issue_comment",
    title: issueNumber ? `Issue #${issueNumber} comment by ${author}` : `Issue comment by ${author}`,
    content,
    url: comment.html_url,
    number: issueNumber,
    author,
    author_role: comment.author_association,
    maintainer_signal: isMaintainer(author),
    package_scopes: [],
    decision_tags: inferDecisionTags(content),
    thread_key: issueNumber ? issueThreadKey(issueNumber) : undefined,
    created_at: isoToMs(comment.created_at) ?? Date.now(),
    updated_at: isoToMs(comment.updated_at),
  };
}

function normalizePullRequest(repo: string, pr: GitHubPullRequest): PiMonoArtifactDoc {
  const labels = extractLabels(pr.labels);
  const content = truncateText(pr.body);
  const author = pr.user?.login?.trim() || "unknown";
  return {
    id: `${repo}:pull_request:${pr.number}`,
    repo,
    kind: "pull_request",
    title: pr.title,
    content,
    url: pr.html_url,
    number: pr.number,
    state: pr.state,
    author,
    author_role: pr.author_association,
    maintainer_signal: isMaintainer(author),
    package_scopes: extractPackageScopes({ title: pr.title, labels }),
    labels,
    decision_tags: inferDecisionTags(`${pr.title}\n${content}`),
    thread_key: prThreadKey(pr.number),
    created_at: isoToMs(pr.created_at) ?? Date.now(),
    updated_at: isoToMs(pr.updated_at),
  };
}

function normalizePullReviewComment(repo: string, comment: GitHubPullReviewComment): PiMonoArtifactDoc {
  const prNumber = prNumberFromUrl(comment.pull_request_url);
  const content = truncateText(comment.body);
  const author = comment.user?.login?.trim() || "unknown";
  const packageScopes = extractPackageScopes({ path: comment.path, labels: [] });
  return {
    id: `${repo}:pull_request_review_comment:${comment.id}`,
    repo,
    kind: "pull_request_review_comment",
    title: prNumber
      ? `PR #${prNumber} review comment by ${author}`
      : `PR review comment by ${author}`,
    content,
    url: comment.html_url,
    number: prNumber,
    author,
    author_role: comment.author_association,
    maintainer_signal: isMaintainer(author),
    package_scopes: packageScopes,
    decision_tags: inferDecisionTags(`${content}\n${comment.path ?? ""}`),
    path: comment.path ?? undefined,
    thread_key: prNumber ? prThreadKey(prNumber) : undefined,
    created_at: isoToMs(comment.created_at) ?? Date.now(),
    updated_at: isoToMs(comment.updated_at),
  };
}

function normalizeCommit(repo: string, commit: GitHubCommit): PiMonoArtifactDoc {
  const author = commit.author?.login?.trim() || commit.commit?.author?.name?.trim() || "unknown";
  const message = truncateText(commit.commit?.message);
  return {
    id: `${repo}:commit:${commit.sha}`,
    repo,
    kind: "commit",
    title: (commit.commit?.message ?? "").split("\n")[0] || commit.sha,
    content: message,
    url: commit.html_url,
    author,
    maintainer_signal: isMaintainer(author),
    package_scopes: extractPackageScopes({
      title: (commit.commit?.message ?? "").split("\n")[0],
      labels: [],
    }),
    decision_tags: inferDecisionTags(message),
    sha: commit.sha,
    thread_key: `commit:${commit.sha}`,
    created_at: isoToMs(commit.commit?.author?.date ?? undefined) ?? Date.now(),
    updated_at: isoToMs(commit.commit?.author?.date ?? undefined),
  };
}

function normalizeRelease(repo: string, release: GitHubRelease): PiMonoArtifactDoc {
  const content = truncateText(release.body);
  const author = release.author?.login?.trim() || "unknown";
  return {
    id: `${repo}:release:${release.tag_name}`,
    repo,
    kind: "release",
    title: release.name?.trim() || release.tag_name,
    content,
    url: release.html_url,
    state: release.draft ? "draft" : release.prerelease ? "prerelease" : "released",
    author,
    maintainer_signal: isMaintainer(author),
    package_scopes: [],
    decision_tags: inferDecisionTags(`${release.name ?? release.tag_name}\n${content}`),
    tag: release.tag_name,
    thread_key: `release:${release.tag_name}`,
    created_at: isoToMs(release.created_at) ?? Date.now(),
    updated_at: isoToMs(release.published_at ?? release.created_at),
  };
}

function buildMaintainerProfileDoc(
  repo: string,
  maintainer: string,
  docs: PiMonoArtifactDoc[],
): PiMonoArtifactDoc {
  const maintainerDocs = docs.filter((doc) => doc.author === maintainer || doc.maintainer_signal === true);
  const decisionCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const sampleQuotes: string[] = [];

  for (const doc of maintainerDocs) {
    for (const tag of doc.decision_tags ?? []) {
      decisionCounts.set(tag, (decisionCounts.get(tag) ?? 0) + 1);
    }
    for (const scope of doc.package_scopes ?? []) {
      scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
    }
    if (sampleQuotes.length < 8 && doc.content.trim()) {
      sampleQuotes.push(doc.content.split("\n")[0] ?? doc.content.slice(0, 160));
    }
  }

  const topDecisionTags = [...decisionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => `- ${tag}: ${count}`)
    .join("\n");

  const topScopes = [...scopeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([scope, count]) => `- ${scope}: ${count}`)
    .join("\n");

  const content = [
    `# Maintainer profile: ${maintainer}`,
    "",
    `Repo: ${repo}`,
    `Artifacts considered: ${maintainerDocs.length}`,
    "",
    "## Working style",
    "- terse, direct, low-ceremony",
    "- core-minimal / extension-first",
    "- TUI integrity is sacred",
    "- asks for concrete repros when invariants are supposedly impossible",
    "- pushes back on unnecessary settings and abstraction drift",
    "",
    "## Top decision tags",
    topDecisionTags || "- none yet",
    "",
    "## Top package scopes",
    topScopes || "- none yet",
    "",
    "## Sample quotes",
    ...(sampleQuotes.length > 0 ? sampleQuotes.map((quote) => `- ${quote}`) : ["- none yet"]),
  ].join("\n");

  return {
    id: maintainerProfileDocumentId(repo, maintainer),
    repo,
    kind: PROFILE_KIND,
    title: `Maintainer profile: ${maintainer}`,
    content,
    url: `https://github.com/${repo}`,
    author: maintainer,
    maintainer_signal: true,
    decision_tags: ["maintainer_profile"],
    thread_key: `maintainer_profile:${maintainer}`,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function buildCheckpointDoc(repo: string, summary: PiMonoSyncSummary): PiMonoArtifactDoc {
  return {
    id: checkpointDocumentId(repo),
    repo,
    kind: CHECKPOINT_KIND,
    title: `Sync checkpoint for ${repo}`,
    content: truncateText(JSON.stringify(summary, null, 2)),
    url: `https://github.com/${repo}`,
    author: "joelclaw",
    decision_tags: ["sync_checkpoint"],
    thread_key: `sync_state:${repo}`,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function resolveLocalClonePath(repo: string, localClonePath?: string): string {
  if (localClonePath?.trim()) return localClonePath;
  const [owner, name] = repo.split("/");
  return path.join(process.env.HOME ?? "/Users/joel", "Code", owner ?? "", name ?? "");
}

export async function syncPiMonoArtifacts(options: PiMonoSyncOptions = {}): Promise<PiMonoSyncSummary> {
  const repo = options.repo?.trim() || DEFAULT_REPO;
  const localClonePath = resolveLocalClonePath(repo, options.localClonePath);
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const perPage = Math.max(1, Math.min(100, options.perPage ?? DEFAULT_PER_PAGE));
  const materializeProfile = options.materializeProfile !== false;
  const startedAt = new Date().toISOString();

  await ensureCollection(PI_MONO_ARTIFACTS_COLLECTION, PI_MONO_ARTIFACTS_COLLECTION_SCHEMA);
  const collectionInfo = await getCollectionInfo();
  const checkpoint = options.fullBackfill ? null : await getCheckpoint(repo);
  const checkpointIso = checkpoint?.updated_at ? new Date(checkpoint.updated_at).toISOString() : null;
  const mode: "full" | "incremental" = options.fullBackfill || !checkpointIso || (collectionInfo?.num_documents ?? 0) === 0 ? "full" : "incremental";

  const summary: PiMonoSyncSummary = {
    repo,
    collection: PI_MONO_ARTIFACTS_COLLECTION,
    mode,
    checkpointUsed: mode === "incremental",
    checkpointIso,
    localClonePath,
    startedAt,
    completedAt: startedAt,
    imported: 0,
    byKind: {},
    pagesFetched: {
      repoDocs: 0,
      issues: 0,
      issueComments: 0,
      pullRequests: 0,
      pullRequestReviewComments: 0,
      commits: 0,
      releases: 0,
    },
    profileDocumentId: null,
    checkpointDocumentId: checkpointDocumentId(repo),
  };

  const importedForProfile: PiMonoArtifactDoc[] = [];

  const pushBatch = async (docs: Array<PiMonoArtifactDoc | null>) => {
    const batch = docs.filter((doc): doc is PiMonoArtifactDoc => Boolean(doc));
    if (batch.length === 0) return;
    await bulkUpsert(batch);
    importedForProfile.push(...batch);
    summary.imported += batch.length;
    for (const doc of batch) {
      summary.byKind[doc.kind] = (summary.byKind[doc.kind] ?? 0) + 1;
    }
  };

  const repoDocs = DOC_PATHS.map((docPath) => normalizeRepoDoc(repo, localClonePath, docPath));
  await pushBatch(repoDocs);
  summary.pagesFetched.repoDocs = 1;

  for (let page = 1; page <= maxPages; page += 1) {
    const sinceParam = mode === "incremental" && checkpointIso ? `&since=${encodeURIComponent(checkpointIso)}` : "";
    const issues = await githubJson<GitHubListIssue[]>(repo, `/issues?state=all&per_page=${perPage}&page=${page}${sinceParam}`);
    const filtered = issues.filter((issue) => !issue.pull_request);
    if (issues.length === 0) break;
    summary.pagesFetched.issues += 1;
    await pushBatch(filtered.map((issue) => normalizeIssue(repo, issue)));
    if (issues.length < perPage) break;
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const sinceParam = mode === "incremental" && checkpointIso ? `&since=${encodeURIComponent(checkpointIso)}` : "";
    const comments = await githubJson<GitHubIssueComment[]>(repo, `/issues/comments?per_page=${perPage}&page=${page}&sort=updated&direction=desc${sinceParam}`);
    if (comments.length === 0) break;
    summary.pagesFetched.issueComments += 1;
    await pushBatch(comments.map((comment) => normalizeIssueComment(repo, comment)));
    if (comments.length < perPage) break;
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const pulls = await githubJson<GitHubPullRequest[]>(repo, `/pulls?state=all&per_page=${perPage}&page=${page}&sort=updated&direction=desc`);
    if (pulls.length === 0) break;
    summary.pagesFetched.pullRequests += 1;
    const docs = pulls
      .filter((pull) => mode === "full" || !checkpoint?.updated_at || (isoToMs(pull.updated_at) ?? Number.MAX_SAFE_INTEGER) > checkpoint.updated_at)
      .map((pull) => normalizePullRequest(repo, pull));
    await pushBatch(docs);
    if (pulls.length < perPage || (mode === "incremental" && pulls.every((pull) => (isoToMs(pull.updated_at) ?? 0) <= (checkpoint?.updated_at ?? 0)))) {
      break;
    }
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const reviewComments = await githubJson<GitHubPullReviewComment[]>(repo, `/pulls/comments?per_page=${perPage}&page=${page}&sort=updated&direction=desc`);
    if (reviewComments.length === 0) break;
    summary.pagesFetched.pullRequestReviewComments += 1;
    const docs = reviewComments
      .filter((comment) => mode === "full" || !checkpoint?.updated_at || (isoToMs(comment.updated_at) ?? Number.MAX_SAFE_INTEGER) > checkpoint.updated_at)
      .map((comment) => normalizePullReviewComment(repo, comment));
    await pushBatch(docs);
    if (reviewComments.length < perPage || (mode === "incremental" && reviewComments.every((comment) => (isoToMs(comment.updated_at) ?? 0) <= (checkpoint?.updated_at ?? 0)))) {
      break;
    }
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const sinceParam = mode === "incremental" && checkpointIso ? `&since=${encodeURIComponent(checkpointIso)}` : "";
    const commits = await githubJson<GitHubCommit[]>(repo, `/commits?per_page=${perPage}&page=${page}${sinceParam}`);
    if (commits.length === 0) break;
    summary.pagesFetched.commits += 1;
    await pushBatch(commits.map((commit) => normalizeCommit(repo, commit)));
    if (commits.length < perPage) break;
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const releases = await githubJson<GitHubRelease[]>(repo, `/releases?per_page=${perPage}&page=${page}`);
    if (releases.length === 0) break;
    summary.pagesFetched.releases += 1;
    const docs = releases
      .filter((release) => mode === "full" || !checkpoint?.updated_at || (isoToMs(release.published_at ?? release.created_at) ?? Number.MAX_SAFE_INTEGER) > checkpoint.updated_at)
      .map((release) => normalizeRelease(repo, release));
    await pushBatch(docs);
    if (releases.length < perPage || (mode === "incremental" && releases.every((release) => (isoToMs(release.published_at ?? release.created_at) ?? 0) <= (checkpoint?.updated_at ?? 0)))) {
      break;
    }
  }

  if (materializeProfile) {
    const corpusEvidence = mode === "full" ? importedForProfile : await loadMaintainerEvidence(repo, "badlogic");
    const evidenceById = new Map<string, PiMonoArtifactDoc>();
    for (const doc of [...corpusEvidence, ...importedForProfile]) {
      evidenceById.set(doc.id, doc);
    }
    const profileDoc = buildMaintainerProfileDoc(repo, "badlogic", [...evidenceById.values()]);
    await pushBatch([profileDoc]);
    summary.profileDocumentId = profileDoc.id;
  }

  summary.completedAt = new Date().toISOString();
  const checkpointDoc = buildCheckpointDoc(repo, summary);
  await pushBatch([checkpointDoc]);

  return summary;
}

export const __piMonoArtifactsTestUtils = {
  extractPackageScopes,
  inferDecisionTags,
  buildMaintainerProfileDoc,
};
