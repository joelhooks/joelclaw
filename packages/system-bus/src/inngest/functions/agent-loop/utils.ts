import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Redis from "ioredis";

const LOOP_TMP = "/tmp/agent-loop";

/**
 * Verify Claude CLI auth token is available before spawning.
 * Fails fast with a clear error instead of getting a cryptic "Not logged in"
 * three steps into a loop run.
 */
export function ensureClaudeAuth(): void {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN not set. Claude CLI will fail with 'Not logged in'. " +
      "Fix: run 'claude setup-token', store with 'secrets add claude_oauth_token --value <token>', " +
      "and ensure start.sh leases it at worker startup."
    );
  }
}

export function formatLoopDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  if (ms < 1000) {
    const seconds = (ms / 1000).toFixed(3).replace(/\.?0+$/, "");
    return `${seconds}s`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ── Claude output parsing ────────────────────────────────────────────

/**
 * Parse JSON from claude CLI output.
 * Handles --output-format json (envelope with {result: string})
 * and --output-format text (raw markdown/text).
 */
export function parseClaudeOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const envelope = JSON.parse(trimmed);
    if (typeof envelope.result === "string") {
      return extractJson(envelope.result);
    }
    return envelope;
  } catch {
    return extractJson(trimmed);
  }
}

function extractJson(content: string): unknown {
  try { return JSON.parse(content.trim()); } catch {}

  const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(content.slice(start, end + 1)); } catch {}
  }

  return null;
}

// ── Redis client (singleton) ─────────────────────────────────────────

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
    });
  }
  return _redis;
}

function prdKey(loopId: string): string {
  return `agent-loop:prd:${loopId}`;
}

function claimKey(loopId: string, storyId: string): string {
  return `agent-loop:claim:${loopId}:${storyId}`;
}

function progressKey(loopId: string): string {
  return `agent-loop:progress:${loopId}`;
}

function recommendationsKey(project: string): string {
  return `agent-loop:recommendations:${project}`;
}

function patternsKey(project: string): string {
  return `agent-loop:patterns:${project}`;
}

function lessonsKey(project: string): string {
  return `agent-loop:lessons:${project}`;
}

const CLAIM_LEASE_SECONDS = 1800;

export async function claimStory(
  loopId: string,
  storyId: string,
  runToken: string
): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.set(
    claimKey(loopId, storyId),
    runToken,
    "EX",
    CLAIM_LEASE_SECONDS,
    "NX"
  );
  return result === "OK" ? runToken : null;
}

export async function guardStory(
  loopId: string,
  storyId: string,
  runToken: string
): Promise<
  | { ok: true }
  | { ok: false; reason: "already_claimed" | "already_passed" | "lease_expired" }
> {
  const redis = getRedis();
  const claim = await redis.get(claimKey(loopId, storyId));
  if (!claim) return { ok: false, reason: "lease_expired" };
  if (claim !== runToken) return { ok: false, reason: "already_claimed" };

  const prdData = await redis.get(prdKey(loopId));
  if (prdData) {
    type GuardStoryPrd = {
      stories?: Array<{
        id?: string;
        status?: string;
        passes?: boolean;
        skipped?: boolean;
      }>;
    };

    const prd = JSON.parse(prdData) as GuardStoryPrd;
    const story = prd.stories?.find((s) => s.id === storyId);
    if (
      story?.status === "passed" ||
      story?.status === "skipped" ||
      story?.passes === true ||
      story?.skipped === true
    ) {
      return { ok: false, reason: "already_passed" };
    }
  }

  return { ok: true };
}

export async function renewLease(
  loopId: string,
  storyId: string,
  runToken: string
): Promise<boolean> {
  const redis = getRedis();
  const key = claimKey(loopId, storyId);
  const claim = await redis.get(key);
  if (!claim || claim !== runToken) return false;
  await redis.expire(key, CLAIM_LEASE_SECONDS);
  return true;
}

export async function releaseClaim(
  loopId: string,
  storyId: string
): Promise<void> {
  const redis = getRedis();
  await redis.del(claimKey(loopId, storyId));
}

// ── Directory helpers ────────────────────────────────────────────────

export function loopDir(loopId: string): string {
  const dir = join(LOOP_TMP, loopId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Cancellation ─────────────────────────────────────────────────────

export function cancelPath(loopId: string): string {
  return join(loopDir(loopId), "cancelled");
}

export function isCancelled(loopId: string): boolean {
  return existsSync(cancelPath(loopId));
}

export async function writeCancelFlag(loopId: string, reason: string) {
  await Bun.write(cancelPath(loopId), reason);
}

// ── PID management ───────────────────────────────────────────────────

export function pidPath(loopId: string): string {
  return join(loopDir(loopId), "pid");
}

export async function writePidFile(loopId: string, pid: number) {
  await Bun.write(pidPath(loopId), String(pid));
}

export async function cleanupPid(loopId: string) {
  const p = pidPath(loopId);
  if (existsSync(p)) {
    try {
      await Bun.file(p).text(); // ensure it exists
      await $`rm -f ${p}`.quiet();
    } catch { /* ignore */ }
  }
}

export async function killSubprocess(loopId: string): Promise<boolean> {
  const p = pidPath(loopId);
  if (!existsSync(p)) return false;
  try {
    const pid = parseInt(await Bun.file(p).text(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, "SIGTERM");
    // Wait up to 10s for graceful exit
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(500);
      try {
        process.kill(pid, 0); // check if alive
      } catch {
        await cleanupPid(loopId);
        return true; // process exited
      }
    }
    // Force kill
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* already dead */ }
    await cleanupPid(loopId);
    return true;
  } catch {
    return false;
  }
}

// ── Tool output parsing ──────────────────────────────────────────────

export interface ToolOutput {
  success: boolean;
  output: string;
  tokensUsed?: number;
}

export async function parseToolOutput(
  tool: string,
  outputPath: string
): Promise<ToolOutput> {
  if (!existsSync(outputPath)) {
    return { success: false, output: "No output file found" };
  }
  const raw = await Bun.file(outputPath).text();

  if (tool === "claude") {
    // Claude stream-json may include cost/token info
    try {
      const lines = raw.trim().split("\n");
      const lastLine = lines[lines.length - 1] ?? "";
      const parsed = JSON.parse(lastLine);
      if (parsed.result) {
        return {
          success: true,
          output: typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result),
          tokensUsed: parsed.usage?.total_tokens,
        };
      }
    } catch { /* not JSON, treat as plain text */ }
  }

  // Default: treat as plain text, success if non-empty
  const trimmed = raw.trim();
  return {
    success: trimmed.length > 0,
    output: trimmed.slice(0, 50_000), // cap at 50k chars
  };
}

// ── Claim-check pattern ──────────────────────────────────────────────

export async function claimCheckWrite(
  loopId: string,
  name: string,
  data: unknown
): Promise<string> {
  const path = join(loopDir(loopId), `${name}.json`);
  await Bun.write(path, JSON.stringify(data, null, 2));
  return path;
}

export async function claimCheckRead<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

// ── Output file path ─────────────────────────────────────────────────

export function outputPath(
  loopId: string,
  storyId: string,
  attempt: number
): string {
  return join(loopDir(loopId), `${storyId}-${attempt}.out`);
}

// ── PRD helpers ──────────────────────────────────────────────────────

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  priority: number;
  passes: boolean;
  tool?: string;
}

export interface Prd {
  title: string;
  description?: string;
  adr?: string;
  stories: Story[];
}

// ── PRD storage (Redis-backed, seeded from disk) ─────────────────────

/**
 * Seed PRD into Redis from disk file. Called once by PLANNER on loop start.
 * Returns the PRD. Subsequent reads use readPrd() which hits Redis.
 */
export async function seedPrd(
  loopId: string,
  project: string,
  prdPath: string
): Promise<Prd> {
  const fullPath = join(project, prdPath);
  const prd = JSON.parse(await Bun.file(fullPath).text()) as Prd;
  const redis = getRedis();
  const key = prdKey(loopId);
  const value = JSON.stringify(prd);
  const ttlSeconds = 7 * 24 * 60 * 60;

  // First writer wins: avoid clobbering loop state when duplicate start events arrive.
  const setResult = await redis.set(key, value, "EX", ttlSeconds, "NX");
  if (setResult === null) {
    const existing = await redis.get(key);
    if (existing) {
      return JSON.parse(existing) as Prd;
    }
  }

  return prd;
}

/**
 * Seed PRD into Redis from in-memory data (no disk file).
 * Used when planner generates PRD from goal (ADR-0012).
 */
export async function seedPrdFromData(
  loopId: string,
  prd: Prd
): Promise<Prd> {
  const redis = getRedis();
  await redis.set(prdKey(loopId), JSON.stringify(prd));
  await redis.expire(prdKey(loopId), 7 * 24 * 60 * 60);
  return prd;
}

/**
 * Read PRD from Redis. Falls back to disk if not seeded yet (backward compat).
 * loopId is extracted from the function context — callers pass it through.
 */
export async function readPrd(
  project: string,
  prdPath: string,
  loopId?: string
): Promise<Prd> {
  if (loopId) {
    const redis = getRedis();
    const data = await redis.get(prdKey(loopId));
    if (data) {
      return JSON.parse(data) as Prd;
    }
  }
  // Fallback: read from disk (backward compat for loops started before Redis migration)
  const fullPath = join(project, prdPath);
  return JSON.parse(await Bun.file(fullPath).text()) as Prd;
}

/**
 * Write PRD state back to Redis (and optionally to disk for human review).
 */
async function writePrd(
  loopId: string,
  prd: Prd,
  project?: string,
  prdPath?: string
) {
  const redis = getRedis();
  await redis.set(prdKey(loopId), JSON.stringify(prd));
  // Also write to disk if project path is available (for human review)
  if (project && prdPath) {
    try {
      const fullPath = join(project, prdPath);
      await Bun.write(fullPath, JSON.stringify(prd, null, 2) + "\n");
    } catch { /* disk write is best-effort in Docker */ }
  }
}

export async function updateStoryPass(
  project: string,
  prdPath: string,
  storyId: string,
  loopId?: string
) {
  const prd = await readPrd(project, prdPath, loopId);
  const story = prd.stories.find((s) => s.id === storyId);
  if (story) story.passes = true;
  if (loopId) {
    await writePrd(loopId, prd, project, prdPath);
  } else {
    // Legacy: disk-only
    const fullPath = join(project, prdPath);
    await Bun.write(fullPath, JSON.stringify(prd, null, 2) + "\n");
  }
}

export async function markStorySkipped(
  project: string,
  prdPath: string,
  storyId: string,
  loopId?: string
) {
  const prd = await readPrd(project, prdPath, loopId);
  const story = prd.stories.find((s) => s.id === storyId) as any;
  if (story) story.skipped = true;
  if (loopId) {
    await writePrd(loopId, prd, project, prdPath);
  } else {
    const fullPath = join(project, prdPath);
    await Bun.write(fullPath, JSON.stringify(prd, null, 2) + "\n");
  }
}

/**
 * Mark a previously-skipped story as passed after recheck.
 * Sets passes=true, skipped=false.
 */
export async function markStoryRechecked(
  project: string,
  prdPath: string,
  storyId: string,
  loopId?: string
) {
  const prd = await readPrd(project, prdPath, loopId);
  const story = prd.stories.find((s) => s.id === storyId) as any;
  if (story) {
    story.passes = true;
    story.skipped = false;
  }
  if (loopId) {
    await writePrd(loopId, prd, project, prdPath);
  } else {
    const fullPath = join(project, prdPath);
    await Bun.write(fullPath, JSON.stringify(prd, null, 2) + "\n");
  }
}

// ── Progress + loop context (Redis-backed) ──────────────────────────

export async function appendProgress(
  loopId: string,
  entry: string
): Promise<void> {
  const redis = getRedis();
  const timestamp = new Date().toISOString();
  const newEntry = `### ${timestamp}\n${entry}`;
  await redis.rpush(progressKey(loopId), newEntry);
}

export async function readProgress(loopId: string): Promise<string[]> {
  const redis = getRedis();
  return await redis.lrange(progressKey(loopId), 0, -1);
}

export async function writeRecommendations(
  project: string,
  recommendations: unknown
): Promise<void> {
  const redis = getRedis();
  await redis.set(recommendationsKey(project), JSON.stringify(recommendations));
}

export async function readRecommendations<T = unknown>(
  project: string
): Promise<T | null> {
  const redis = getRedis();
  const raw = await redis.get(recommendationsKey(project));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writePatterns(
  project: string,
  patterns: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(patternsKey(project), patterns);
}

export async function readPatterns(project: string): Promise<string> {
  const redis = getRedis();
  return (await redis.get(patternsKey(project))) ?? "";
}

// ── Lessons learned (cross-loop memory) ─────────────────────────────

export async function appendLessons(
  project: string,
  entry: string
): Promise<void> {
  const redis = getRedis();
  const timestamp = new Date().toISOString();
  await redis.rpush(lessonsKey(project), `[${timestamp}] ${entry}`);
}

export async function readLessons(project: string): Promise<string[]> {
  const redis = getRedis();
  return await redis.lrange(lessonsKey(project), 0, -1);
}

// ── Git helpers ──────────────────────────────────────────────────────

export function commitMessage(
  loopId: string,
  storyId: string,
  attempt: number,
  title: string
): string {
  return `feat: [${loopId}] [${storyId}] attempt-${attempt} — ${title}`;
}

export async function commitExists(
  project: string,
  loopId: string,
  storyId: string,
  attempt: number
): Promise<boolean> {
  try {
    const result =
      await $`cd ${project} && git log --oneline --all --grep="[${loopId}] [${storyId}] attempt-${attempt}"`.quiet();
    return result.text().trim().length > 0;
  } catch {
    return false;
  }
}

export async function gitCommit(
  project: string,
  message: string
): Promise<string> {
  await $`cd ${project} && git add -A`.quiet();
  // Check if there's anything to commit
  try {
    await $`cd ${project} && git diff --cached --quiet`.quiet();
    // No changes — return HEAD sha
    const sha = await $`cd ${project} && git rev-parse HEAD`.quiet();
    return sha.text().trim();
  } catch {
    // There are staged changes — commit them
    await $`cd ${project} && git commit -m ${message}`.quiet();
    const sha = await $`cd ${project} && git rev-parse HEAD`.quiet();
    return sha.text().trim();
  }
}

export async function getStoryDiff(project: string): Promise<string> {
  try {
    // Diff against main to capture both test and implementation commits
    // (TDD flow: test-writer commits tests, then implement commits code)
    const result = await $`git -C ${project} diff main...HEAD`.quiet();
    return result.text();
  } catch {
    try {
      // Fallback: single commit diff
      const result = await $`git -C ${project} diff HEAD~1 HEAD`.quiet();
      return result.text();
    } catch {
      return "";
    }
  }
}

// ── Git status helpers ────────────────────────────────────────────────

/**
 * Check if there are uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(project: string): Promise<boolean> {
  try {
    // Check for unstaged changes
    await $`cd ${project} && git diff --quiet`.quiet();
    // Check for staged changes
    await $`cd ${project} && git diff --cached --quiet`.quiet();
    // Check for untracked files
    const untracked = await $`cd ${project} && git ls-files --others --exclude-standard`.quiet();
    return untracked.text().trim().length > 0;
  } catch {
    // git diff --quiet exits non-zero when there are changes
    return true;
  }
}

/**
 * Get the current HEAD sha.
 */
export async function getHeadSha(project: string): Promise<string> {
  const result = await $`cd ${project} && git rev-parse HEAD`.quiet();
  return result.text().trim();
}

/**
 * Get the sha of the HEAD commit BEFORE tool execution.
 * Used to detect if tool made its own commit.
 */
export async function getHeadBeforeTool(project: string): Promise<string> {
  return getHeadSha(project);
}

// ── Tool timeout map ─────────────────────────────────────────────────

export const TOOL_TIMEOUTS: Record<string, number> = {
  codex: 15 * 60 * 1000,  // 15 min
  claude: 20 * 60 * 1000, // 20 min
  pi: 20 * 60 * 1000,     // 20 min
};

// ── LLM judge helpers ────────────────────────────────────────────────

const LLM_EVAL_FALLBACK = {
  verdict: "pass" as const,
  reasoning: "LLM evaluation unavailable, falling back to test-only gate",
};

const MAX_DIFF_LINES = 3000;
const MAX_CONVENTIONS_CHARS = 2000;

export async function llmEvaluate(opts: {
  criteria: string[];
  diff: string;
  testFile: string;
  testResults: string;
  conventions: string;
}): Promise<{ verdict: "pass" | "fail"; reasoning: string }> {
  const diffLines = opts.diff.split("\n");
  const truncatedDiff =
    diffLines.length > MAX_DIFF_LINES
      ? `${diffLines.slice(0, MAX_DIFF_LINES).join("\n")}\n\n[Diff truncated: showing first ${MAX_DIFF_LINES} of ${diffLines.length} lines]`
      : opts.diff;

  const truncatedConventions =
    opts.conventions.length > MAX_CONVENTIONS_CHARS
      ? `${opts.conventions.slice(0, MAX_CONVENTIONS_CHARS)}\n\n[Conventions truncated at ${MAX_CONVENTIONS_CHARS} characters]`
      : opts.conventions;

  const prompt = [
    "You are an automated code quality judge for ADR-0013.",
    "Evaluate whether the implementation genuinely satisfies the acceptance criteria, not just whether tests passed.",
    "",
    "Return ONLY valid JSON with this exact shape:",
    '{"verdict":"pass"|"fail","reasoning":"<concise explanation>"}',
    "",
    "Evaluation criteria:",
    ...opts.criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Project conventions:",
    truncatedConventions || "(none provided)",
    "",
    "Test file content:",
    opts.testFile || "(empty)",
    "",
    "Test results summary:",
    opts.testResults || "(empty)",
    "",
    "Implementation diff:",
    truncatedDiff || "(empty)",
    "",
    "Rules:",
    "- Verdict must be 'fail' if criteria are not actually met or implementation appears to game tests.",
    "- Verdict can be 'pass' only if implementation aligns with criteria and conventions.",
    "- Keep reasoning specific and actionable.",
  ].join("\n");

  try {
    ensureClaudeAuth();
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--output-format", "json"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const readStdout = async (): Promise<string> => {
      const stdout = proc.stdout as unknown;
      if (!stdout) return "";

      if (typeof stdout === "string") return stdout;

      if (
        typeof stdout === "object" &&
        stdout !== null &&
        "text" in stdout &&
        typeof (stdout as { text?: unknown }).text === "function"
      ) {
        return await (stdout as { text: () => Promise<string> }).text();
      }

      if (
        typeof stdout === "object" &&
        stdout !== null &&
        "arrayBuffer" in stdout &&
        typeof (stdout as { arrayBuffer?: unknown }).arrayBuffer === "function"
      ) {
        const buffer = await (stdout as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
        return new TextDecoder().decode(buffer);
      }

      return await new Response(stdout as BodyInit).text();
    };

    const [exitCode, stdout] = await Promise.all([proc.exited, readStdout()]);

    if (exitCode !== 0) return LLM_EVAL_FALLBACK;

    const parsed = parseClaudeOutput(stdout) as { verdict?: unknown; reasoning?: unknown } | null;
    if (!parsed) return LLM_EVAL_FALLBACK;

    const { verdict, reasoning } = parsed;
    if ((verdict === "pass" || verdict === "fail") && typeof reasoning === "string") {
      return { verdict, reasoning };
    }

    return LLM_EVAL_FALLBACK;
  } catch {
    return LLM_EVAL_FALLBACK;
  }
}

// ── GitHub App token minting ─────────────────────────────────────────

const GITHUB_TOKEN_SCRIPT = `${process.env.HOME}/.pi/agent/skills/github-bot/scripts/github-token.sh`;

export async function mintGitHubToken(): Promise<string> {
  const result = await $`bash ${GITHUB_TOKEN_SCRIPT}`.quiet();
  const token = result.text().trim();
  if (!token || token.length < 10) {
    throw new Error("Failed to mint GitHub App installation token");
  }
  return token;
}

// ── Docker container runner ──────────────────────────────────────────

export interface ContainerResult {
  exitCode: number;
  output: string;
}

/**
 * Check if Docker is available.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await $`docker info`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a tool inside a Docker container using the agent-loop-runner image.
 *
 * - Mints a GitHub App installation token
 * - Starts a container that clones the repo, checks out the branch
 * - Runs the tool with the given prompt
 * - Captures stdout and returns exit code + output
 */
export async function spawnInContainer(
  tool: "codex" | "claude" | "pi",
  prompt: string,
  repoUrl: string,
  branch: string,
  loopId: string,
  storyId: string
): Promise<ContainerResult> {
  const token = await mintGitHubToken();
  const containerName = `agent-loop-${loopId}-${storyId}-${Date.now()}`;
  const timeout = TOOL_TIMEOUTS[tool] ?? 15 * 60 * 1000;

  // Build the tool command to run inside the container
  let toolCmd: string;
  switch (tool) {
    case "codex":
      toolCmd = `codex exec --full-auto "${prompt.replace(/"/g, '\\"')}"`;
      break;
    case "claude":
      ensureClaudeAuth();
      toolCmd = `claude -p "${prompt.replace(/"/g, '\\"')}" --output-format text`;
      break;
    case "pi":
      toolCmd = `pi --prompt "${prompt.replace(/"/g, '\\"')}" --no-tui`;
      break;
    default:
      toolCmd = `codex exec --full-auto "${prompt.replace(/"/g, '\\"')}"`;
  }

  const proc = Bun.spawn([
    "docker", "run", "--rm",
    "--name", containerName,
    "-e", `REPO_URL=${repoUrl}`,
    "-e", `BRANCH=${branch}`,
    "-e", `GITHUB_TOKEN=${token}`,
    // Pass through API keys from host environment
    ...(process.env.OPENAI_API_KEY ? ["-e", `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`] : []),
    ...(process.env.ANTHROPIC_API_KEY ? ["-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`] : []),
    "agent-loop-runner",
    "bash", "-c", toolCmd,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout
  const timeoutId = setTimeout(async () => {
    try {
      await $`docker kill ${containerName}`.quiet();
    } catch { /* container may have already exited */ }
  }, timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeoutId);

  return {
    exitCode: proc.exitCode ?? 1,
    output: stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""),
  };
}
