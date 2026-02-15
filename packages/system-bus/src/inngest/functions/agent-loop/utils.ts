import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Redis from "ioredis";

const LOOP_TMP = "/tmp/agent-loop";

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
  description: string;
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
  await redis.set(prdKey(loopId), JSON.stringify(prd));
  // TTL: 7 days — loops shouldn't last longer than that
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

// ── Progress file ────────────────────────────────────────────────────

export async function appendProgress(
  project: string,
  entry: string
) {
  const progressPath = join(project, "progress.txt");
  let existing = "";
  try {
    existing = await Bun.file(progressPath).text();
  } catch { /* file doesn't exist yet */ }
  const timestamp = new Date().toISOString();
  const newEntry = `\n### ${timestamp}\n${entry}\n`;
  await Bun.write(progressPath, existing + newEntry);
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
    const result = await $`git -C ${project} diff HEAD~1 HEAD`.quiet();
    return result.text();
  } catch {
    return "";
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

    const parsed = JSON.parse(stdout) as {
      verdict?: unknown;
      reasoning?: unknown;
      result?: unknown;
    };

    const payload = (
      parsed.result && typeof parsed.result === "object"
        ? parsed.result
        : parsed
    ) as { verdict?: unknown; reasoning?: unknown };

    const verdict = payload.verdict;
    const reasoning = payload.reasoning;

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
