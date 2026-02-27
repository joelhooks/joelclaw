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
import { readFileSync, writeFileSync } from "node:fs";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { inngest } from "../client";
import { buildGatewaySignalMeta, type GatewaySignalLevel } from "../middleware/gateway-signal";

const MAX_ATTEMPTS = 3;

// ── PRD Schema (runtime validated) ─────────────────────────────────

const StorySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(z.string()).optional(),
  acceptance: z.array(z.string()).optional(),
  priority: z.number(),
  depends_on: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  status: z.string().optional(),
}).transform((s) => ({
  ...s,
  acceptance_criteria: s.acceptance_criteria ?? s.acceptance ?? [],
}));

type Story = z.output<typeof StorySchema>;

const PrdSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  adrs: z.array(z.string()).optional(),
  context: z.object({
    repo: z.string().optional(),
    test_command: z.string().optional(),
    typecheck_command: z.string().optional(),
    lint_command: z.string().optional(),
    codex_timeout_seconds: z.number().optional(),
  }).passthrough().optional(),
  stories: z.array(StorySchema).min(1, "PRD must have at least one story"),
});

type Prd = z.output<typeof PrdSchema>;

interface CodexExecOptions {
  prompt: string;
  cwd: string;
  outputSchema?: Record<string, unknown>;
  schemaName?: string;
  timeoutMs?: number;
}

interface CodexHealingOptions extends CodexExecOptions {
  stageName: string;
}

interface CodexExecResult<T = unknown> {
  ok: boolean;
  output: string;
  parsed?: T;
  parseError?: string;
}

interface ImplementStageOutput {
  status: "implemented" | "blocked";
  summary: string;
  validation: {
    commands_run: string[];
    all_passed: boolean;
    failures: string[];
  };
  commit: {
    created: boolean;
    sha?: string;
    message: string;
  };
  next_actions?: string[];
}

interface ProofStageOutput {
  overall_pass: boolean;
  summary: string;
  proof_path: string;
  validation: {
    commands_run: string[];
    all_passed: boolean;
    failures: string[];
  };
  criteria_results: Array<{
    criterion: string;
    pass: boolean;
    evidence: string;
    issues: string[];
  }>;
  fixes_committed: boolean;
  fix_commit_sha?: string;
}

interface JudgeStageOutput {
  verdict: "PASS" | "FAIL";
  feedback: string;
  retry_guidance: string[];
  criteria_evaluation: Array<{
    criterion: string;
    pass: boolean;
    rationale: string;
  }>;
}

type GatewayMessageIntent =
  | "pipeline.lifecycle"
  | "pipeline.stage"
  | "pipeline.self_heal"
  | "pipeline.outcome";

const implementOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "validation", "commit", "next_actions"],
  properties: {
    status: { type: "string", enum: ["implemented", "blocked"] },
    summary: { type: "string" },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["commands_run", "all_passed", "failures"],
      properties: {
        commands_run: { type: "array", items: { type: "string" } },
        all_passed: { type: "boolean" },
        failures: { type: "array", items: { type: "string" } },
      },
    },
    commit: {
      type: "object",
      additionalProperties: false,
      required: ["created", "sha", "message"],
      properties: {
        created: { type: "boolean" },
        sha: { type: ["string", "null"] },
        message: { type: "string" },
      },
    },
    next_actions: { type: "array", items: { type: "string" } },
  },
};

const proofOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "overall_pass",
    "summary",
    "proof_path",
    "validation",
    "criteria_results",
    "fixes_committed",
    "fix_commit_sha",
  ],
  properties: {
    overall_pass: { type: "boolean" },
    summary: { type: "string" },
    proof_path: { type: "string" },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["commands_run", "all_passed", "failures"],
      properties: {
        commands_run: { type: "array", items: { type: "string" } },
        all_passed: { type: "boolean" },
        failures: { type: "array", items: { type: "string" } },
      },
    },
    criteria_results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "pass", "evidence", "issues"],
        properties: {
          criterion: { type: "string" },
          pass: { type: "boolean" },
          evidence: { type: "string" },
          issues: { type: "array", items: { type: "string" } },
        },
      },
    },
    fixes_committed: { type: "boolean" },
    fix_commit_sha: { type: ["string", "null"] },
  },
};

const judgeOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "feedback", "retry_guidance", "criteria_evaluation"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    feedback: { type: "string" },
    retry_guidance: { type: "array", items: { type: "string" } },
    criteria_evaluation: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "pass", "rationale"],
        properties: {
          criterion: { type: "string" },
          pass: { type: "boolean" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

function escapeShellArg(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function writeOutputSchemaFile(schema: Record<string, unknown>, schemaName: string): string {
  const safeName = schemaName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const schemaPath = `/tmp/codex-output-schema-${safeName}.json`;
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf-8");
  return schemaPath;
}

function codexExec<T = unknown>({
  prompt,
  cwd,
  outputSchema,
  schemaName,
  timeoutMs,
}: CodexExecOptions): CodexExecResult<T> {
  const escapedPrompt = escapeShellArg(prompt);
  const schemaPath = outputSchema
    ? writeOutputSchemaFile(outputSchema, schemaName || "response")
    : undefined;
  const schemaFlag = schemaPath ? ` --output-schema '${escapeShellArg(schemaPath)}'` : "";
  const cmd = `codex exec --full-auto -m gpt-5.3-codex${schemaFlag} '${escapedPrompt}'`;

  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      ...(typeof timeoutMs === "number" ? { timeout: timeoutMs } : {}),
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: "true", TERM: "dumb" },
    }).trim();

    const trimmedOutput = output.slice(-30_000);

    if (!outputSchema) {
      return { ok: true, output: trimmedOutput };
    }

    try {
      const parsed = JSON.parse(trimmedOutput) as T;
      return { ok: true, output: trimmedOutput, parsed };
    } catch (parseError) {
      return {
        ok: true,
        output: trimmedOutput,
        parseError: `Failed to parse schema-constrained output: ${String(parseError)}`,
      };
    }
  } catch (error: any) {
    const stdout = error.stdout?.toString().trim() || "";
    const stderr = error.stderr?.toString().trim() || "";
    return {
      ok: false,
      output: `STDOUT:\n${stdout.slice(-15_000)}\nSTDERR:\n${stderr.slice(-5_000)}`,
    };
  }
}

function tryParseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function extractJsonObject<T>(value: string): T | undefined {
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return undefined;
  }

  const candidate = value.slice(firstBrace, lastBrace + 1);
  return tryParseJson<T>(candidate);
}

function codexExecWithHealing<T = unknown>({
  prompt,
  cwd,
  outputSchema,
  schemaName,
  stageName,
  timeoutMs,
}: CodexHealingOptions): CodexExecResult<T> {
  const result = codexExec<T>({ prompt, cwd, outputSchema, schemaName, timeoutMs });

  if (!outputSchema) {
    return result;
  }

  if (result.ok && result.parsed) {
    return result;
  }

  const extracted = extractJsonObject<T>(result.output);
  if (extracted) {
    return {
      ok: true,
      output: result.output,
      parsed: extracted,
      parseError: result.parseError,
    };
  }

  const repairPrompt = `Convert the following raw model output into valid JSON matching the provided output schema.

Rules:
- Return ONLY JSON.
- Do not add markdown fences.
- Preserve factual content; if information is missing, use safe defaults.

RAW OUTPUT:
${result.output.slice(-12_000)}`;

  const repaired = codexExec<T>({
    prompt: repairPrompt,
    cwd,
    outputSchema,
    schemaName: `${schemaName || stageName}-repair`,
    timeoutMs,
  });

  if (repaired.ok && repaired.parsed) {
    return repaired;
  }

  return {
    ok: false,
    output: repaired.output || result.output,
    parseError:
      repaired.parseError ||
      result.parseError ||
      `Failed to produce schema-valid JSON for stage ${stageName}`,
  };
}

function getHeadSha(cwd: string): string {
  // Verify cwd is actually a git repo before running
  const resolvedCwd = cwd || "/Users/joel/Code/joelhooks/joelclaw";
  try {
    return execSync("git rev-parse HEAD", { cwd: resolvedCwd, encoding: "utf-8" }).trim();
  } catch (e) {
    // If cwd isn't a git repo, try the monorepo root as fallback
    const fallback = "/Users/joel/Code/joelhooks/joelclaw";
    if (resolvedCwd !== fallback) {
      return execSync("git rev-parse HEAD", { cwd: fallback, encoding: "utf-8" }).trim();
    }
    throw e;
  }
}

function getDiffSince(sha: string, cwd: string): string {
  try {
    return execSync(`git diff ${sha} HEAD`, { cwd, encoding: "utf-8" }).slice(0, 30_000);
  } catch {
    return "(diff unavailable)";
  }
}

function resolveCodexTimeoutMs(prd: Prd): number | undefined {
  // Future-agent note: if stories become uneven in runtime, consider stage-specific
  // timeout knobs (implement/prove/judge) in PRD context instead of a single global value.
  const raw = prd.context?.codex_timeout_seconds;

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }

  if (raw <= 0) {
    return undefined;
  }

  return Math.floor(raw * 1000);
}

export const storyPipeline = inngest.createFunction(
  {
    id: "agent/story-pipeline",
    name: "Story Pipeline: Implement → Prove → Judge",
    retries: 2, // survive transient SDK failures during worker restart (ADR-0156)
    concurrency: [{ scope: "fn", limit: 1 }], // one story at a time
    timeouts: {
      start: "30m", // codex implement can take 10-15 min, prove/judge 5 min each
    },
  },
  { event: "agent/story.start" },
  async ({ event, step, logger, gateway }) => {
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

    const cwd = rawCwd || `${process.env.HOME}/Code/joelhooks/joelclaw`;
    logger.info(`story-pipeline cwd resolved to: "${cwd}" (rawCwd: "${rawCwd}", HOME: "${process.env.HOME}")`);

    // NOTE for future agents:
    // - Use gateway.* for human-readable, authored updates back to the initiating session/channels.
    // - Keep gateway.progress()/notify() inside step.run() to avoid duplicate sends on step replay.
    // - Inngest monitor path handles structural run lifecycle; gateway path is for narrative progress.
    // - Include intent + level in payload using buildGatewaySignalMeta() for consistent triage fields.

    const emitProgress = async (
      name: string,
      message: string,
      intent: GatewayMessageIntent,
      level: GatewaySignalLevel,
      extra?: Record<string, unknown>
    ) => {
      await step.run(`gateway-progress-${name}`, async () => {
        await gateway.progress(message, {
          storyId,
          attempt,
          ...buildGatewaySignalMeta(intent, level),
          ...extra,
        });
      });
    };

    const emitNotify = async (
      name: string,
      prompt: string,
      intent: GatewayMessageIntent,
      level: GatewaySignalLevel,
      extra?: Record<string, unknown>
    ) => {
      await step.run(`gateway-notify-${name}`, async () => {
        await gateway.notify(name, {
          prompt,
          storyId,
          attempt,
          ...buildGatewaySignalMeta(intent, level),
          ...extra,
        });
      });
    };

    const scheduleRetry = async (stage: string, details: string) => {
      const healingJudgment = `Self-heal: ${stage} stage failed to produce valid output contract.\n${details.slice(-4_000)}`;
      logger.warn(`Story ${storyId} self-heal retry from ${stage}: ${details.slice(0, 200)}`);

      await emitProgress(
        `self-heal-${stage}-retry-${attempt}`,
        `Story ${storyId}: self-healing retry from ${stage} stage (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
        "pipeline.self_heal",
        "warn",
        { stage, status: "retrying" }
      );

      await step.sendEvent(`retry-story-${stage}`, {
        name: "agent/story.start",
        data: {
          prdPath,
          storyId,
          cwd,
          attempt: attempt + 1,
          judgment: healingJudgment,
        },
      });

      return {
        storyId,
        status: "failed",
        attempt,
        failedStage: stage,
        judgment: healingJudgment.slice(0, 500),
      };
    };

    // Load PRD — runtime validated via Zod
    const prd = await step.run("load-prd", () => {
      const raw = readFileSync(prdPath, "utf-8");
      const parsed = PrdSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new NonRetriableError(
          `Invalid PRD at ${prdPath}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      return parsed.data;
    });

    const story = prd.stories.find((s) => s.id === storyId);
    if (!story) {
      throw new NonRetriableError(
        `Story "${storyId}" not found in PRD. Available: ${prd.stories.map((s) => s.id).join(", ")}`,
      );
    }

    if (attempt > MAX_ATTEMPTS) {
      logger.warn(`Story ${storyId} blocked after ${MAX_ATTEMPTS} attempts`);
      await emitNotify(
        `story-blocked-${storyId}`,
        `## Story Blocked\nStory ${storyId} exceeded ${MAX_ATTEMPTS} attempts and is now blocked.`,
        "pipeline.outcome",
        "error",
        { status: "blocked" }
      );
      return { storyId, status: "blocked", attempts: attempt - 1 };
    }

    const codexTimeoutMs = resolveCodexTimeoutMs(prd);

    await emitProgress(
      `story-start-${storyId}-attempt-${attempt}`,
      `Story ${storyId}: starting attempt ${attempt}/${MAX_ATTEMPTS}.`,
      "pipeline.lifecycle",
      "info",
      { status: "started" }
    );

    const preSha = await step.run("get-pre-sha", () => getHeadSha(cwd));

    await emitProgress(
      `implement-start-${attempt}`,
      `Story ${storyId}: running implement stage.`,
      "pipeline.stage",
      "info",
      { stage: "implement" }
    );

    // ── Stage 1: Implement ──────────────────────────────────────────
    const implementResult = await step.run("implement", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const validation = [
        prd.context?.typecheck_command && `Typecheck: ${prd.context?.typecheck_command}`,
        prd.context?.lint_command && `Lint: ${prd.context?.lint_command}`,
        prd.context?.test_command && `Test: ${prd.context?.test_command}`,
      ].filter(Boolean).join("\n");

      const judgmentContext = judgment
        ? `\n\nPREVIOUS ATTEMPT FAILED. Judge feedback:\n${judgment}\n\nFix the issues identified above.`
        : "";

      const prompt = `Implement this story in the codebase.

REPOSITORY: ${cwd}
All file paths are relative to this directory. Run all commands from here.

STORY: ${story.title}
${story.description}

ACCEPTANCE CRITERIA:
${criteria}

VALIDATION (run these before committing):
${validation}
${judgmentContext}

OUTPUT CONTRACT:
You must return ONLY valid JSON that matches the provided output schema.
Capture your implementation result, validation status, and commit metadata.

CRITICAL — YOU MUST COMMIT:
1. Run ALL validation commands and fix any errors
2. git add -A
3. git commit -m "feat(${storyId}): ${story.title}"

If you do not commit, the entire pipeline run is wasted. A successful implementation WITHOUT a commit is a FAILURE.
Do NOT commit if validation fails — fix issues first, then commit.`;

      return codexExecWithHealing<ImplementStageOutput>({
        prompt,
        cwd,
        outputSchema: implementOutputSchema,
        schemaName: `implement-${storyId}`,
        stageName: "implement",
        timeoutMs: codexTimeoutMs,
      });
    });

    if (!implementResult.ok || !implementResult.parsed) {
      return scheduleRetry(
        "implement",
        `Implement stage failed contract validation. ${implementResult.parseError || implementResult.output}`
      );
    }

    await emitProgress(
      `implement-done-${attempt}`,
      `Story ${storyId}: implement stage complete.`,
      "pipeline.stage",
      "info",
      {
        stage: "implement",
        status: implementResult.parsed.status,
      }
    );

    // ── Stage 2: Prove ──────────────────────────────────────────────
    await emitProgress(
      `prove-start-${attempt}`,
      `Story ${storyId}: running prove stage.`,
      "pipeline.stage",
      "info",
      { stage: "prove" }
    );

    const proofResult = await step.run("prove", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const validation = [
        prd.context?.typecheck_command && `Typecheck: ${prd.context?.typecheck_command}`,
        prd.context?.lint_command && `Lint: ${prd.context?.lint_command}`,
        prd.context?.test_command && `Test: ${prd.context?.test_command}`,
      ].filter(Boolean).join("\n") || "(No validation commands provided in PRD context)";
      const implementStageOutput = implementResult.parsed
        ? JSON.stringify(implementResult.parsed, null, 2)
        : implementResult.output.slice(-10_000);

      const prompt = `You are a code reviewer verifying a feature implementation.

REPOSITORY: ${cwd}
All file paths are relative to this directory. Run all commands from here.

STORY: ${story.title}

ACCEPTANCE CRITERIA:
${criteria}

IMPLEMENT STAGE OUTPUT:
${implementStageOutput}

VALIDATION COMMANDS (run and evaluate all):
${validation}

YOUR JOB:
1. Run and evaluate every command in the VALIDATION COMMANDS section.
2. Check each acceptance criterion manually — read the relevant files, verify the behavior.
3. Fix any obvious issues you find (type errors, lint errors, missing imports, logic bugs).
4. If you make fixes, commit with message: "fix(${storyId}): proof fixes"
5. Write a proof-of-work summary to /tmp/proof-${storyId}.md listing each criterion and whether it passes.

OUTPUT CONTRACT:
Return ONLY valid JSON matching the provided output schema.
Set proof_path to "/tmp/proof-${storyId}.md".

Be thorough. The next stage will judge based on your proof.`;

      return codexExecWithHealing<ProofStageOutput>({
        prompt,
        cwd,
        outputSchema: proofOutputSchema,
        schemaName: `prove-${storyId}`,
        stageName: "prove",
        timeoutMs: codexTimeoutMs,
      });
    });

    if (!proofResult.ok || !proofResult.parsed) {
      return scheduleRetry(
        "prove",
        `Prove stage failed contract validation. ${proofResult.parseError || proofResult.output}`
      );
    }

    await emitProgress(
      `prove-done-${attempt}`,
      `Story ${storyId}: prove stage complete.`,
      "pipeline.stage",
      proofResult.parsed.overall_pass ? "info" : "warn",
      {
        stage: "prove",
        overallPass: proofResult.parsed.overall_pass,
      }
    );

    // ── Stage 3: Judge ──────────────────────────────────────────────
    await emitProgress(
      `judge-start-${attempt}`,
      `Story ${storyId}: running judge stage.`,
      "pipeline.stage",
      "info",
      { stage: "judge" }
    );

    const judgeResult = await step.run("judge", () => {
      const criteria = story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const diff = getDiffSince(preSha, cwd);
      const proofStageOutput = proofResult.parsed
        ? JSON.stringify(proofResult.parsed, null, 2)
        : proofResult.output.slice(-10_000);

      const prompt = `You are a strict judge evaluating whether a story implementation meets its acceptance criteria.

REPOSITORY: ${cwd}
All file paths are relative to this directory. Run all commands from here.

STORY: ${story.title}

ACCEPTANCE CRITERIA:
${criteria}

DIFF (changes made):
\`\`\`
${diff}
\`\`\`

PROVER OUTPUT:
${proofStageOutput}

YOUR JOB:
1. Evaluate EACH acceptance criterion using the diff and prover output.
2. Return ONLY valid JSON matching the provided output schema.
3. Set verdict to PASS only when every criterion passes; otherwise set FAIL.

Be strict. Partial implementations are failures.`;

      return codexExecWithHealing<JudgeStageOutput>({
        prompt,
        cwd,
        outputSchema: judgeOutputSchema,
        schemaName: `judge-${storyId}`,
        stageName: "judge",
        timeoutMs: codexTimeoutMs,
      });
    });

    if (!judgeResult.ok || !judgeResult.parsed) {
      return scheduleRetry(
        "judge",
        `Judge stage failed contract validation. ${judgeResult.parseError || judgeResult.output}`
      );
    }

    // ── Parse verdict ───────────────────────────────────────────────
    const passed = judgeResult.parsed?.verdict === "PASS";

    if (passed) {
      logger.info(`Story ${storyId} PASSED on attempt ${attempt}`);

      await emitNotify(
        `story-passed-${storyId}`,
        `## Story Passed\n${storyId} passed on attempt ${attempt}.`,
        "pipeline.outcome",
        "info",
        { status: "passed" }
      );

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
    const judgmentText = judgeResult.parsed
      ? JSON.stringify(judgeResult.parsed, null, 2).slice(-5_000)
      : judgeResult.output.slice(-5_000);
    logger.warn(`Story ${storyId} FAILED attempt ${attempt}: ${judgmentText.slice(0, 200)}`);

    await emitNotify(
      `story-failed-${storyId}`,
      `## Story Failed\n${storyId} failed on attempt ${attempt}. Scheduling retry.\n\n${judgmentText.slice(0, 1500)}`,
      "pipeline.outcome",
      "warn",
      { status: "failed" }
    );

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
