/**
 * ADR-0155: Three-Stage Story Pipeline
 *
 * Implement → Prove → Judge per story.
 * Three independent codex exec calls, no shared state except git.
 *
 * Event: agent/story.start
 * Data: { prdPath, storyId, cwd, attempt?, judgment? }
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";

const MAX_ATTEMPTS = 3;
const CODEX_TIMEOUT = 300; // 5 min per stage

interface Story {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  priority: number;
  depends_on?: string[];
}

interface Prd {
  title: string;
  context: {
    repo: string;
    test_command?: string;
    typecheck_command?: string;
    lint_command?: string;
    [key: string]: unknown;
  };
  stories: Story[];
}

function codexExec(prompt: string, cwd: string): { ok: boolean; output: string } {
  const escaped = prompt.replace(/'/g, "'\\''");
  const cmd = `codex exec --full-auto -m gpt-5.3-codex '${escaped}'`;

  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: CODEX_TIMEOUT * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: "true", TERM: "dumb" },
    }).trim();
    return { ok: true, output: output.slice(-30_000) };
  } catch (error: any) {
    const stdout = error.stdout?.toString().trim() || "";
    const stderr = error.stderr?.toString().trim() || "";
    return {
      ok: false,
      output: `STDOUT:\n${stdout.slice(-15_000)}\nSTDERR:\n${stderr.slice(-5_000)}`,
    };
  }
}

function getHeadSha(cwd: string): string {
  return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
}

function getDiffSince(sha: string, cwd: string): string {
  try {
    return execSync(`git diff ${sha} HEAD`, { cwd, encoding: "utf-8" }).slice(0, 30_000);
  } catch {
    return "(diff unavailable)";
  }
}

export const storyPipeline = inngest.createFunction(
  {
    id: "agent/story-pipeline",
    name: "Story Pipeline: Implement → Prove → Judge",
    retries: 0, // we handle retries via re-events, not Inngest retries
    concurrency: [{ scope: "fn", limit: 1 }], // one story at a time
  },
  { event: "agent/story.start" },
  async ({ event, step, logger }) => {
    const {
      prdPath,
      storyId,
      cwd: rawCwd,
      attempt = 1,
      judgment,
    } = event.data as {
      prdPath: string;
      storyId: string;
      cwd?: string;
      attempt?: number;
      judgment?: string;
    };

    if (!prdPath || !storyId) {
      throw new NonRetriableError("Missing prdPath or storyId");
    }

    const cwd = rawCwd || process.env.HOME || "/Users/joel";

    // Load PRD
    const prd: Prd = await step.run("load-prd", () => {
      const raw = readFileSync(prdPath, "utf-8");
      return JSON.parse(raw) as Prd;
    });

    const story = prd.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new NonRetriableError(`Story ${storyId} not found in PRD`);
    }

    if (attempt > MAX_ATTEMPTS) {
      logger.warn(`Story ${storyId} blocked after ${MAX_ATTEMPTS} attempts`);
      return { storyId, status: "blocked", attempts: attempt - 1 };
    }

    const preSha = await step.run("get-pre-sha", () => getHeadSha(cwd));

    // ── Stage 1: Implement ──────────────────────────────────────────
    const implementResult = await step.run("implement", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const validation = [
        prd.context.typecheck_command && `Typecheck: ${prd.context.typecheck_command}`,
        prd.context.lint_command && `Lint: ${prd.context.lint_command}`,
        prd.context.test_command && `Test: ${prd.context.test_command}`,
      ].filter(Boolean).join("\n");

      const judgmentContext = judgment
        ? `\n\nPREVIOUS ATTEMPT FAILED. Judge feedback:\n${judgment}\n\nFix the issues identified above.`
        : "";

      const prompt = `Implement this story in the codebase.

STORY: ${story.title}
${story.description}

ACCEPTANCE CRITERIA:
${criteria}

VALIDATION (run these before committing):
${validation}
${judgmentContext}

After implementing, commit your changes with message: "feat(${storyId}): ${story.title}"
Do NOT commit if validation fails — fix issues first.`;

      return codexExec(prompt, cwd);
    });

    // ── Stage 2: Prove ──────────────────────────────────────────────
    const proofResult = await step.run("prove", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const validation = [
        prd.context.typecheck_command && `Typecheck: ${prd.context.typecheck_command}`,
        prd.context.lint_command && `Lint: ${prd.context.lint_command}`,
        prd.context.test_command && `Test: ${prd.context.test_command}`,
      ].filter(Boolean).join("\n");

      const prompt = `You are a code reviewer verifying a feature implementation.

STORY: ${story.title}

ACCEPTANCE CRITERIA:
${criteria}

YOUR JOB:
1. Run ALL validation commands:
${validation}

2. Check each acceptance criterion manually — read the relevant files, verify the behavior.
3. Fix any obvious issues you find (type errors, lint errors, missing imports, logic bugs).
4. If you make fixes, commit with message: "fix(${storyId}): proof fixes"
5. Write a proof-of-work summary to /tmp/proof-${storyId}.md listing each criterion and whether it passes.

Be thorough. The next stage will judge based on your proof.`;

      return codexExec(prompt, cwd);
    });

    // ── Stage 3: Judge ──────────────────────────────────────────────
    const judgeResult = await step.run("judge", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const diff = getDiffSince(preSha, cwd);

      const prompt = `You are a strict judge evaluating whether a story implementation meets its acceptance criteria.

STORY: ${story.title}

ACCEPTANCE CRITERIA:
${criteria}

DIFF (changes made):
\`\`\`
${diff}
\`\`\`

PROVER OUTPUT:
${proofResult.output.slice(-10_000)}

YOUR JOB:
1. Evaluate EACH acceptance criterion. Does the diff satisfy it?
2. If ALL criteria pass: write exactly "VERDICT: PASS" on its own line.
3. If ANY criterion fails: write exactly "VERDICT: FAIL" on its own line, followed by specific feedback on what's wrong and how to fix it.

Be strict. Partial implementations are failures.`;

      return codexExec(prompt, cwd);
    });

    // ── Parse verdict ───────────────────────────────────────────────
    const passed = judgeResult.output.includes("VERDICT: PASS");

    if (passed) {
      logger.info(`Story ${storyId} PASSED on attempt ${attempt}`);

      // Find next story by priority
      const completedIds = new Set([storyId]);
      const nextStory = prd.stories
        .filter((s) => !completedIds.has(s.id))
        .filter((s) => !s.depends_on?.some((dep) => !completedIds.has(dep)))
        .sort((a, b) => a.priority - b.priority)[0];

      if (nextStory) {
        await step.sendEvent("start-next-story", {
          name: "agent/story.start",
          data: { prdPath, storyId: nextStory.id, cwd },
        });
      }

      return { storyId, status: "passed", attempt };
    }

    // Failed — extract judgment and retry
    const judgmentText = judgeResult.output.slice(-5_000);
    logger.warn(`Story ${storyId} FAILED attempt ${attempt}: ${judgmentText.slice(0, 200)}`);

    await step.sendEvent("retry-story", {
      name: "agent/story.start",
      data: {
        prdPath,
        storyId,
        cwd,
        attempt: attempt + 1,
        judgment: judgmentText,
      },
    });

    return { storyId, status: "failed", attempt, judgment: judgmentText.slice(0, 500) };
  }
);
