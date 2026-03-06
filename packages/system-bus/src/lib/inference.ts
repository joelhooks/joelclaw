/**
 * LLM inference via joelclaw-wide inference-router policy.
 *
 * ADR-0140: Unified inference routing + centralized cost/observability.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuildRouteInput,
  buildInferenceRoute,
  buildPolicy,
  INFERENCE_EVENT_NAMES,
  type InferencePolicy,
  inferProviderFromModel,
  normalizeModel,
  resolveProfile,
} from "@joelclaw/inference-router";
import { emitOtelEvent } from "../observability/emit";
import { loadAgentDefinition } from "./agent-roster";
import { checkCircuit, isNoOpFailure, recordFailure, recordSuccess } from "./inference-circuit";
import { type LlmUsage, parsePiJsonAssistant, traceLlmGeneration } from "./langfuse";

type InferenceMetadata = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 120_000;
const OTL_PROMPT_PREVIEW_CHARS = 6_000;
const OTL_OUTPUT_PREVIEW_CHARS = 6_000;

export type InferOptions = BuildRouteInput & {
  timeout?: number;
  json?: boolean;
  requireJson?: boolean;
  requireTextOutput?: boolean;
  system?: string;
  agent?: string;
  thinking?: string;
  tools?: string[];
  extensions?: string[];
  appendSystemPrompt?: string;
  component?: string;
  action?: string;
  print?: boolean;
  noTools?: boolean;
  noExtensions?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
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

function hasUsageSignal(usage?: LlmUsage): boolean {
  if (!usage) return false;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.costInput,
    usage.costOutput,
    usage.costTotal,
  ];

  return values.some((value) => typeof value === "number" && Number.isFinite(value));
}

function usageCoverageLabel(usage?: LlmUsage): "present" | "missing" {
  return hasUsageSignal(usage) ? "present" : "missing";
}

async function runPiAttempt(
  promptPath: string,
  model: string,
  timeoutMs: number,
  opts: Pick<
    InferOptions,
    "appendSystemPrompt" | "cwd" | "env" | "noExtensions" | "noTools" | "print" | "system" | "thinking" | "tools"
  >,
): Promise<PiAttemptResult> {
  const args: string[] = ["pi", "-p", "--no-session"];
  if (opts.noExtensions ?? true) {
    args.push("--no-extensions");
  }
  if (opts.noTools) {
    args.push("--no-tools");
  }
  if (!opts.noTools && opts.tools?.length) {
    args.push("--tools", opts.tools.join(","));
  }
  if (opts.print) {
    args.push("--print");
  }
  if (model) {
    const thinking = normalizeText(opts.thinking);
    args.push("--models", thinking ? `${model}:${thinking}` : model);
  }
  if (opts.system) {
    args.push("--system-prompt", opts.system);
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  const captureDir = await mkdtemp(join(tmpdir(), "joelclaw-pi-attempt-"));
  const stdoutPath = join(captureDir, "stdout.txt");
  const stderrPath = join(captureDir, "stderr.txt");

  try {
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdin: Bun.file(promptPath),
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/share/fnm/aliases/default/bin:${process.env.PATH}`,
        ...(opts.env ?? {}),
      },
    });

    const timeoutId = setTimeout(() => proc.kill(), timeoutMs);
    const startMs = Date.now();

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startMs;
    clearTimeout(timeoutId);

    // Pipe capture can hang forever when tool subprocesses inherit stdout/stderr.
    // Redirect to temp files instead so we can read whatever pi wrote once the
    // parent process exits, even if a descendant still holds the descriptors open.
    const [stdoutRaw, stderrRaw] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""),
      readFile(stderrPath, "utf8").catch(() => ""),
    ]);

    const parsed = parsePiJsonAssistant(stdoutRaw);
    const parsedText = normalizeText(parsed?.text);
    const rawText = parsed ? parsedText : stdoutRaw.trim();

    return {
      rawText,
      stderr: normalizeText(stderrRaw),
      exitCode,
      usage: parsed?.usage,
      model: parsed?.model,
      provider: parsed?.provider,
      durationMs,
    };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
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
  const requestedAgentName = normalizeText(opts.agent);
  const rosterAgent = requestedAgentName ? loadAgentDefinition(requestedAgentName) : null;
  const profile = !rosterAgent && requestedAgentName ? resolveProfile(requestedAgentName) : undefined;
  if (requestedAgentName && !rosterAgent && !profile) {
    throw new Error(`infer: unknown agent "${requestedAgentName}"`);
  }

  const agentSource: "direct" | "profile" | "roster" = rosterAgent
    ? "roster"
    : profile
      ? "profile"
      : "direct";
  const agentName = rosterAgent?.name ?? profile?.name ?? requestedAgentName ?? "direct";
  const agentDefinitionPath = rosterAgent?.filePath;

  const resolvedOpts: InferOptions = {
    ...profile?.defaults,
    ...(rosterAgent
      ? {
          appendSystemPrompt: rosterAgent.systemPrompt,
          extensions: rosterAgent.extensions,
          model: rosterAgent.model,
          thinking: rosterAgent.thinking,
          tools: rosterAgent.tools,
        }
      : {}),
    ...opts,
  };

  const inputPrompt = normalizeText(prompt);
  if (!inputPrompt) {
    throw new Error("inference: empty prompt");
  }

  const component = normalizeText(resolvedOpts.component) || "system-bus.inference";
  const action = normalizeText(resolvedOpts.action) || "inference.generate";
  const requestId = normalizeText(resolvedOpts.requestId) || randomUUID();
  const timeoutMs = normalizeTimeout(resolvedOpts.timeout ?? DEFAULT_TIMEOUT_MS);
  const requestedModel = normalizeText(resolvedOpts.model);
  const isProduction = process.env.NODE_ENV === "production";
  const policy = buildPolicy({
    ...resolvedOpts.policy,
    version: resolvedOpts.policyVersion ?? resolvedOpts.policy?.version,
    strict: resolvedOpts.strict ?? resolvedOpts.policy?.strict ?? isProduction,
    allowLegacy: resolvedOpts.allowLegacy ?? resolvedOpts.policy?.allowLegacy,
    maxFallbackAttempts: resolvedOpts.maxAttempts ?? resolvedOpts.policy?.maxFallbackAttempts ?? 3,
    defaults: resolvedOpts.policy?.defaults ?? undefined,
  });

  const normalizedRequestedModel = requestedModel ? normalizeModel(requestedModel, policy.allowLegacy) : undefined;
  if (requestedModel && !normalizedRequestedModel && !policy.strict) {
    process.stderr.write(`inference: unknown model "${requestedModel}" in permissive mode, using passthrough.\n`);
  }

  const startedAt = Date.now();

  const route = buildInferenceRoute(
    {
      task: resolvedOpts.task,
      model: requestedModel,
      provider: resolvedOpts.provider,
      maxAttempts: resolvedOpts.maxAttempts,
      allowLegacy: resolvedOpts.allowLegacy,
      strict: resolvedOpts.strict,
      policyVersion: resolvedOpts.policyVersion,
    },
    policy,
  );

  const baseAgentMetadata = {
    agentSource,
    agentName,
    ...(agentDefinitionPath ? { agentDefinitionPath } : {}),
  };
  const withAgentMetadata = (metadata: Record<string, unknown>, resolvedModel?: string) => ({
    ...metadata,
    ...baseAgentMetadata,
    ...(resolvedModel ? { resolvedModel } : {}),
  });
  const routeResolvedModel = route.attempts[0]?.model ?? route.requestedModel ?? requestedModel;

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
      ...baseAgentMetadata,
      ...(routeResolvedModel ? { resolvedModel: routeResolvedModel } : {}),
      ...(resolvedOpts.metadata ?? {}),
      ...(profile
        ? {
            agentProfile: profile.name,
            agentTags: profile.tags,
            agentToolset: profile.builtinTools,
          }
        : {}),
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
      ...withAgentMetadata({}, attempts[0]?.model ?? routeResolvedModel),
      ...(resolvedOpts.metadata ?? {}),
      ...(profile
        ? {
            agentProfile: profile.name,
            agentTags: profile.tags,
            agentToolset: profile.builtinTools,
          }
        : {}),
    },
  });

  const tempDir = await mkdtemp(join(tmpdir(), "joelclaw-infer-"));
  try {
    const promptPath = join(tempDir, "prompt.txt");
    await writeFile(promptPath, inputPrompt, "utf-8");

    let lastError: Error | null = null;
    let attemptsLeft = attempts.length;
    let allSkippedByCircuit = true;

    for (const attempt of attempts) {
      attemptsLeft -= 1;
      const attemptStartedAt = Date.now();

      // ADR-0191: Check circuit before expensive pi spawn
      const circuitCheck = checkCircuit(component, action);
      if (circuitCheck.skip) {
        // Circuit is open — skip this attempt
        await emitOtelEvent({
          level: "info",
          source: "system-bus",
          component,
          action: "inference.circuit.skipped_call",
          success: false,
          metadata: {
            requestId,
            circuitState: circuitCheck.state,
            circuitReason: circuitCheck.reason,
            attemptIndex: attempt.attempt,
            model: attempt.model,
            provider: attempt.provider,
            ...baseAgentMetadata,
            ...(resolvedOpts.metadata ?? {}),
          },
        }).catch(() => {});

        lastError = new Error(`inference circuit open for ${component}:${action} — ${circuitCheck.reason}`);
        if (attemptsLeft > 0) continue;
        break;
      }
      allSkippedByCircuit = false;

      try {
        const piResult = await runPiAttempt(promptPath, attempt.model, timeoutMs, {
          appendSystemPrompt: resolvedOpts.appendSystemPrompt,
          noExtensions:
            resolvedOpts.noExtensions ??
            !(agentSource === "roster" && (resolvedOpts.extensions?.length ?? 0) > 0),
          system: resolvedOpts.system,
          print: resolvedOpts.print,
          noTools: resolvedOpts.noTools,
          thinking: resolvedOpts.thinking,
          tools: resolvedOpts.tools,
          env: resolvedOpts.env,
          cwd: resolvedOpts.cwd,
        });

        if (piResult.exitCode !== 0) {
          const stderr = normalizeText(piResult.stderr);
          if (!piResult.rawText && !resolvedOpts.json) {
            throw wrapError(
              new Error(`pi exited ${piResult.exitCode}: ${stderr || "empty output"}`),
              attempt.attempt,
              stderr,
            );
          }
        }

        const outputText = piResult.rawText.trim();
        const parsedData = resolvedOpts.json ? parseJsonFromText(outputText) : undefined;
        const provider = (piResult.provider || attempt.provider) ?? undefined;
        const model = (piResult.model || attempt.model) ?? undefined;
        const usageCoverage = usageCoverageLabel(piResult.usage);
        const requiresJson = Boolean(resolvedOpts.json && resolvedOpts.requireJson);
        const requiresTextOutput = Boolean(resolvedOpts.requireTextOutput);

        if (requiresTextOutput && outputText.length === 0) {
          throw wrapError(new Error("inference_text_output_empty"), attempt.attempt, "text output required");
        }

        if (requiresJson && parsedData === null) {
          throw wrapError(
            new Error("inference_json_parse_empty"),
            attempt.attempt,
            trimForMetadata(outputText || "<empty>", 500),
          );
        }

        const metadata = withAgentMetadata({
          requestId,
          policyVersion: route.policyVersion,
          task: route.normalizedTask,
          attemptIndex: attempt.attempt,
          model,
          provider,
          fallbackUsed: attempt.attempt > 0,
          durationMs: piResult.durationMs,
          usageCoverage,
          usageCaptured: usageCoverage === "present",
          outputChars: outputText.length,
          jsonRequested: Boolean(resolvedOpts.json),
          jsonParsed: resolvedOpts.json ? parsedData !== null : undefined,
          circuitState: circuitCheck.state, // ADR-0191
          ...(resolvedOpts.metadata ?? {}),
          ...(profile
            ? {
                agentProfile: profile.name,
                agentTags: profile.tags,
                agentToolset: profile.builtinTools,
              }
            : {}),
        }, model);

        await emitOtelEvent({
          level: "info",
          source: "system-bus",
          component,
          action: INFERENCE_EVENT_NAMES.result,
          success: true,
          duration_ms: piResult.durationMs,
          metadata,
        });

        if (usageCoverage === "missing") {
          await emitOtelEvent({
            level: "warn",
            source: "system-bus",
            component,
            action: "model_router.usage_missing",
            success: false,
            metadata: {
              requestId,
              task: route.normalizedTask,
              attemptIndex: attempt.attempt,
              provider,
              model,
              ...baseAgentMetadata,
              ...(resolvedOpts.metadata ?? {}),
            },
          });
        }

        await traceLlmGeneration({
          traceName: "joelclaw.inference",
          generationName: "system-bus.infer",
          tags: profile?.tags ?? [],
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
            hasJson: resolvedOpts.json ? parsedData !== null : false,
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
            usageCoverage,
            usageCaptured: usageCoverage === "present",
            outputChars: outputText.length,
            ...baseAgentMetadata,
            ...(model ? { resolvedModel: model } : {}),
            ...(resolvedOpts.metadata ?? {}),
            ...(profile
              ? {
                  agentProfile: profile.name,
                  agentTags: profile.tags,
                  agentToolset: profile.builtinTools,
                }
              : {}),
          },
        });

        // ADR-0191: Record success → close circuit
        recordSuccess(component, action);

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

        // ADR-0191: Record no-op failures to circuit
        if (isNoOpFailure(lastError)) {
          recordFailure(component, action);
        }
        const failureDurationMs = Date.now() - attemptStartedAt;

        await traceLlmGeneration({
          traceName: "joelclaw.inference",
          generationName: "system-bus.infer",
          tags: profile?.tags ?? [],
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
            ...baseAgentMetadata,
            resolvedModel: attempt.model,
            ...(resolvedOpts.metadata ?? {}),
            ...(profile
              ? {
                  agentProfile: profile.name,
                  agentTags: profile.tags,
                  agentToolset: profile.builtinTools,
                }
              : {}),
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
            ...baseAgentMetadata,
            resolvedModel: attempt.model,
            ...(resolvedOpts.metadata ?? {}),
          },
        });

        if (hasFallback) continue;
      }
    }

    await traceLlmGeneration({
      traceName: "joelclaw.inference",
      generationName: "system-bus.infer",
      tags: profile?.tags ?? [],
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
        ...baseAgentMetadata,
        ...(attempts[attempts.length - 1]?.model ? { resolvedModel: attempts[attempts.length - 1]?.model } : {}),
        ...(resolvedOpts.metadata ?? {}),
        ...(profile
          ? {
              agentProfile: profile.name,
              agentTags: profile.tags,
              agentToolset: profile.builtinTools,
            }
          : {}),
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
