/**
 * LLM inference via joelclaw-wide inference-router policy.
 *
 * ADR-0140: Unified inference routing + centralized cost/observability.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInferenceRoute,
  buildPolicy,
  type BuildRouteInput,
  type InferencePolicy,
  INFERENCE_EVENT_NAMES,
  inferProviderFromModel,
  normalizeModel,
} from "@joelclaw/inference-router";
import { parsePiJsonAssistant, type LlmUsage, traceLlmGeneration } from "./langfuse";
import { emitOtelEvent } from "../observability/emit";

type InferenceMetadata = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 120_000;
const OTL_PROMPT_PREVIEW_CHARS = 6_000;
const OTL_OUTPUT_PREVIEW_CHARS = 6_000;

export type InferOptions = BuildRouteInput & {
  timeout?: number;
  json?: boolean;
  system?: string;
  component?: string;
  action?: string;
  print?: boolean;
  noTools?: boolean;
  env?: Record<string, string | undefined>;
  requestId?: string;
  policy?: Partial<InferencePolicy>;
  metadata?: InferenceMetadata;
  policyVersion?: string;
};

export type InferResult = {
  text: string;
  data?: unknown;
  model?: string;
  provider?: string;
  usage?: LlmUsage;
  attemptIndex?: number;
};

type PiAttemptResult = {
  rawText: string;
  stderr: string;
  exitCode: number;
  usage?: LlmUsage;
  model?: string;
  provider?: string;
  durationMs: number;
};

type PiAttemptError = Error & { stderr?: string; model?: string; provider?: string; attempt?: number };

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  if (value < 1_000) return 1_000;
  return Math.min(value, 10 * 60 * 1000);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimForMetadata(value: string, max = OTL_PROMPT_PREVIEW_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function parseJsonFromText(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const matches = [
    trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i),
    trimmed.match(/\{[\s\S]*\}/u),
    trimmed.match(/\[[\s\S]*\]/u),
  ];

  for (const match of matches) {
    if (!match) continue;
    const candidate = match[1] ?? match[0];
    if (!candidate) continue;

    try {
      return JSON.parse(candidate);
    } catch {
      // continue to next candidate
    }
  }

  return null;
}

async function runPiAttempt(
  promptPath: string,
  model: string,
  timeoutMs: number,
  opts: Pick<InferOptions, "system" | "print" | "noTools" | "env">,
): Promise<PiAttemptResult> {
  const args: string[] = ["pi", "-p", "--no-session", "--no-extensions"];
  if (opts.noTools) {
    args.push("--no-tools");
  }
  if (opts.print) {
    args.push("--print");
  }
  if (model) {
    args.push("--model", model);
  }
  if (opts.system) {
    args.push("--system-prompt", opts.system);
  }

  const proc = Bun.spawn(args, {
    stdin: Bun.file(promptPath),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/share/fnm/aliases/default/bin:${process.env.PATH}`,
      ...(opts.env ?? {}),
    },
  });

  const timeoutId = setTimeout(() => proc.kill(), timeoutMs);
  const startMs = Date.now();

  const [stdoutRaw, stderrRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startMs;
  clearTimeout(timeoutId);

  const parsed = parsePiJsonAssistant(stdoutRaw);
  const rawText = normalizeText(parsed?.text) || stdoutRaw.trim();

  return {
    rawText,
    stderr: normalizeText(stderrRaw),
    exitCode,
    usage: parsed?.usage,
    model: parsed?.model,
    provider: parsed?.provider,
    durationMs,
  };
}

function wrapError(error: unknown, attemptIndex: number, metadata?: string): PiAttemptError {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    message.slice(0, 1_000),
  ) as PiAttemptError;
  wrapped.stderr = metadata;
  wrapped.attempt = attemptIndex;
  return wrapped;
}

export async function infer(prompt: string, opts: InferOptions = {}): Promise<InferResult> {
  const inputPrompt = normalizeText(prompt);
  if (!inputPrompt) {
    throw new Error("inference: empty prompt");
  }

  const component = normalizeText(opts.component) || "system-bus.inference";
  const action = normalizeText(opts.action) || "inference.generate";
  const requestId = normalizeText(opts.requestId) || randomUUID();
  const timeoutMs = normalizeTimeout(opts.timeout ?? DEFAULT_TIMEOUT_MS);
  const requestedModel = normalizeText(opts.model);
  const isProduction = process.env.NODE_ENV === "production";
  const policy = buildPolicy({
    ...opts.policy,
    version: opts.policyVersion ?? opts.policy?.version,
    strict: opts.strict ?? opts.policy?.strict ?? isProduction,
    allowLegacy: opts.allowLegacy ?? opts.policy?.allowLegacy,
    maxFallbackAttempts: opts.maxAttempts ?? opts.policy?.maxFallbackAttempts ?? 3,
    defaults: opts.policy?.defaults ?? undefined,
  });

  const normalizedRequestedModel = requestedModel ? normalizeModel(requestedModel, policy.allowLegacy) : undefined;
  if (requestedModel && !normalizedRequestedModel && !policy.strict) {
    process.stderr.write(`inference: unknown model "${requestedModel}" in permissive mode, using passthrough.\n`);
  }

  const startedAt = Date.now();

  const route = buildInferenceRoute(
    {
      task: opts.task,
      model: requestedModel,
      provider: opts.provider,
      maxAttempts: opts.maxAttempts,
      allowLegacy: opts.allowLegacy,
      strict: opts.strict,
      policyVersion: opts.policyVersion,
    },
    policy,
  );

  await emitOtelEvent({
    level: "info",
    source: "system-bus",
    component,
    action: INFERENCE_EVENT_NAMES.request,
    success: true,
    metadata: {
      requestId,
      policyVersion: route.policyVersion,
      task: route.normalizedTask,
      requestedModel: route.requestedModel ?? requestedModel,
      attemptsPlanned: route.attempts.length,
      ...(opts.metadata ?? {}),
    },
  });

  const attempts = normalizedRequestedModel || !requestedModel || policy.strict
    ? route.attempts
    : [
        {
          model: requestedModel,
          provider: inferProviderFromModel(requestedModel),
          reason: "requested" as const,
          attempt: 0,
        },
        ...route.attempts.slice(0, Math.max(0, route.attempts.length - 1)).map((attempt) => ({
          ...attempt,
          attempt: attempt.attempt + 1,
        })),
      ];

  await emitOtelEvent({
    level: "info",
    source: "system-bus",
    component,
    action: INFERENCE_EVENT_NAMES.route,
    success: true,
    metadata: {
      requestId,
      policyVersion: route.policyVersion,
      task: route.normalizedTask,
      attempts: attempts.map((attempt, index) => ({
        attemptIndex: index,
        model: attempt.model,
        provider: attempt.provider,
        reason: attempt.reason,
      })),
      ...(opts.metadata ?? {}),
    },
  });

  const tempDir = await mkdtemp(join(tmpdir(), "joelclaw-infer-"));
  try {
    const promptPath = join(tempDir, "prompt.txt");
    await writeFile(promptPath, inputPrompt, "utf-8");

    let lastError: Error | null = null;
    let attemptsLeft = attempts.length;

    for (const attempt of attempts) {
      attemptsLeft -= 1;
      const attemptStartedAt = Date.now();
      try {
        const piResult = await runPiAttempt(promptPath, attempt.model, timeoutMs, { system: opts.system });

        if (piResult.exitCode !== 0) {
          const stderr = normalizeText(piResult.stderr);
          if (!piResult.rawText && !opts.json) {
            throw wrapError(
              new Error(`pi exited ${piResult.exitCode}: ${stderr || "empty output"}`),
              attempt.attempt,
              stderr,
            );
          }
        }

        const outputText = piResult.rawText.trim();
        const parsedData = opts.json ? parseJsonFromText(outputText) : undefined;

        const metadata = {
          requestId,
          policyVersion: route.policyVersion,
          task: route.normalizedTask,
          attemptIndex: attempt.attempt,
          model: piResult.model || attempt.model,
          provider: piResult.provider || attempt.provider,
          fallbackUsed: attempt.attempt > 0,
          durationMs: piResult.durationMs,
          ...(opts.metadata ?? {}),
        };

        const provider = (piResult.provider || attempt.provider) ?? undefined;
        const model = (piResult.model || attempt.model) ?? undefined;

        await emitOtelEvent({
          level: "info",
          source: "system-bus",
          component,
          action: INFERENCE_EVENT_NAMES.result,
          success: true,
          duration_ms: piResult.durationMs,
          metadata,
        });

        await traceLlmGeneration({
          traceName: "joelclaw.inference",
          generationName: "system-bus.infer",
          component,
          action,
          input: {
            prompt: trimForMetadata(inputPrompt),
            task: route.normalizedTask,
            requestId,
            policyVersion: route.policyVersion,
            attemptIndex: attempt.attempt,
          },
          output: {
            text: trimForMetadata(outputText, OTL_OUTPUT_PREVIEW_CHARS),
            hasJson: typeof parsedData !== "undefined",
          },
          provider,
          model,
          usage: piResult.usage,
          durationMs: piResult.durationMs,
          metadata: {
            task: route.normalizedTask,
            requestId,
            policyVersion: route.policyVersion,
            attemptIndex: attempt.attempt,
            ...(opts.metadata ?? {}),
          },
        });

        return {
          text: outputText,
          data: parsedData,
          usage: piResult.usage,
          model,
          provider,
          attemptIndex: attempt.attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const hasFallback = attemptsLeft > 0;
        const failureDurationMs = Date.now() - attemptStartedAt;

        await traceLlmGeneration({
          traceName: "joelclaw.inference",
          generationName: "system-bus.infer",
          component,
          action,
          input: {
            prompt: trimForMetadata(inputPrompt),
            task: route.normalizedTask,
            requestId,
            policyVersion: route.policyVersion,
            attemptIndex: attempt.attempt,
          },
          output: { failed: true },
          provider: attempt.provider,
          model: attempt.model,
          durationMs: failureDurationMs,
          error: lastError.message,
          metadata: {
            task: route.normalizedTask,
            requestId,
            policyVersion: route.policyVersion,
            attemptIndex: attempt.attempt,
            fallbackRemaining: attemptsLeft,
            ...(opts.metadata ?? {}),
          },
        });

        await emitOtelEvent({
          level: hasFallback ? "warn" : "error",
          source: "system-bus",
          component,
          action: hasFallback ? INFERENCE_EVENT_NAMES.fallback : INFERENCE_EVENT_NAMES.fail,
          success: false,
          error: lastError.message,
          metadata: {
            requestId,
            policyVersion: route.policyVersion,
            task: route.normalizedTask,
            attemptIndex: attempt.attempt,
            model: attempt.model,
            provider: attempt.provider,
            fallbackRemaining: attemptsLeft,
            ...(opts.metadata ?? {}),
          },
        });

        if (hasFallback) continue;
      }
    }

    await traceLlmGeneration({
      traceName: "joelclaw.inference",
      generationName: "system-bus.infer",
      component,
      action,
      input: {
        prompt: trimForMetadata(inputPrompt),
        task: route.normalizedTask,
        requestId,
        policyVersion: route.policyVersion,
      },
      output: { failed: true },
      durationMs: Date.now() - startedAt,
      error: lastError ? lastError.message : "inference exhausted all attempts",
      metadata: {
        task: route.normalizedTask,
        requestId,
        policyVersion: route.policyVersion,
      },
    });

    if (lastError) {
      throw lastError;
    }
    throw new Error("inference failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
