// execSync kept for non-pool fallback paths if needed
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { initTracing, getCatalogModel as resolveModelFromCatalog } from "@joelclaw/inference-router";
import { init as initMessageStore, trimOld } from "@joelclaw/message-store";
import { ModelFallbackController, type TelemetryEmitter } from "@joelclaw/model-fallback";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { getModel } from "@mariozechner/pi-ai";
import { calculateContextTokens, createAgentSession, DefaultResourceLoader, getLastAssistantUsage, type LoadExtensionsResult, SessionManager } from "@mariozechner/pi-coding-agent";
import {
  completeOperatorTrace,
  failOperatorTrace,
  getOperatorTraceSnapshot,
} from "./callback-trace";
import {
  applyMutedChannelRepairPolicy,
  buildChannelHealthSnapshot,
  type ChannelHealState,
  type ChannelHealthEvent,
  type ChannelHealthSnapshot,
  evaluateChannelHealPolicy,
  evaluateChannelHealthAlert,
  type GatewayChannelId,
  getInitialChannelHealState,
  getInitialChannelHealthAlertState,
  recordChannelHealAttemptResult,
} from "./channel-health";
import { fetchChannel as fetchDiscordChannel, getClient as getDiscordClient, getRuntimeState as getDiscordRuntimeState, markError as markDiscordError, parseChannelId as parseDiscordChannelId, send as sendDiscord, shutdown as shutdownDiscord, start as startDiscord } from "./channels/discord";
import { getRuntimeState as getIMessageRuntimeState, send as sendIMessage, shutdown as shutdownIMessage, start as startIMessage } from "./channels/imessage";
import { getRedisClient, getRuntimeState as getRedisRuntimeState, isHealthy as isRedisHealthy, shutdown as shutdownRedisChannel, start as startRedisChannel } from "./channels/redis";
import { getRuntimeState as getSlackRuntimeState, isStarted as isSlackStarted, send as sendSlack, shutdown as shutdownSlack, start as startSlack } from "./channels/slack";
import { getBot, getRuntimeState as getTelegramRuntimeState, parseChatId, send as sendTelegram, sendMedia as sendTelegramMedia, setOutboundMessageIdCallback, shutdown as shutdownTelegram, start as startTelegram, TelegramChannel } from "./channels/telegram";
import type { SendMediaPayload } from "./channels/types";
import {
  drain,
  enqueue,
  getActiveRequestMetadata,
  getActiveSource,
  getActiveThreadContext,
  getConsecutiveFailures,
  getQueueDepth,
  getSupersessionState,
  isActiveRequestSuperseded,
  onBeforePromptDispatch,
  onContextOverflowRecovery,
  onPrompt,
  onError as onQueueError,
  onSupersession,
  type QueueErrorEvent,
  replayUnacked,
  setIdleWaiter,
  setSession,
} from "./command-queue";
import { defaultGatewayConfig, loadGatewayConfig, providerForModel } from "./commands/config";
import { getActiveDiscordMcqAdapter, registerDiscordMcqAdapter } from "./commands/discord-mcq-adapter";
import { getActiveMcqAdapter, type McqParams } from "./commands/mcq-adapter";
import { initializeTelegramCommandHandler, updatePinnedStatus } from "./commands/telegram-handler";
import { injectChannelContext } from "./formatting";
import {
  buildDeployVerificationPlan,
  DEPLOY_VERIFICATION_DELAY_MS,
  extractBashCommand,
  extractRepoPathFromCommand,
  type GuardrailSourceKind,
  isGitPushCommand,
  shouldTriggerToolBudgetCheckpoint,
  summarizeToolNames,
} from "./guardrails";
import { startHeartbeatRunner, TRIPWIRE_PATH } from "./heartbeat";
import { buildGatewayTurnKnowledgeWrite, sendGatewayTurnKnowledgeWrite } from "./knowledge-turn";
import { decideIdleGatewayMaintenance } from "./maintenance-policy";
import { normalizeOperatorRelayText } from "./operator-relay";
import { createEnvelope, type OutboundEnvelope } from "./outbound/envelope";
import { type OutboundAttribution, registerChannel, routeResponse } from "./outbound/router";
import {
  buildSessionPressureSnapshot,
  evaluateSessionPressureAlert,
  getInitialSessionPressureAlertState,
} from "./session-pressure";
import * as telegramStream from "./telegram-stream";
import {
  getFallbackWatchdogGraceRemainingMs,
  shouldTreatSessionAsDead,
} from "./watchdog";

// Initialize Langfuse tracing for inference routing (reads from env vars):
// LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_HOST or LANGFUSE_BASE_URL.
// Optional: JOELCLAW_LLM_OBS_ENABLED, JOELCLAW_ENV, JOELCLAW_RELEASE, GIT_SHA.
initTracing({});

/**
 * Register the gateway's agent identity with agent-mail (non-fatal).
 * Ensures project exists and registers MaroonReef as the gateway agent.
 */
async function registerGatewayAgent(): Promise<void> {
  const AGENT_MAIL_URL = process.env.AGENT_MAIL_URL?.trim() || "http://127.0.0.1:8765";
  const PROJECT_KEY = "/Users/joel/Code/joelhooks/joelclaw";
  const AGENT_NAME = "MaroonReef";

  async function mcpCall(toolName: string, args: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${AGENT_MAIL_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `gw-${Date.now()}`,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    if (!resp.ok) throw new Error(`agent-mail ${toolName}: HTTP ${resp.status}`);
  }

  try {
    await mcpCall("ensure_project", { human_key: PROJECT_KEY });
    await mcpCall("register_agent", {
      project_key: PROJECT_KEY,
      name: AGENT_NAME,
      program: "pi-gateway",
      model: "openai-codex/gpt-5.5",
    });
    console.log("[gateway] registered agent identity with agent-mail", { agent: AGENT_NAME });
  } catch (err) {
    console.warn("[gateway] agent-mail registration failed (non-fatal):", err);
  }
}

const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi/agent");
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;
const WS_PORT_FILE = `${PID_DIR}/gateway.ws.port`;
const JOELCLAW_DIR = join(HOME, ".joelclaw");
const SESSION_ID_FILE = join(JOELCLAW_DIR, "gateway.session");
const GATEWAY_SESSION_DIR = join(JOELCLAW_DIR, "sessions", "gateway");
// Gateway-specific working dir — has its own .pi/settings.json with aggressive compaction.
// Project-level settings (cwd/.pi/settings.json) override global (~/.pi/agent/settings.json).
// This keeps gateway compaction isolated from interactive pi sessions.
const GATEWAY_CWD = join(JOELCLAW_DIR, "gateway");
const GATEWAY_LOCAL_EXTENSION_PATH = join(GATEWAY_CWD, ".pi", "extensions", "gateway");
const GATEWAY_GLOBAL_EXTENSION_PATH = join(AGENT_DIR, "extensions", "gateway");
const DEFAULT_WS_PORT = 3018;
const WS_PORT = Number.parseInt(process.env.PI_GATEWAY_WS_PORT ?? String(DEFAULT_WS_PORT), 10) || DEFAULT_WS_PORT;
const startedAt = Date.now();

function enforceGatewayExtensionScope(): void {
  const hasLocalExtension = existsSync(GATEWAY_LOCAL_EXTENSION_PATH);
  const hasGlobalExtension = existsSync(GATEWAY_GLOBAL_EXTENSION_PATH);

  if (!hasLocalExtension) {
    throw new Error(
      `[gateway] missing required context-local extension at ${GATEWAY_LOCAL_EXTENSION_PATH}. `
      + "Install/symlink it before starting the daemon.",
    );
  }

  if (hasGlobalExtension) {
    throw new Error(
      `[gateway] global extension detected at ${GATEWAY_GLOBAL_EXTENSION_PATH}. `
      + "Gateway extension must be context-local only.",
    );
  }
}

enforceGatewayExtensionScope();

const startupGatewayConfig = await (async () => {
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
    });

    try {
      await redis.connect();
      return await loadGatewayConfig(redis);
    } finally {
      redis.disconnect();
    }
  } catch {
    return defaultGatewayConfig();
  }
})();

const preferredFallback = {
  provider: "openai-codex",
  model: "gpt-5.4",
} as const;
const hasPreferredFallback = Boolean(getModel(preferredFallback.provider as any, preferredFallback.model as any));

const isLegacyAnthropicFallback = startupGatewayConfig.fallbackProvider === "anthropic"
  && (startupGatewayConfig.fallbackModel === "claude-sonnet-4-6"
    || startupGatewayConfig.fallbackModel === "claude-sonnet-4-5");

if (isLegacyAnthropicFallback && hasPreferredFallback) {
  const from = `${startupGatewayConfig.fallbackProvider}/${startupGatewayConfig.fallbackModel}`;
  startupGatewayConfig.fallbackProvider = preferredFallback.provider;
  startupGatewayConfig.fallbackModel = preferredFallback.model;

  console.warn("[gateway:fallback] remapped fallback model", {
    from,
    to: `${preferredFallback.provider}/${preferredFallback.model}`,
    reason: "gateway fallback standard is now gpt-5.4",
  });

  void emitGatewayOtel({
    level: "warn",
    component: "daemon.fallback",
    action: "fallback.model.remapped",
    success: true,
    metadata: {
      from,
      to: `${preferredFallback.provider}/${preferredFallback.model}`,
    },
  });
} else if (startupGatewayConfig.fallbackProvider === "anthropic" && startupGatewayConfig.fallbackModel === "claude-sonnet-4-6") {
  const hasConfiguredFallback = Boolean(getModel("anthropic" as any, "claude-sonnet-4-6" as any));
  const hasCompatFallback = Boolean(getModel("anthropic" as any, "claude-sonnet-4-5" as any));

  if (!hasConfiguredFallback && hasCompatFallback) {
    startupGatewayConfig.fallbackModel = "claude-sonnet-4-5";
    console.warn("[gateway:fallback] remapped unsupported fallback model", {
      from: "anthropic/claude-sonnet-4-6",
      to: "anthropic/claude-sonnet-4-5",
      reason: "pi-ai model registry does not include claude-sonnet-4-6",
    });
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.fallback",
      action: "fallback.model.remapped",
      success: true,
      metadata: {
        from: "anthropic/claude-sonnet-4-6",
        to: "anthropic/claude-sonnet-4-5",
      },
    });
  }
}

function resolveModel(modelIdOverride: string | undefined) {
  const modelId = modelIdOverride ?? process.env.PI_MODEL ?? process.env.PI_MODEL_ID;
  if (!modelId) return undefined;

  const catalogModel = resolveModelFromCatalog(modelId);
  if (catalogModel) {
    const catalogModelId = catalogModel.id.includes("/") ? catalogModel.id.split("/")[1] : catalogModel.id;
    void emitGatewayOtel({
      level: "info",
      component: "daemon.inference",
      action: "catalog.resolved",
      success: true,
      metadata: {
        modelId,
        catalogModel: catalogModel.id,
        provider: catalogModel.provider,
      },
    });
    const model = getModel(catalogModel.provider as any, catalogModelId as any);
    if (model) return model;
  }

  // Use the model's actual provider (supports cross-provider fallback)
  const resolvedProvider = process.env.PI_MODEL_PROVIDER || providerForModel(modelId);
  if (!resolvedProvider) return undefined;

  const model = getModel(resolvedProvider as any, modelId as any);
  if (!model) {
    console.warn("[gateway] requested model not found; using SDK default", { provider: resolvedProvider, modelId });
    return undefined;
  }

  return model;
}

function describeModel(model: unknown): string {
  if (!model || typeof model !== "object") return "default";
  const value = model as { provider?: string; id?: string; name?: string };
  const provider = value.provider ?? "unknown";
  const id = value.id ?? value.name ?? "unknown";
  return `${provider}/${id}`;
}

function normalizeOutboundMessage(message: OutboundEnvelope | string): OutboundEnvelope {
  return typeof message === "string" ? createEnvelope(message) : message;
}

function inferMimeTypeFromMediaPathOrUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.split("?")[0] ?? value;
  const ext = extname(normalized).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
  };
  return map[ext];
}

function shouldForwardToTelegram(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const isHeartbeatOk = trimmed === "HEARTBEAT_OK"
    || (trimmed.includes("HEARTBEAT_OK") && trimmed.length < 300);
  const isTrivial = trimmed.length < 80;
  const isEcho = lower === "echo." || lower === "echo"
    || lower.startsWith("echo.") || lower.startsWith("completion echo");

  return !isHeartbeatOk && !isTrivial && !isEcho;
}

const HUMAN_TURN_BATCH_WINDOW_MS = 1_500;
const WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS = Math.max(
  30_000,
  Number.parseInt(process.env.JOELCLAW_GATEWAY_FALLBACK_WATCHDOG_GRACE_MS ?? "120000", 10),
);

function getSourceKind(source: string | undefined): "channel" | "internal" | "unknown" {
  if (!source) return "unknown";
  return source.includes(":") ? "channel" : "internal";
}

function isHumanChannelTurn(source: string, metadata?: Record<string, unknown>): boolean {
  if (source.startsWith("slack-intel:")) return false;

  if (source.startsWith("telegram:")) {
    return typeof metadata?.telegramMessageId === "number";
  }

  if (source.startsWith("discord:")) {
    return typeof metadata?.discordMessageId === "string";
  }

  if (source.startsWith("imessage:")) {
    return typeof metadata?.imessageMessageId === "number";
  }

  if (source.startsWith("slack:")) {
    const eventKind = metadata?.slackEventKind;
    return (eventKind === "message" || eventKind === "mention")
      && typeof metadata?.slackTs === "string";
  }

  return false;
}

function buildHumanTurnQueueMetadata(
  source: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isHumanChannelTurn(source, metadata)) return metadata;

  return {
    ...(metadata ?? {}),
    gatewayHumanLatestWins: true,
    gatewaySupersessionKey: source,
    gatewayBatchKey: source,
    gatewayBatchWindowMs: HUMAN_TURN_BATCH_WINDOW_MS,
  };
}

async function maybeNotifySupersessionSource(source: string): Promise<void> {
  try {
    if (source.startsWith("telegram:")) {
      const chatId = parseChatId(source);
      if (!chatId) return;
      await sendTelegram(
        chatId,
        "↪️ <b>Latest message received</b>\nSuperseding the previous turn.",
        { silent: true },
      );
      return;
    }

    if (source.startsWith("discord:")) {
      const channelId = parseDiscordChannelId(source);
      if (!channelId) return;
      await sendDiscord(channelId, "↪️ Latest message received.\nSuperseding the previous turn.");
      return;
    }

    if (source.startsWith("slack:")) {
      await sendSlack(source, "↪️ Latest message received.\nSuperseding the previous turn.");
      return;
    }

    if (source.startsWith("imessage:") && IMESSAGE_ALLOWED_SENDER) {
      await sendIMessage(IMESSAGE_ALLOWED_SENDER, "Latest message received. Superseding the previous turn.");
    }
  } catch (error) {
    console.warn("[gateway:supersession] notification failed", {
      source,
      error: String(error),
    });
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.supersession",
      action: "supersession.notify_failed",
      success: false,
      error: String(error),
      metadata: { source },
    });
  }
}

function isBackgroundSource(source: string | undefined): boolean {
  if (!source) return true;
  return source === "gateway" || source === "console";
}

function shouldSuppressConsoleForwardByPolicy(
  sourceKind: "channel" | "internal" | "unknown",
  attribution?: OutboundAttribution,
): boolean {
  if (sourceKind !== "internal") return false;
  if (!attribution?.backgroundSource) return false;
  if (attribution.hasActiveSource) return false;
  if (attribution.hasCapturedSource) return false;
  if (attribution.recoveredFromRecentPrompt) return false;
  return true;
}

type PendingToolCall = {
  toolName: string;
  input: unknown;
  startedAt: number;
};

type DeployVerificationState = {
  repoPath: string;
  commitSha: string;
  changedFiles: string[];
  scheduledAt: number;
};

const pendingToolCalls = new Map<string, PendingToolCall>();
const pendingDeployVerifications = new Map<string, DeployVerificationState>();
let currentTurnToolCallCount = 0;
let currentTurnCheckpointSent = false;
let currentTurnToolHistory: string[] = [];
let lastCheckpointAt = 0;
let lastCheckpointReason: string | undefined;

function rememberToolName(toolName: string | undefined): void {
  if (!toolName) return;
  currentTurnToolHistory.push(toolName);
  if (currentTurnToolHistory.length > 8) {
    currentTurnToolHistory = currentTurnToolHistory.slice(-8);
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markTurnCheckpoint(reason: string): void {
  currentTurnCheckpointSent = true;
  lastCheckpointAt = Date.now();
  lastCheckpointReason = reason;
}

function getCurrentGuardrailSource(): string | undefined {
  return getActiveSource() ?? responseSource ?? lastPromptSource;
}

async function sendGuardrailCheckpoint(message: string, metadata: Record<string, unknown>): Promise<void> {
  const source = getCurrentGuardrailSource();
  const chatId = source?.startsWith("telegram:")
    ? parseChatId(source) ?? TELEGRAM_USER_ID
    : TELEGRAM_USER_ID;

  void emitGatewayOtel({
    level: "warn",
    component: "daemon.guardrails",
    action: "guardrail.checkpoint.attempt",
    success: true,
    metadata: {
      source,
      chatId,
      ...metadata,
    },
  });

  if (!chatId) return;

  try {
    await sendTelegram(chatId, message);
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.guardrails",
      action: "guardrail.checkpoint.sent",
      success: true,
      metadata: {
        source,
        chatId,
        ...metadata,
      },
    });
  } catch (error) {
    console.error("[gateway:guardrails] checkpoint send failed", { error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.guardrails",
      action: "guardrail.checkpoint.failed",
      success: false,
      error: String(error),
      metadata: {
        source,
        chatId,
        ...metadata,
      },
    });
  }
}

async function maybeSendToolBudgetCheckpoint(): Promise<void> {
  if (currentTurnCheckpointSent) return;

  const source = getCurrentGuardrailSource();
  const sourceKind = getSourceKind(source) as GuardrailSourceKind;
  if (!shouldTriggerToolBudgetCheckpoint(currentTurnToolCallCount, sourceKind)) return;

  markTurnCheckpoint("tool-budget");
  const toolSummary = summarizeToolNames(currentTurnToolHistory);
  const budget = sourceKind === "channel" ? 2 : 4;

  const message = [
    "🧭 <b>Status checkpoint</b>",
    "",
    `This turn has already used <code>${currentTurnToolCallCount}</code> tool actions (<code>${escapeHtml(toolSummary)}</code>).`,
    `Guardrail budget for this source is <code>${budget}</code> before a check-in.`,
    "Continuing unless you steer me somewhere else.",
  ].join("\n");

  await sendGuardrailCheckpoint(message, {
    reason: "tool_budget_exceeded",
    toolCalls: currentTurnToolCallCount,
    sourceKind,
    toolSummary,
    budget,
  });
}

async function maybeScheduleDeployVerification(command: string): Promise<void> {
  if (!isGitPushCommand(command)) return;

  const repoPath = extractRepoPathFromCommand(command, HOME);
  if (!repoPath) {
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.guardrails",
      action: "guardrail.deploy_verification.unresolved_repo",
      success: false,
      error: "repo_path_not_detected",
      metadata: {
        command: command.slice(0, 240),
      },
    });
    return;
  }

  try {
    const commitSha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    const changedFiles = execSync("git diff-tree --no-commit-id --name-only -r HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5_000,
    })
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);

    const plan = buildDeployVerificationPlan(repoPath, changedFiles);
    if (!plan) return;

    const key = `${plan.repoPath}:${commitSha}`;
    if (pendingDeployVerifications.has(key)) return;

    pendingDeployVerifications.set(key, {
      repoPath: plan.repoPath,
      commitSha,
      changedFiles: plan.changedFiles,
      scheduledAt: Date.now(),
    });

    void emitGatewayOtel({
      level: "warn",
      component: "daemon.guardrails",
      action: "guardrail.deploy_verification.scheduled",
      success: true,
      metadata: {
        repoPath: plan.repoPath,
        commitSha,
        changedFiles: plan.changedFiles,
        delayMs: DEPLOY_VERIFICATION_DELAY_MS,
      },
    });

    setTimeout(() => {
      const pending = pendingDeployVerifications.get(key);
      if (!pending) return;
      void runDeployVerification(key, pending);
    }, DEPLOY_VERIFICATION_DELAY_MS);
  } catch (error) {
    console.error("[gateway:guardrails] deploy verification schedule failed", { error: String(error), repoPath });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.guardrails",
      action: "guardrail.deploy_verification.schedule_failed",
      success: false,
      error: String(error),
      metadata: {
        repoPath,
      },
    });
  }
}

async function runDeployVerification(key: string, pending: DeployVerificationState): Promise<void> {
  try {
    const output = execSync("vercel ls --yes 2>&1 | head -10", {
      cwd: pending.repoPath,
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
    }).trim();

    const hasError = /(^|\b)(error|failed)(\b|:)/i.test(output) || /● Error/i.test(output);
    const ready = /\bready\b/i.test(output) || /● Ready/i.test(output);

    if (hasError || !ready) {
      const message = [
        "🛑 <b>Deploy verification failed</b>",
        "",
        `<code>${escapeHtml(pending.repoPath)}</code>`,
        `Commit <code>${escapeHtml(pending.commitSha.slice(0, 8))}</code> needs attention.`,
        `<pre>${escapeHtml(output.slice(0, 700))}</pre>`,
      ].join("\n");

      void emitGatewayOtel({
        level: "error",
        component: "daemon.guardrails",
        action: "guardrail.deploy_verification.failed",
        success: false,
        error: hasError ? "vercel_error" : "ready_not_found",
        metadata: {
          repoPath: pending.repoPath,
          commitSha: pending.commitSha,
          changedFiles: pending.changedFiles,
          output: output.slice(0, 700),
        },
      });
      await sendGuardrailCheckpoint(message, {
        reason: "deploy_verification_failed",
        repoPath: pending.repoPath,
        commitSha: pending.commitSha,
      });
      return;
    }

    void emitGatewayOtel({
      level: "info",
      component: "daemon.guardrails",
      action: "guardrail.deploy_verification.passed",
      success: true,
      metadata: {
        repoPath: pending.repoPath,
        commitSha: pending.commitSha,
        changedFiles: pending.changedFiles,
        output: output.slice(0, 240),
      },
    });
  } catch (error) {
    console.error("[gateway:guardrails] deploy verification execution failed", {
      error: String(error),
      repoPath: pending.repoPath,
    });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.guardrails",
      action: "guardrail.deploy_verification.failed",
      success: false,
      error: String(error),
      metadata: {
        repoPath: pending.repoPath,
        commitSha: pending.commitSha,
        changedFiles: pending.changedFiles,
      },
    });
    await sendGuardrailCheckpoint([
      "🛑 <b>Deploy verification execution failed</b>",
      "",
      `<code>${escapeHtml(pending.repoPath)}</code>`,
      `Commit <code>${escapeHtml(pending.commitSha.slice(0, 8))}</code> could not be checked automatically.`,
      `<code>${escapeHtml(String(error).slice(0, 500))}</code>`,
    ].join("\n"), {
      reason: "deploy_verification_execution_failed",
      repoPath: pending.repoPath,
      commitSha: pending.commitSha,
    });
  } finally {
    pendingDeployVerifications.delete(key);
  }
}

function isMcqQuestion(value: unknown): value is McqParams["questions"][number] {
  if (!value || typeof value !== "object") return false;
  const question = value as Record<string, unknown>;
  return typeof question.id === "string"
    && typeof question.question === "string"
    && Array.isArray(question.options)
    && question.options.every((option) => typeof option === "string");
}

function isMcqParams(value: unknown): value is McqParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return Array.isArray(params.questions) && params.questions.every(isMcqQuestion);
}

function buildMcqToolResult(params: McqParams, answers: Record<string, string>): {
  content: Array<{ type: "text"; text: string }>;
  details: {
    title: string;
    answers: Array<{
      id: string;
      question: string;
      selected: number;
      answer: string;
      isCustom: boolean;
    }>;
    cancelled: false;
  };
} {
  const detailsAnswers = params.questions.map((question) => {
    const answer = answers[question.id] ?? "(no answer)";
    const selectedIndex = question.options.findIndex((option) => option === answer);
    const isCustom = selectedIndex === -1;

    return {
      id: question.id,
      question: question.question,
      selected: isCustom ? question.options.length + 1 : selectedIndex + 1,
      answer,
      isCustom,
    };
  });

  const contentLines = detailsAnswers.map((answer) => {
    if (answer.isCustom) return `${answer.id}: (user wrote) ${answer.answer}`;
    return `${answer.id}: ${answer.selected}. ${answer.answer}`;
  });

  return {
    content: [{ type: "text", text: contentLines.join("\n") }],
    details: {
      title: params.title ?? "Questions",
      answers: detailsAnswers,
      cancelled: false,
    },
  };
}

// Extensions that require TUI/interactive features and crash in headless gateway
const GATEWAY_EXCLUDED_EXTENSIONS = new Set(["auto-update"]);

function withChannelMcqOverride(base: LoadExtensionsResult): LoadExtensionsResult {
  // Filter out TUI-dependent extensions that crash in headless mode
  base.extensions = base.extensions.filter((ext) => {
    const segments = ext.path.replace(/\/+$/, "").split("/");
    const name = segments.pop()?.replace(/\.(ts|js)$/, "") ?? "";
    console.error(`[gateway] extension: ${name} (path: ${ext.path})`);
    if (GATEWAY_EXCLUDED_EXTENSIONS.has(name)) {
      console.error(`[gateway] EXCLUDING extension: ${name} (TUI-dependent)`);
      return false;
    }
    return true;
  });

  let overridesApplied = 0;

  for (const extension of base.extensions) {
    const registered = extension.tools.get("mcq");
    if (!registered) continue;

    const originalExecute = registered.definition.execute as (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;

    registered.definition.execute = (async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => {
      const source = getActiveSource();
      if (!isMcqParams(params)) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      // ── Discord MCQ (ADR-0122) ────────────────────────────────
      const isDiscordSource = typeof source === "string" && source.startsWith("discord:");
      if (isDiscordSource) {
        const discordAdapter = getActiveDiscordMcqAdapter();
        if (!discordAdapter) {
          console.warn("[gateway:mcq] discord mcq call but adapter not ready; falling back to default", { source });
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }

        const channelId = parseDiscordChannelId(source);
        if (!channelId) {
          console.warn("[gateway:mcq] discord source has no channel ID", { source });
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }

        try {
          const answers = await discordAdapter.handleMcqToolCall(
            { ...params, mode: params.mode ?? "decision" },
            channelId,
          );
          void emitGatewayOtel({
            level: "info",
            component: "daemon.mcq",
            action: "mcq.discord.completed",
            success: true,
            metadata: { source, channelId, questionCount: params.questions.length },
          });
          return buildMcqToolResult(params, answers);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[gateway:mcq] discord adapter failed", { source, error: message });
          void emitGatewayOtel({
            level: "error",
            component: "daemon.mcq",
            action: "mcq.discord.failed",
            success: false,
            error: message,
            metadata: { source, channelId },
          });
          return {
            content: [{ type: "text", text: `MCQ adapter failed: ${message}` }],
            details: { title: params.title ?? "Questions", answers: [], cancelled: true },
          };
        }
      }

      // ── Telegram MCQ ──────────────────────────────────────────
      const isTelegramSource = typeof source === "string" && source.startsWith("telegram:");
      if (!isTelegramSource) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      const adapter = getActiveMcqAdapter();
      if (!adapter) {
        console.warn("[gateway:mcq] telegram mcq call received before adapter initialization; using default tool behavior", {
          source,
        });
        void emitGatewayOtel({
          level: "warn",
          component: "daemon.mcq",
          action: "mcq.adapter_unavailable",
          success: false,
          metadata: {
            source,
            immediateTelegram: true,
          },
        });
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      const sourceChatId = source ? parseChatId(source) : undefined;

      try {
        const answers = await adapter.handleMcqToolCall(
          params,
          sourceChatId ? { chatId: sourceChatId } : undefined,
        );
        void emitGatewayOtel({
          level: "info",
          component: "daemon.mcq",
          action: "mcq.telegram.completed",
          success: true,
          metadata: {
            source,
            chatId: sourceChatId,
            questionCount: params.questions.length,
          },
        });
        return buildMcqToolResult(params, answers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[gateway:mcq] telegram adapter execution failed", { source, error: message });
        void emitGatewayOtel({
          level: "error",
          component: "daemon.mcq",
          action: "mcq.telegram.failed",
          success: false,
          error: message,
          metadata: {
            source,
            chatId: sourceChatId,
          },
        });
        return {
          content: [{ type: "text", text: `MCQ adapter failed: ${message}` }],
          details: {
            title: params.title ?? "Questions",
            answers: [],
            cancelled: true,
          },
        };
      }
    }) as typeof registered.definition.execute;

    overridesApplied += 1;
  }

  if (overridesApplied === 0) {
    console.warn("[gateway:mcq] no mcq tool found in loaded extensions; channel adapter overrides inactive");
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.mcq",
      action: "mcq.override.missing",
      success: false,
    });
  } else {
    console.log("[gateway:mcq] installed channel mcq tool overrides (telegram + discord)", { overridesApplied });
    void emitGatewayOtel({
      level: "info",
      component: "daemon.mcq",
      action: "mcq.override.installed",
      success: true,
      metadata: { overridesApplied },
    });
  }

  return base;
}

mkdirSync(GATEWAY_SESSION_DIR, { recursive: true });

// Always resume the existing session — context continuity is critical.
// Pi's compaction handles what gets sent to the API (reserveTokens/keepRecentTokens).
// The JSONL file grows but that's fine — pi summarizes old turns automatically.
const hasExistingSession = readdirSync(GATEWAY_SESSION_DIR).some(f => f.endsWith(".jsonl"));
const sessionManager = hasExistingSession
  ? SessionManager.continueRecent(HOME, GATEWAY_SESSION_DIR)
  : SessionManager.create(HOME, GATEWAY_SESSION_DIR);
console.log("[gateway] session", {
  mode: hasExistingSession ? "resumed" : "new",
  sessionId: sessionManager.getSessionId(),
  file: sessionManager.getSessionFile(),
  entries: sessionManager.getEntries().length,
});

const resourceLoader = new DefaultResourceLoader({
  cwd: GATEWAY_CWD,
  agentDir: AGENT_DIR,
  extensionsOverride: withChannelMcqOverride,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: GATEWAY_CWD,
  agentDir: AGENT_DIR,
  model: resolveModel(startupGatewayConfig.model),
  thinkingLevel: startupGatewayConfig.thinkingLevel === "none" ? undefined : startupGatewayConfig.thinkingLevel,
  sessionManager,
  resourceLoader,
});
// Fire extension lifecycle hooks (session_start) so extensions like memory-enforcer can initialize.
// Fire extension lifecycle hooks — catch async throws from TUI-dependent extensions
await session.bindExtensions({}).catch((err) => {
  console.error("[gateway] bindExtensions error (non-fatal):", err?.message ?? err);
});

const requestedPrimaryModelRef = getRequestedPrimaryModelRef();
const requestedPrimaryModelObject = resolveModel(startupGatewayConfig.model);
const resumedModelBeforeReconcile = describeModel(session.model);
const liveModelBeforeReconcile = getLiveSessionModelRef();
if (requestedPrimaryModelObject && !modelRefsEqual(liveModelBeforeReconcile, requestedPrimaryModelRef)) {
  console.warn("[gateway] restored requested primary model onto resumed session", {
    requested: modelRefToString(requestedPrimaryModelRef),
    resumed: modelRefToString(liveModelBeforeReconcile),
  });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon.inference",
    action: "model.reconciled_on_startup",
    success: true,
    metadata: {
      requested: modelRefToString(requestedPrimaryModelRef),
      resumed: modelRefToString(liveModelBeforeReconcile),
    },
  });
  try {
    await session.setModel(requestedPrimaryModelObject as any);
  } catch (error) {
    console.error("[gateway] failed to restore requested primary model onto resumed session", {
      requested: modelRefToString(requestedPrimaryModelRef),
      resumed: modelRefToString(liveModelBeforeReconcile),
      error: error instanceof Error ? error.message : String(error),
    });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.inference",
      action: "model.reconcile_on_startup.failed",
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        requested: modelRefToString(requestedPrimaryModelRef),
        resumed: modelRefToString(liveModelBeforeReconcile),
      },
    });
  }
}

void emitGatewayOtel({
  level: "info",
  component: "daemon",
  action: "daemon.session.started",
  success: true,
  metadata: {
    sessionId: session.sessionId,
    model: describeModel(session.model),
    requestedModel: modelRefToString(requestedPrimaryModelRef),
    resumedModelBeforeReconcile,
  },
});

const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;

type GatewayModelRef = { provider: string; id: string };

function normalizeModelRef(provider: string, rawId: string): GatewayModelRef {
  const normalizedProvider = provider.trim();
  const trimmedId = rawId.trim();
  if (trimmedId.includes("/")) {
    const [providerFromId, ...rest] = trimmedId.split("/");
    const normalizedId = rest.join("/").trim();
    if (providerFromId && normalizedId) {
      return {
        provider: providerFromId.trim(),
        id: normalizedId,
      };
    }
  }

  return {
    provider: normalizedProvider,
    id: trimmedId,
  };
}

function modelRefToString(model: GatewayModelRef): string {
  return `${model.provider}/${model.id}`;
}

function modelRefsEqual(left: GatewayModelRef, right: GatewayModelRef): boolean {
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase()
    && left.id.trim().toLowerCase() === right.id.trim().toLowerCase();
}

function getRequestedPrimaryModelRef(): GatewayModelRef {
  return normalizeModelRef(providerForModel(startupGatewayConfig.model), startupGatewayConfig.model);
}

function getLiveSessionModelRef(): GatewayModelRef {
  const liveModel = session.model as { provider?: string; id?: string; name?: string } | undefined;
  const requested = getRequestedPrimaryModelRef();
  const provider = typeof liveModel?.provider === "string" && liveModel.provider.trim().length > 0
    ? liveModel.provider
    : requested.provider;
  const rawId = typeof liveModel?.id === "string" && liveModel.id.trim().length > 0
    ? liveModel.id
    : typeof liveModel?.name === "string" && liveModel.name.trim().length > 0
      ? liveModel.name
      : requested.id;
  return normalizeModelRef(provider, rawId);
}

function getCurrentModelContextWindow(): number {
  const liveModel = session.model as { contextWindow?: number } | undefined;
  if (typeof liveModel?.contextWindow === "number" && Number.isFinite(liveModel.contextWindow) && liveModel.contextWindow > 0) {
    return liveModel.contextWindow;
  }

  const liveRef = getLiveSessionModelRef();
  const resolvedModel = getModel(liveRef.provider as any, liveRef.id as any);
  const contextWindow = (resolvedModel as { contextWindow?: number } | undefined)?.contextWindow;
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : DEFAULT_MODEL_CONTEXT_WINDOW;
}

// ── Session lifecycle guards (ADR-0211) ────────────────
// Track compaction freshness and session age to prevent context bloat.
// The overnight thrash of 2026-03-05 was caused by 12h without compaction:
// context grew → Opus first-token latency exceeded 120s → fallback thrash loop.
const MAX_COMPACTION_GAP_MS = 4 * 60 * 60 * 1000; // 4 hours — force compact if overdue
const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours — fresh session if exceeded (was 24h, hit 85% at 7h)
const SESSION_PRESSURE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const PROACTIVE_COMPACTION_COOLDOWN_MS = 30 * 60 * 1000;
const PROACTIVE_COMPACTION_USAGE_DELTA_PERCENT = 5;
const GATEWAY_HEALTH_MUTED_CHANNELS_KEY = "gateway:health:muted-channels";
const GATEWAY_HEALTH_MUTE_REASONS_KEY = "gateway:health:mute-reasons";
const CHANNEL_HEALTH_IDS: GatewayChannelId[] = ["telegram", "discord", "imessage", "slack"];
const CHANNEL_HEALTH_MUTE_REFRESH_MS = 60 * 1000;
const CHANNEL_HEAL_RESTART_THRESHOLD = 2;
const CHANNEL_HEAL_COOLDOWN_MS = 10 * 60 * 1000;
let lastCompactionAt = Date.now();
let lastProactiveCompactionAt = 0;
let lastProactiveCompactionUsagePercent = 0;
let sessionPressureAlertState = getInitialSessionPressureAlertState();
let channelHealthAlertState = getInitialChannelHealthAlertState();
let channelHealState: ChannelHealState = getInitialChannelHealState();
let channelHealthMuteState: {
  mutedChannels: GatewayChannelId[];
  muteReasons: Partial<Record<GatewayChannelId, string>>;
  lastCheckedAt: number;
} = {
  mutedChannels: [],
  muteReasons: {},
  lastCheckedAt: 0,
};
let channelHealthRefreshPromise: Promise<void> | null = null;
let channelHealthEvaluatePromise: Promise<void> | null = null;
let channelHealEvaluatePromise: Promise<void> | null = null;

// Initialize sessionCreatedAt and lastCompactionAt from session history.
// For resumed sessions, session age = earliest entry timestamp (not daemon restart time).
// This ensures the 24h guard fires correctly for sessions that span daemon restarts.
let sessionCreatedAt = Date.now();
{
  const initEntries = sessionManager.getEntries();

  // Session creation time = first entry's timestamp
  if (initEntries.length > 0) {
    const firstEntry = initEntries[0];
    const firstTs = (firstEntry as any)?.timestamp;
    if (typeof firstTs === "string") {
      const parsed = new Date(firstTs).getTime();
      if (!Number.isNaN(parsed)) {
        sessionCreatedAt = parsed;
      }
    }
  }

  // Last compaction time = most recent compaction entry
  for (let i = initEntries.length - 1; i >= 0; i--) {
    const entry = initEntries[i];
    if (entry?.type === "compaction") {
      const ts = (entry as any).timestamp;
      if (typeof ts === "string") {
        const parsed = new Date(ts).getTime();
        if (!Number.isNaN(parsed)) {
          lastCompactionAt = parsed;
          break;
        }
      }
    }
  }

  const compactionAge = Date.now() - lastCompactionAt;
  const sessionAge = Date.now() - sessionCreatedAt;
  console.log("[gateway] session lifecycle init", {
    sessionAge: `${Math.round(sessionAge / 3_600_000 * 10) / 10}h`,
    lastCompactionAge: `${Math.round(compactionAge / 60_000)}m`,
    sessionEntries: initEntries.length,
    resumed: hasExistingSession,
  });
}

setSession({
  // Use follow-up queueing to absorb brief streaming races safely.
  // Without this, pi throws "Agent is already processing" and watchdog can false-trigger.
  prompt: (text: string) => session.prompt(text, { streamingBehavior: "followUp" }),
  reload: () => session.reload(),
  compact: (instructions?: string) => session.compact(instructions),
  newSession: async (compressionSummary?: string) => {
    await session.newSession();
    if (compressionSummary) {
      // Inject the summary as the first user message so the agent has context
      console.log("[gateway] injecting compression summary into fresh session", {
        summaryLength: compressionSummary.length,
      });
      await session.prompt(compressionSummary);
    }
  },
});

// ── Context overflow recovery: build compression summary from dying session ──
function buildCompressionSummary(): string {
  const entries = sessionManager.getEntries();
  const recentUserMessages: string[] = [];
  let lastSource = "";

  // Walk backwards through entries to grab recent context
  for (let i = entries.length - 1; i >= 0 && recentUserMessages.length < 10; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg?.role || !msg.content) continue;

    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        : String(msg.content);
      if (text.length > 0 && text.length < 2000) {
        recentUserMessages.unshift(text.slice(0, 500));
      }
      // Capture source channel from channel header
      const sourceMatch = text.match(/Channel:\s*(\w+)/);
      if (sourceMatch && !lastSource) lastSource = sourceMatch[1];
    }

    // ADR-0235: skip assistant responses — stale triage contaminates fresh sessions
  }

  const parts = [
    "# Context Recovery — Previous Session Overflow",
    "",
    "The previous gateway session exceeded the model's context window and was automatically replaced.",
    "Below is a compression summary of recent activity to maintain continuity.",
    "",
  ];

  if (lastSource) {
    parts.push(`**Last active channel**: ${lastSource}`, "");
  }

  if (recentUserMessages.length > 0) {
    parts.push("## Recent inbound messages (newest last)", "");
    for (const msg of recentUserMessages.slice(-5)) {
      parts.push(`- ${msg.replace(/\n/g, " ").slice(0, 300)}`, "");
    }
  }

  // ADR-0235: Do NOT carry forward old assistant responses into new sessions.
  // They inject stale strategic triage that dominates fresh context.
  // The gateway gets live system state via on-demand context gathering instead.

  parts.push(
    "",
    "Resume normal operation. You are the joelclaw gateway agent.",
    "Answer questions from live system data (slog, OTEL, runs), not from old conversation history.",
    "If the user's last message was unanswered due to the overflow, it will be replayed next.",
  );

  return parts.join("\n");
}

onContextOverflowRecovery(async () => {
  const summary = buildCompressionSummary();
  const telegramUserId = process.env.TELEGRAM_USER_ID ?? "";

  console.log("[gateway] context overflow recovery triggered", {
    summaryLength: summary.length,
    recentEntries: sessionManager.getEntries().length,
  });

  // Alert Joel via Telegram
  if (telegramUserId) {
    const parsedTelegramUserId = parseChatId(`telegram:${telegramUserId}`);
    if (!parsedTelegramUserId) {
      console.error("[gateway] invalid TELEGRAM_USER_ID in overflow recovery handler", { telegramUserId });
      return summary;
    }
    const alertText = [
      "⚠️ <b>Gateway context overflow — auto-recovery</b>",
      "",
      "Session exceeded model context window. Compaction failed to reduce.",
      "Created fresh session with compression summary of recent activity.",
      "",
      `Previous session: ${sessionManager.getEntries().length} entries.`,
      "The failed message will be replayed into the new session.",
    ].join("\n");
    sendTelegram(parsedTelegramUserId, alertText, { silent: false }).catch((err) => {
      console.error("[gateway] failed to send overflow alert via Telegram", { err });
    });
  }

  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.context_overflow.recovery",
    success: true,
    metadata: {
      summaryLength: summary.length,
      previousEntries: sessionManager.getEntries().length,
    },
  });

  return summary;
});

onBeforePromptDispatch(async ({ source, prompt }) => {
  await ensurePromptFitsBudget(source, prompt);
});

// ── Model fallback controller (ADR-0091) ───────────────
const requestedPrimaryModel = modelRefToString(requestedPrimaryModelRef);
const resolvedPrimaryModel = getLiveSessionModelRef();
const actualPrimaryModel = modelRefToString(resolvedPrimaryModel);
if (!modelRefsEqual(resolvedPrimaryModel, requestedPrimaryModelRef)) {
  console.warn("[gateway] requested primary model resolved to active session model", {
    requested: requestedPrimaryModel,
    actual: actualPrimaryModel,
  });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon.inference",
    action: "model.resolved_to_active_session",
    success: true,
    metadata: {
      requested: requestedPrimaryModel,
      actual: actualPrimaryModel,
    },
  });
}

const configuredFallbackModel = `${startupGatewayConfig.fallbackProvider}/${startupGatewayConfig.fallbackModel}`;
const secondaryFallback = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
} as const;
const secondaryFallbackModel = `${secondaryFallback.provider}/${secondaryFallback.model}`;
if (configuredFallbackModel === actualPrimaryModel && actualPrimaryModel !== secondaryFallbackModel) {
  const hasSecondaryFallback = Boolean(getModel(secondaryFallback.provider as any, secondaryFallback.model as any));
  if (hasSecondaryFallback) {
    startupGatewayConfig.fallbackProvider = secondaryFallback.provider;
    startupGatewayConfig.fallbackModel = secondaryFallback.model;
    console.warn("[gateway:fallback] remapped identical fallback model", {
      from: configuredFallbackModel,
      to: secondaryFallbackModel,
      reason: "configured fallback must differ from active primary model",
    });
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.fallback",
      action: "fallback.model.remapped",
      success: true,
      metadata: {
        from: configuredFallbackModel,
        to: secondaryFallbackModel,
        reason: "configured fallback matched active primary model",
      },
    });
  }
}
const fallbackTelemetryAdapter: TelemetryEmitter = {
  emit(action: string, detail: string, extra?: Record<string, unknown>) {
    const metadata = extra ?? {};
    void emitGatewayOtel({
      level: typeof metadata.level === "string" ? (metadata.level as Parameters<typeof emitGatewayOtel>[0]["level"]) : "info",
      component: typeof metadata.component === "string" ? metadata.component : "daemon.fallback",
      action,
      success: typeof metadata.success === "boolean" ? metadata.success : true,
      duration_ms: typeof metadata.duration_ms === "number" ? metadata.duration_ms : undefined,
      error: typeof metadata.error === "string" ? metadata.error : detail,
      metadata: {
        ...metadata,
        detail,
      },
    });
  },
};

const fallbackController = new ModelFallbackController(
  startupGatewayConfig,
  resolvedPrimaryModel.provider,
  resolvedPrimaryModel.id,
  fallbackTelemetryAdapter,
);

const FALLBACK_OPERATOR_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
let lastFallbackOperatorAlertAt = 0;

function isGatewayQuietHours(): boolean {
  const pstString = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const pstHour = new Date(pstString).getHours();
  return pstHour >= 23 || pstHour < 7;
}

function shouldSendFallbackTelegramNotice(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const isActivation = trimmed.startsWith("⚠️ Gateway falling back to ");
  const isRecovery = trimmed.startsWith("✅ Gateway recovered to primary model:");

  if (!isActivation && !isRecovery) return false;
  if (isGatewayQuietHours()) return false;
  if (isRecovery) return false;

  const now = Date.now();
  if (now - lastFallbackOperatorAlertAt < FALLBACK_OPERATOR_NOTIFY_COOLDOWN_MS) {
    return false;
  }

  lastFallbackOperatorAlertAt = now;
  return true;
}

function shouldSendSessionPressureTelegramNotice(kind: "elevated" | "critical" | "recovered"): boolean {
  return kind === "critical";
}

function shouldSendSessionLifecycleTelegramNotice(kind: "recycled" | "rotated"): boolean {
  if (kind === "rotated") return !isGatewayQuietHours();
  return false;
}

function shouldSuppressDirectOperatorTelegramMessage(text: string, source: string | undefined): boolean {
  if (source) return false;
  if (!isGatewayQuietHours()) return false;

  const trimmed = text.trim();
  return trimmed.includes("Knowledge Watchdog Alert");
}

// Track prompt dispatch timing for stuck-session detection.
// If a turn is stuck for >10m, abort once, then restart daemon if no recovery
// signal (turn_end or next model turn start) arrives within grace window.
let _lastTurnEndAt = Date.now();
let _lastPromptAt = 0;
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STUCK_RECOVERY_GRACE_MS = 90_000;
type StuckRecoveryState = {
  startedAt: number;
  promptAt: number;
  deadlineAt: number;
};
let stuckRecovery: StuckRecoveryState | undefined;
type PendingPromptDispatch = {
  queuedAt: number;
  source?: string;
};
const pendingPromptDispatches: PendingPromptDispatch[] = [];
let turnInProgress = false;

function onModelTurnStart(trigger: "turn_start" | "message_start"): void {
  const pendingDispatch = pendingPromptDispatches.shift();
  if (!pendingDispatch) return;

  const now = Date.now();
  _lastPromptAt = now;
  fallbackController.onPromptDispatched();

  if (stuckRecovery) {
    const recoveredAfterMs = now - stuckRecovery.startedAt;
    console.warn("[gateway:watchdog] session recovered after stuck abort", {
      recoveredAfterMs,
    });
    void emitGatewayOtel({
      level: "info",
      component: "daemon.watchdog",
      action: "watchdog.session_stuck.recovered",
      success: true,
      metadata: {
        recoveredAfterMs,
        recoverySignal: trigger,
      },
    });
    stuckRecovery = undefined;
  }
}

// Some SDK event sequences can emit a late assistant segment after the active
// source has already been cleared. Keep a short-lived channel-source hint so
// those trailing segments still route back to the correct user channel.
let lastPromptSource: string | undefined;
let lastPromptSourceAt = 0;
const RESPONSE_SOURCE_RECOVERY_WINDOW_MS = 30_000;
onPrompt(() => {
  const now = Date.now();
  turnKnowledgeCounter += 1;
  turnKnowledgeText = "";
  turnKnowledgeToolCalls = [];
  turnKnowledgeToolErrors = 0;
  currentTurnToolCallCount = 0;
  currentTurnCheckpointSent = false;
  currentTurnToolHistory = [];
  pendingToolCalls.clear();

  // Start Telegram typing indicator + streaming if this prompt came from Telegram
  const source = getActiveSource();
  pendingPromptDispatches.push({ queuedAt: now, source });
  if (source) {
    // Pre-seed response source for turns where message_start arrives late.
    responseSource = source;
  }

  // Keep only channel-like sources for short-lived recovery.
  if (source?.includes(":")) {
    lastPromptSource = source;
    lastPromptSourceAt = now;
  }

  if (source?.startsWith("telegram:") && TELEGRAM_USER_ID) {
    const chatId = parseChatId(source) ?? TELEGRAM_USER_ID;
    const bot = getBot();
    if (bot && chatId) {
      telegramStream.begin({ chatId, bot });
    }
  }
});
const MODEL_FAILURE_ALERT_COOLDOWN_MS = 2 * 60 * 1000;
const modelFailureAlertLastSent = new Map<string, number>();

function classifyModelFailure(errorText: string):
  | "auth"
  | "missing-api-key"
  | "rate-limit"
  | "provider-overloaded"
  | "model-not-found"
  | "network"
  | undefined {
  const lower = errorText.toLowerCase();
  if (lower.includes("authentication failed")) return "auth";
  if (lower.includes("no api key found")) return "missing-api-key";
  if (lower.includes("rate_limit") || lower.includes("429")) return "rate-limit";
  if (lower.includes("overloaded") || lower.includes("529")) return "provider-overloaded";
  if (lower.includes("pi model not found")) return "model-not-found";
  if (lower.includes("network is unavailable")) return "network";
  return undefined;
}

function compactErrorForAlert(errorText: string, maxLength = 220): string {
  const compacted = errorText.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 1)}…`;
}

function getOperatorTraceIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const traceId = metadata?.operatorTraceId;
  return typeof traceId === "string" && traceId.length > 0 ? traceId : undefined;
}

function getOperatorCommandLabel(metadata: Record<string, unknown> | undefined): string {
  const command = metadata?.command;
  return typeof command === "string" && command.length > 0 ? `/${command}` : "operator command";
}

function buildOperatorTraceCompletionDetail(
  metadata: Record<string, unknown> | undefined,
  assistantText: string,
  toolCalls: string[],
): string {
  const commandLabel = getOperatorCommandLabel(metadata);
  const normalized = assistantText.replace(/\s+/g, " ").trim();
  if (normalized) {
    const preview = normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
    return `${commandLabel} completed — ${preview}`;
  }
  if (toolCalls.length > 0) {
    return `${commandLabel} completed after ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`;
  }
  return `${commandLabel} turn completed`;
}

async function pingModelFailure(event: QueueErrorEvent): Promise<void> {
  const reason = classifyModelFailure(event.error);
  if (!reason && event.consecutiveFailures < 3) return;

  const dedupeKey = `${reason ?? "generic"}:${event.source}`;
  const now = Date.now();
  const lastSent = modelFailureAlertLastSent.get(dedupeKey) ?? 0;
  if (now - lastSent < MODEL_FAILURE_ALERT_COOLDOWN_MS) {
    void emitGatewayOtel({
      level: "debug",
      component: "daemon.alerting",
      action: "model_failure.alert.suppressed",
      success: true,
      metadata: {
        dedupeKey,
        cooldownMs: MODEL_FAILURE_ALERT_COOLDOWN_MS,
        secondsUntilNext: Math.ceil((MODEL_FAILURE_ALERT_COOLDOWN_MS - (now - lastSent)) / 1000),
      },
    });
    return;
  }

  if (!TELEGRAM_TOKEN || !TELEGRAM_USER_ID) return;

  const fallback = `${startupGatewayConfig.fallbackProvider}/${startupGatewayConfig.fallbackModel}`;
  const lines = [
    "⚠️ Gateway model failure",
    `reason: ${reason ?? "unknown"}`,
    `source: ${event.source}`,
    `failures: ${event.consecutiveFailures}`,
    `fallback: ${fallback}`,
    `error: ${compactErrorForAlert(event.error)}`,
  ];

  try {
    await sendTelegram(TELEGRAM_USER_ID, lines.join("\n"), { silent: false });
    modelFailureAlertLastSent.set(dedupeKey, now);
    void emitGatewayOtel({
      level: "warn",
      component: "daemon.alerting",
      action: "model_failure.alert.sent",
      success: true,
      metadata: {
        reason: reason ?? "unknown",
        source: event.source,
        consecutiveFailures: event.consecutiveFailures,
        dedupeKey,
      },
    });
  } catch (error) {
    void emitGatewayOtel({
      level: "error",
      component: "daemon.alerting",
      action: "model_failure.alert.failed",
      success: false,
      error: String(error),
      metadata: {
        reason: reason ?? "unknown",
        source: event.source,
        dedupeKey,
      },
    });
  }
}

onQueueError((event) => {
  // Busy rejections mean the prompt did not start a model turn yet.
  // If no turn is currently active, clear any stale timeout watch.
  if (event.error.toLowerCase().includes("already processing") && !turnInProgress) {
    fallbackController.cancelTimeoutWatch();
  }

  const operatorTraceId = getOperatorTraceIdFromMetadata(event.metadata);
  if (operatorTraceId) {
    failOperatorTrace(
      operatorTraceId,
      event.error,
      `${getOperatorCommandLabel(event.metadata)} failed before downstream completion`,
    );
  }

  void fallbackController.onPromptError(event.consecutiveFailures);
  void pingModelFailure(event);
});

onSupersession(async (event) => {
  console.warn("[gateway:supersession] newer human turn superseded active work", {
    source: event.source,
    supersessionKey: event.supersessionKey,
    droppedQueued: event.droppedQueued,
    activeRequestId: event.activeRequestId,
  });

  const activeMetadata = getActiveRequestMetadata();
  const operatorTraceId = getOperatorTraceIdFromMetadata(activeMetadata);
  if (operatorTraceId) {
    failOperatorTrace(
      operatorTraceId,
      "superseded_by_newer_human_turn",
      `${getOperatorCommandLabel(activeMetadata)} superseded by a newer human turn`,
    );
  }

  fallbackController.cancelTimeoutWatch();
  responseChunks = [];
  telegramStream.abort();

  void emitGatewayOtel({
    level: "info",
    component: "daemon.supersession",
    action: "supersession.requested",
    success: true,
    metadata: {
      source: event.source,
      supersessionKey: event.supersessionKey,
      droppedQueued: event.droppedQueued,
      activeRequestId: event.activeRequestId ?? null,
    },
  });

  void maybeNotifySupersessionSource(event.source);

  try {
    await session.abort();
    void emitGatewayOtel({
      level: "info",
      component: "daemon.supersession",
      action: "supersession.abort_requested",
      success: true,
      metadata: {
        source: event.source,
        supersessionKey: event.supersessionKey,
        activeRequestId: event.activeRequestId ?? null,
      },
    });
  } catch (error) {
    console.error("[gateway:supersession] abort failed", {
      source: event.source,
      error: String(error),
    });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.supersession",
      action: "supersession.abort_failed",
      success: false,
      error: String(error),
      metadata: {
        source: event.source,
        supersessionKey: event.supersessionKey,
        activeRequestId: event.activeRequestId ?? null,
      },
    });
  }
});

// ── Idle waiter: gate drain loop on turn_end ───────────
// session.prompt() resolves when the message is queued, not when the
// full turn finishes. The drain loop needs to wait for turn_end before
// dispatching the next message, otherwise back-to-back prompts race.
let _idleResolve: (() => void) | undefined;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety valve

setIdleWaiter(() => {
  return new Promise<void>((resolve) => {
    _idleResolve = resolve;
    const idleWaitStartedAt = Date.now();

    const scheduleIdleTimeout = (delayMs: number) => {
      const timer = setTimeout(() => {
        if (_idleResolve !== resolve) {
          return;
        }

        const now = Date.now();
        const promptAgeMs = _lastPromptAt > 0 ? now - _lastPromptAt : 0;
        const waitElapsedMs = now - idleWaitStartedAt;
        const maintenance = activeGatewayMaintenance;
        const maintenanceActive = isGatewayMaintenanceActive();

        if (maintenanceActive && waitElapsedMs < IDLE_TIMEOUT_MAINTENANCE_MAX_MS) {
          console.warn("[gateway] idle waiter extended for active maintenance", {
            nextDelayMs: IDLE_TIMEOUT_MAINTENANCE_EXTENSION_MS,
            waitElapsedMs,
            promptAgeMs,
            maintenanceKind: maintenance?.kind ?? (session.isCompacting ? "compact" : "unknown"),
            maintenanceReason: maintenance?.reason ?? (session.isCompacting ? "session_compacting" : "unknown"),
          });
          void emitGatewayOtel({
            level: "info",
            component: "daemon.watchdog",
            action: "watchdog.idle_waiter.extended_for_maintenance",
            success: true,
            metadata: {
              nextDelayMs: IDLE_TIMEOUT_MAINTENANCE_EXTENSION_MS,
              waitElapsedMs,
              promptAgeMs,
              queueDepth: getQueueDepth(),
              maintenanceKind: maintenance?.kind ?? (session.isCompacting ? "compact" : "unknown"),
              maintenanceReason: maintenance?.reason ?? (session.isCompacting ? "session_compacting" : "unknown"),
            },
          });
          scheduleIdleTimeout(IDLE_TIMEOUT_MAINTENANCE_EXTENSION_MS);
          return;
        }

        console.warn("[gateway] idle waiter timed out — releasing drain lock", {
          timeoutMs: delayMs,
          promptAgeMs,
          waitElapsedMs,
          maintenanceActive,
        });
        void emitGatewayOtel({
          level: "warn",
          component: "daemon.watchdog",
          action: "watchdog.idle_waiter.timeout",
          success: false,
          metadata: {
            timeoutMs: delayMs,
            waitElapsedMs,
            promptAgeMs,
            queueDepth: getQueueDepth(),
            maintenanceActive,
            maintenanceKind: maintenance?.kind ?? (session.isCompacting ? "compact" : undefined),
            maintenanceReason: maintenance?.reason ?? (session.isCompacting ? "session_compacting" : undefined),
          },
        });

        _lastTurnEndAt = Math.max(_lastTurnEndAt, now);

        if (stuckRecovery) {
          const recoveredAfterMs = now - stuckRecovery.startedAt;
          console.warn("[gateway:watchdog] session recovered after idle timeout release", {
            recoveredAfterMs,
          });
          void emitGatewayOtel({
            level: "info",
            component: "daemon.watchdog",
            action: "watchdog.session_stuck.recovered",
            success: true,
            metadata: {
              recoveredAfterMs,
              recoverySignal: "idle_waiter_timeout",
            },
          });
          stuckRecovery = undefined;
        }

        _idleResolve = undefined;
        resolve();
      }, delayMs);
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    };

    // Safety timeout — if turn_end never fires (e.g. API hang),
    // don't block the drain loop forever. Active maintenance gets bounded
    // extensions so real compaction/rotation work is treated as busy, not dead.
    scheduleIdleTimeout(IDLE_TIMEOUT_MS);
  });
});

// ── Config ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_ALLOWED_USER_ID = process.env.DISCORD_ALLOWED_USER_ID;
const IMESSAGE_ALLOWED_SENDER = process.env.IMESSAGE_ALLOWED_SENDER;
const SLACK_ALLOWED_USER_ID = process.env.SLACK_ALLOWED_USER_ID;
const SLACK_DEFAULT_CHANNEL_ID = process.env.SLACK_DEFAULT_CHANNEL_ID;
const channelInfo = {
  redis: true,
  console: true,
  telegram: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
  discord: Boolean(DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID),
  imessage: Boolean(IMESSAGE_ALLOWED_SENDER),
  slack: false,
};

registerChannel("console", {
  send: async (message, context) => {
    const envelope = normalizeOutboundMessage(message);
    const source = context?.source;
    const sourceKind = getSourceKind(source);
    const attribution = context?.attribution;
    const relayText = normalizeOperatorRelayText(source, envelope.text);
    if (!relayText) return;
    const relayEnvelope = relayText === envelope.text
      ? envelope
      : {
          ...envelope,
          text: relayText,
        };

    if (!TELEGRAM_TOKEN || !TELEGRAM_USER_ID) {
      void emitGatewayOtel({
        level: "debug",
        component: "daemon.outbound",
        action: "outbound.console_forward.skipped",
        success: true,
        metadata: {
          reason: "no-telegram-config",
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
        },
      });
      return;
    }

    if (source?.startsWith("telegram:")) {
      void emitGatewayOtel({
        level: "debug",
        component: "daemon.outbound",
        action: "outbound.console_forward.skipped",
        success: true,
        metadata: {
          reason: "source-is-telegram",
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
        },
      });
      return;
    }

    if (shouldSuppressConsoleForwardByPolicy(sourceKind, attribution)) {
      void emitGatewayOtel({
        level: "info",
        component: "daemon.outbound",
        action: "outbound.console_forward.suppressed_policy",
        success: true,
        metadata: {
          reason: "background-internal-no-source-context",
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
          backgroundSource: attribution?.backgroundSource,
          hasActiveSource: attribution?.hasActiveSource,
          hasCapturedSource: attribution?.hasCapturedSource,
          recoveredFromRecentPrompt: attribution?.recoveredFromRecentPrompt,
          recentPromptSourceAgeMs: attribution?.recentPromptSourceAgeMs,
        },
      });
      return;
    }

    if (!shouldForwardToTelegram(relayEnvelope.text)) {
      void emitGatewayOtel({
        level: "debug",
        component: "daemon.outbound",
        action: "outbound.console_forward.skipped",
        success: true,
        metadata: {
          reason: "filtered-by-forward-rule",
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
        },
      });
      return;
    }

    void emitGatewayOtel({
      level: "info",
      component: "daemon.outbound",
      action: "outbound.console_forward.attempt",
      success: true,
      metadata: {
        source,
        sourceKind,
        textLength: relayEnvelope.text.length,
      },
    });

    try {
      await sendTelegram(TELEGRAM_USER_ID, relayEnvelope.text, {
        buttons: relayEnvelope.buttons,
        silent: relayEnvelope.silent,
        replyTo: typeof relayEnvelope.replyTo === "string" ? Number.parseInt(relayEnvelope.replyTo, 10) : relayEnvelope.replyTo,
      });
      void emitGatewayOtel({
        level: "info",
        component: "daemon.outbound",
        action: "outbound.console_forward.sent",
        success: true,
        metadata: {
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
        },
      });
    } catch (error) {
      const errorMessage = String(error);
      console.error("[gateway] telegram notification failed", { error: errorMessage });
      void emitGatewayOtel({
        level: "error",
        component: "daemon.outbound",
        action: "outbound.console_forward.failed",
        success: false,
        error: errorMessage,
        metadata: {
          source,
          sourceKind,
          textLength: relayEnvelope.text.length,
        },
      });
    }
  },
});

if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  registerChannel("telegram", {
    send: async (message, context) => {
      const envelope = normalizeOutboundMessage(message);
      const chatId = context?.source ? parseChatId(context.source) ?? TELEGRAM_USER_ID : TELEGRAM_USER_ID;
      console.log("[gateway:telegram] outbound send", {
        chatId,
        textLength: envelope.text.length,
        source: context?.source,
        hasButtons: !!envelope.buttons,
      });
      if (!chatId) return;

      if (shouldSuppressDirectOperatorTelegramMessage(envelope.text, context?.source)) {
        console.log("[gateway:telegram] outbound operator message suppressed by policy", {
          chatId,
          source: context?.source,
          preview: envelope.text.trim().slice(0, 80),
        });
        return;
      }

      try {
        await sendTelegram(chatId, envelope.text, {
          buttons: envelope.buttons,
          silent: envelope.silent,
          replyTo: typeof envelope.replyTo === "string" ? Number.parseInt(envelope.replyTo, 10) : envelope.replyTo,
        });
        console.log("[gateway:telegram] message sent successfully", { chatId });
      } catch (error) {
        console.error("[gateway] telegram send failed", { error: String(error) });
      }
    },
  });
} else {
  console.warn("[gateway] telegram channel NOT registered", {
    hasToken: !!TELEGRAM_TOKEN,
    hasUserId: !!TELEGRAM_USER_ID,
  });
}

type WsServerMessage =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; toolName: string; input: unknown }
  | { type: "tool_result"; id: string; toolName: string; content: unknown; isError?: boolean }
  | { type: "turn_end" }
  | { type: "status"; data: Record<string, unknown> }
  | { type: "error"; message: string };

type WsClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "status" };
// ── Outbound: collect assistant responses and route to source channel ──
let responseChunks: string[] = [];
let responseSource: string | undefined;
let turnKnowledgeCounter = 0;
let turnKnowledgeText = "";
let turnKnowledgeToolCalls: string[] = [];
let turnKnowledgeToolErrors = 0;
let lastTurnKnowledgeFingerprint: string | undefined;
const wsClients = new Set<Bun.ServerWebSocket<unknown>>();

function captureResponseSource(): string | undefined {
  const active = getActiveSource();
  if (typeof active === "string" && active.length > 0) {
    responseSource = active;
  }
  return responseSource;
}

const PROMPT_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const PROMPT_BUDGET_COMPACT_HEADROOM_TOKENS = 32_000;
const PROMPT_BUDGET_ROTATE_HEADROOM_TOKENS = 12_000;
const CONTEXT_COMPACT_THRESHOLD_PERCENT = 65;
const CONTEXT_ROTATE_THRESHOLD_PERCENT = 75;

function getDegradedCapabilities(): Array<{ key: string; reason: string }> {
  const redisState = getRedisRuntimeState();
  if (redisState.mode === "normal") return [];

  const capabilities = [
    {
      key: "redis_event_bridge",
      reason: "Redis pub/sub ingress is unavailable; direct channel conversation stays online.",
    },
    {
      key: "message_replay",
      reason: "Redis-backed replay and durable stream recovery are unavailable until Redis reconnects.",
    },
    {
      key: "redis_operational_commands",
      reason: "Queue inspection and mutation commands that depend on Redis return degraded data only.",
    },
  ];

  if (channelInfo.telegram) {
    capabilities.push({
      key: "telegram_poll_owner_lease",
      reason: "Telegram poll-owner durability falls back to direct polling/backoff without Redis lease coordination.",
    });
  }

  return capabilities;
}

function getSessionPressure(): ReturnType<typeof buildSessionPressureSnapshot> & {
  alerting: {
    lastNotifiedHealth: string;
    lastNotifiedAt: string | null;
    lastRecoveredAt: string | null;
    cooldownMs: number;
  };
} {
  const entries = sessionManager.getEntries();
  const lastUsage = getLastAssistantUsage(entries);
  const contextTokens = lastUsage ? calculateContextTokens(lastUsage) : 0;
  const modelContextWindow = getCurrentModelContextWindow();
  const threadIndex = buildThreadIndex();

  return {
    ...buildSessionPressureSnapshot({
      entries: entries.length,
      estimatedTokens: contextTokens,
      maxTokens: modelContextWindow,
      lastCompactionAtMs: lastCompactionAt,
      sessionCreatedAtMs: sessionCreatedAt,
      compactAtPercent: CONTEXT_COMPACT_THRESHOLD_PERCENT,
      rotateAtPercent: CONTEXT_ROTATE_THRESHOLD_PERCENT,
      maxCompactionGapMs: MAX_COMPACTION_GAP_MS,
      maxSessionAgeMs: MAX_SESSION_AGE_MS,
      queueDepth: getQueueDepth(),
      activeThreads: threadIndex.activeCount,
      warmThreads: threadIndex.warmCount,
      totalThreads: threadIndex.threads.length,
      consecutivePromptFailures: getConsecutiveFailures(),
      fallbackActive: fallbackController.state.active,
      fallbackActivationCount: fallbackController.state.activationCount,
    }),
    alerting: {
      lastNotifiedHealth: sessionPressureAlertState.lastNotifiedHealth,
      lastNotifiedAt: sessionPressureAlertState.lastNotifiedAt > 0
        ? new Date(sessionPressureAlertState.lastNotifiedAt).toISOString()
        : null,
      lastRecoveredAt: sessionPressureAlertState.lastRecoveredAt > 0
        ? new Date(sessionPressureAlertState.lastRecoveredAt).toISOString()
        : null,
      cooldownMs: SESSION_PRESSURE_ALERT_COOLDOWN_MS,
    },
  };
}

function formatPressureReason(reason: string): string {
  switch (reason) {
    case "context_usage":
      return "context crossed compaction threshold";
    case "context_ceiling":
      return "context crossed rotation threshold";
    case "compaction_gap":
      return "compaction overdue";
    case "session_age":
      return "session age over rotation threshold";
    default:
      return reason;
  }
}

function formatPressureDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / PROMPT_TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

let promptBudgetMaintenance: Promise<void> | null = null;
const IDLE_TIMEOUT_MAINTENANCE_EXTENSION_MS = 60_000;
const IDLE_TIMEOUT_MAINTENANCE_MAX_MS = 15 * 60 * 1000;

type GatewayMaintenanceKind = "compact" | "rotate";
type GatewayMaintenanceReason =
  | "prompt_budget"
  | "context_ceiling"
  | "context_elevated"
  | "compaction_gap"
  | "session_age";

type GatewayMaintenanceState = {
  kind: GatewayMaintenanceKind;
  reason: GatewayMaintenanceReason;
  startedAt: number;
  source?: string;
  promptTokens?: number;
  projectedTokens?: number;
  modelContextWindow?: number;
  contextTokens?: number;
  usagePercent?: number;
};

let activeGatewayMaintenance: GatewayMaintenanceState | undefined;

function isGatewayMaintenanceActive(): boolean {
  return Boolean(activeGatewayMaintenance) || session.isCompacting;
}

async function runGatewayMaintenance<T>(
  state: Omit<GatewayMaintenanceState, "startedAt">,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const previousMaintenance = activeGatewayMaintenance;
  activeGatewayMaintenance = {
    ...state,
    startedAt,
  };

  void emitGatewayOtel({
    level: "info",
    component: "daemon",
    action: "daemon.maintenance.started",
    success: true,
    metadata: {
      kind: state.kind,
      reason: state.reason,
      source: state.source,
      promptTokens: state.promptTokens,
      projectedTokens: state.projectedTokens,
      modelContextWindow: state.modelContextWindow,
      contextTokens: state.contextTokens,
      usagePercent: state.usagePercent,
    },
  });

  fallbackController.pauseTimeoutWatch();
  try {
    const result = await run();
    void emitGatewayOtel({
      level: "info",
      component: "daemon",
      action: "daemon.maintenance.completed",
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        kind: state.kind,
        reason: state.reason,
        source: state.source,
        promptTokens: state.promptTokens,
        projectedTokens: state.projectedTokens,
        modelContextWindow: state.modelContextWindow,
        contextTokens: state.contextTokens,
        usagePercent: state.usagePercent,
      },
    });
    return result;
  } catch (error) {
    void emitGatewayOtel({
      level: "warn",
      component: "daemon",
      action: "daemon.maintenance.failed",
      success: false,
      error: String(error),
      duration_ms: Date.now() - startedAt,
      metadata: {
        kind: state.kind,
        reason: state.reason,
        source: state.source,
        promptTokens: state.promptTokens,
        projectedTokens: state.projectedTokens,
        modelContextWindow: state.modelContextWindow,
        contextTokens: state.contextTokens,
        usagePercent: state.usagePercent,
      },
    });
    throw error;
  } finally {
    activeGatewayMaintenance = previousMaintenance;
    fallbackController.resumeTimeoutWatch();
  }
}

async function compactSessionForPromptBudget(source: string, promptTokens: number, projectedTokens: number, modelContextWindow: number): Promise<void> {
  if (session.isCompacting) return;

  console.warn("[gateway:budget] projected prompt would push session near context ceiling — compacting first", {
    source,
    promptTokens,
    projectedTokens,
    modelContextWindow,
  });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.prompt_budget.preemptive_compact",
    success: true,
    metadata: {
      source,
      promptTokens,
      projectedTokens,
      modelContextWindow,
    },
  });

  await runGatewayMaintenance(
    {
      kind: "compact",
      reason: "prompt_budget",
      source,
      promptTokens,
      projectedTokens,
      modelContextWindow,
    },
    async () => {
      await session.compact(
        `Incoming prompt budget check projected ${projectedTokens}/${modelContextWindow} tokens. `
        + "Aggressively summarize stale context before dispatch. Keep only essential recent context and active thread state.",
      );
      lastCompactionAt = Date.now();
    },
  );
}

async function rotateSessionForPromptBudget(
  source: string,
  promptTokens: number,
  projectedTokens: number,
  modelContextWindow: number,
  reason: "projected_overflow" | "session_age",
): Promise<void> {
  console.warn("[gateway:budget] projected prompt budget requires fresh session", {
    source,
    promptTokens,
    projectedTokens,
    modelContextWindow,
    reason,
  });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.prompt_budget.preemptive_rotate",
    success: true,
    metadata: {
      source,
      promptTokens,
      projectedTokens,
      modelContextWindow,
      reason,
    },
  });

  const summary = buildCompressionSummary();
  await runGatewayMaintenance(
    {
      kind: "rotate",
      reason: "prompt_budget",
      source,
      promptTokens,
      projectedTokens,
      modelContextWindow,
    },
    async () => {
      sessionCreatedAt = Date.now();
      lastCompactionAt = Date.now();
      await session.newSession();
      if (summary) {
        await session.prompt(summary, { streamingBehavior: "followUp" });
      }
    },
  );
}

async function ensurePromptFitsBudget(source: string, prompt: string): Promise<void> {
  if (promptBudgetMaintenance) {
    await promptBudgetMaintenance;
  }

  let maintenancePromise: Promise<void> | null = null;
  maintenancePromise = (async () => {
    const snapshot = getSessionPressure();
    const modelContextWindow = getCurrentModelContextWindow();
    const promptTokens = estimatePromptTokens(prompt);
    const projectedTokens = snapshot.estimatedTokens + promptTokens;
    const shouldRotateForAge = snapshot.sessionAgeMs > MAX_SESSION_AGE_MS;
    const shouldRotateForProjectedOverflow = projectedTokens >= modelContextWindow - PROMPT_BUDGET_ROTATE_HEADROOM_TOKENS;
    const shouldCompact = projectedTokens >= modelContextWindow - PROMPT_BUDGET_COMPACT_HEADROOM_TOKENS;

    if (shouldRotateForAge || shouldRotateForProjectedOverflow) {
      await rotateSessionForPromptBudget(
        source,
        promptTokens,
        projectedTokens,
        modelContextWindow,
        shouldRotateForAge ? "session_age" : "projected_overflow",
      );
      return;
    }

    if (shouldCompact) {
      await compactSessionForPromptBudget(source, promptTokens, projectedTokens, modelContextWindow);
    }
  })().finally(() => {
    if (promptBudgetMaintenance === maintenancePromise) {
      promptBudgetMaintenance = null;
    }
  });

  promptBudgetMaintenance = maintenancePromise;
  await maintenancePromise;
}

async function maybeRunIdleGatewayMaintenance(): Promise<void> {
  const waitingForTurnEnd = Boolean(_idleResolve);
  const maintenanceActive = isGatewayMaintenanceActive();
  const queueDepth = getQueueDepth();
  const snapshot = getSessionPressure();
  const decision = decideIdleGatewayMaintenance({
    waitingForTurnEnd,
    maintenanceActive,
    queueDepth,
    promptBudgetMaintenanceActive: Boolean(promptBudgetMaintenance),
    sessionPressure: {
      nextAction: snapshot.nextAction,
      reasons: snapshot.reasons,
    },
  });

  if (!decision) return;

  if (decision.kind === "rotate") {
    console.warn("[gateway:watchdog] idle session pressure triggered autonomous rotation", {
      reasons: snapshot.reasons,
      sessionAgeMs: snapshot.sessionAgeMs,
      lastCompactionAgeMs: snapshot.lastCompactionAgeMs,
      queueDepth,
    });

    const summary = buildCompressionSummary();
    await runGatewayMaintenance(
      {
        kind: "rotate",
        reason: decision.reason,
        source: "watchdog",
        contextTokens: snapshot.estimatedTokens,
        usagePercent: snapshot.usagePercent,
        modelContextWindow: snapshot.maxTokens,
      },
      async () => {
        sessionCreatedAt = Date.now();
        lastCompactionAt = Date.now();
        await session.newSession();
        lastProactiveCompactionAt = 0;
        lastProactiveCompactionUsagePercent = 0;
        if (summary) {
          await session.prompt(summary, { streamingBehavior: "followUp" });
        }
      },
    );
    return;
  }

  console.warn("[gateway:watchdog] idle session pressure triggered autonomous compaction", {
    reasons: snapshot.reasons,
    sessionAgeMs: snapshot.sessionAgeMs,
    lastCompactionAgeMs: snapshot.lastCompactionAgeMs,
    queueDepth,
  });

  await runGatewayMaintenance(
    {
      kind: "compact",
      reason: decision.reason,
      source: "watchdog",
      contextTokens: snapshot.estimatedTokens,
      usagePercent: snapshot.usagePercent,
      modelContextWindow: snapshot.maxTokens,
    },
    async () => {
      await session.compact(
        "Idle gateway session crossed the compaction gap threshold with no turns in flight. "
        + "Aggressively summarize stale context, preserve only essential recent context and active thread state, and keep the session ready for the next inbound turn.",
      );
      lastCompactionAt = Date.now();
      lastProactiveCompactionAt = lastCompactionAt;
      lastProactiveCompactionUsagePercent = snapshot.usagePercent;
    },
  );
}

function buildSessionPressureAlertMessage(
  kind: "elevated" | "critical" | "recovered",
  snapshot: ReturnType<typeof getSessionPressure>,
): string {
  if (kind === "recovered") {
    return [
      "✅ <b>Gateway session pressure recovered</b>",
      "",
      `Context back to <code>${snapshot.usagePercent}%</code> and next action is <code>${escapeHtml(snapshot.nextAction)}</code>.`,
      `Next threshold: <code>${escapeHtml(snapshot.nextThresholdSummary)}</code>.`,
      `Threads: <code>${snapshot.activeThreads}</code> active / <code>${snapshot.warmThreads}</code> warm / <code>${snapshot.totalThreads}</code> total.`,
    ].join("\n");
  }

  const icon = kind === "critical" ? "🚨" : "⚠️";
  const signals = snapshot.reasons.length > 0
    ? snapshot.reasons.map((reason) => escapeHtml(formatPressureReason(reason))).join(", ")
    : "context pressure rising";
  const fallbackState = snapshot.fallbackActive ? "active" : "inactive";

  return [
    `${icon} <b>Gateway session pressure ${kind}</b>`,
    "",
    `Context: <code>${snapshot.usagePercent}%</code> (${snapshot.estimatedTokens}/${snapshot.maxTokens} tokens)`,
    `Compaction age: <code>${formatPressureDuration(snapshot.lastCompactionAgeMs)}</code> · Session age: <code>${formatPressureDuration(snapshot.sessionAgeMs)}</code>`,
    `Threads: <code>${snapshot.activeThreads}</code> active / <code>${snapshot.warmThreads}</code> warm / <code>${snapshot.totalThreads}</code> total`,
    `Fallback: <code>${fallbackState}</code> · Activations: <code>${snapshot.fallbackActivationCount}</code> · Consecutive failures: <code>${snapshot.consecutivePromptFailures}</code>`,
    `Action now: <code>${escapeHtml(snapshot.nextAction)}</code> · Next threshold: <code>${escapeHtml(snapshot.nextThresholdSummary)}</code>`,
    `Signals: <code>${signals}</code>`,
  ].join("\n");
}

async function maybeNotifySessionPressure(snapshot: ReturnType<typeof getSessionPressure>): Promise<void> {
  const decision = evaluateSessionPressureAlert(
    { health: snapshot.health },
    sessionPressureAlertState,
    Date.now(),
    SESSION_PRESSURE_ALERT_COOLDOWN_MS,
  );

  sessionPressureAlertState = decision.nextState;
  if (!decision.shouldNotify || decision.kind === "none") return;

  const kind = decision.kind;
  const metadata = {
    kind,
    usagePercent: snapshot.usagePercent,
    estimatedTokens: snapshot.estimatedTokens,
    maxTokens: snapshot.maxTokens,
    lastCompactionAgeMs: snapshot.lastCompactionAgeMs,
    sessionAgeMs: snapshot.sessionAgeMs,
    nextAction: snapshot.nextAction,
    nextThresholdAction: snapshot.nextThresholdAction,
    nextThresholdSummary: snapshot.nextThresholdSummary,
    reasons: snapshot.reasons,
    queueDepth: snapshot.queueDepth,
    activeThreads: snapshot.activeThreads,
    warmThreads: snapshot.warmThreads,
    totalThreads: snapshot.totalThreads,
    fallbackActive: snapshot.fallbackActive,
    fallbackActivationCount: snapshot.fallbackActivationCount,
    consecutivePromptFailures: snapshot.consecutivePromptFailures,
  };

  const alertKind = kind === "recovered"
    ? "recovered"
    : kind === "critical"
      ? "critical"
      : "elevated";
  const message = buildSessionPressureAlertMessage(alertKind, snapshot);
  const silent = alertKind !== "critical";
  const shouldSendTelegram = Boolean(TELEGRAM_USER_ID) && shouldSendSessionPressureTelegramNotice(alertKind);

  if (!shouldSendTelegram) {
    void emitGatewayOtel({
      level: kind === "critical" ? "warn" : "info",
      component: "daemon.session-pressure",
      action: "session_pressure.alert.suppressed",
      success: true,
      metadata: {
        ...metadata,
        reason: TELEGRAM_USER_ID ? "policy" : "no_telegram_user",
      },
    });
    return;
  }

  try {
    await sendTelegram(TELEGRAM_USER_ID, message, { silent });
    void emitGatewayOtel({
      level: kind === "critical" ? "warn" : "info",
      component: "daemon.session-pressure",
      action: "session_pressure.alert.sent",
      success: true,
      metadata,
    });
  } catch (error) {
    console.error("[gateway:session-pressure] alert send failed", { error: String(error), kind });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.session-pressure",
      action: "session_pressure.alert.failed",
      success: false,
      error: String(error),
      metadata,
    });
  }
}

function normalizeGatewayChannelId(value: unknown): GatewayChannelId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CHANNEL_HEALTH_IDS.includes(normalized as GatewayChannelId)
    ? normalized as GatewayChannelId
    : null;
}

function parseMutedChannelIds(raw: string | null): GatewayChannelId[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<GatewayChannelId>();
    for (const value of parsed) {
      const channel = normalizeGatewayChannelId(value);
      if (channel) seen.add(channel);
    }
    return CHANNEL_HEALTH_IDS.filter((channel) => seen.has(channel));
  } catch {
    return [];
  }
}

function parseMutedChannelReasons(raw: string | null): Partial<Record<GatewayChannelId, string>> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const reasons: Partial<Record<GatewayChannelId, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const channel = normalizeGatewayChannelId(key);
      if (!channel || typeof value !== "string") continue;
      const reason = value.trim();
      if (!reason) continue;
      reasons[channel] = reason;
    }
    return reasons;
  } catch {
    return {};
  }
}

async function maybeRefreshChannelHealthMuteState(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - channelHealthMuteState.lastCheckedAt < CHANNEL_HEALTH_MUTE_REFRESH_MS) {
    return;
  }
  if (channelHealthRefreshPromise) {
    return channelHealthRefreshPromise;
  }

  channelHealthRefreshPromise = (async () => {
    channelHealthMuteState = {
      ...channelHealthMuteState,
      lastCheckedAt: now,
    };

    const redis = getRedisClient();
    if (!redis) return;

    try {
      const [mutedRaw, reasonsRaw] = await redis.mget(
        GATEWAY_HEALTH_MUTED_CHANNELS_KEY,
        GATEWAY_HEALTH_MUTE_REASONS_KEY,
      );

      channelHealthMuteState = {
        mutedChannels: parseMutedChannelIds(mutedRaw ?? null),
        muteReasons: parseMutedChannelReasons(reasonsRaw ?? null),
        lastCheckedAt: now,
      };
    } catch (error) {
      console.warn("[gateway:channel-health] failed to refresh muted channel state", {
        error: String(error),
      });
    }
  })();

  try {
    await channelHealthRefreshPromise;
  } finally {
    channelHealthRefreshPromise = null;
  }
}

type TelegramHealPolicy = {
  policy: "restart" | "manual" | "none";
  reason: string | null;
  manualRepairSummary: string | null;
  manualRepairCommands: string[];
};

function isTelegramPollRetrying(channel: Record<string, unknown>): boolean {
  const pollingActive = channel.pollingActive === true;
  const pollingStarting = channel.pollingStarting === true;
  const retryAttempts = typeof channel.retryAttempts === "number" ? channel.retryAttempts : 0;
  return !pollingActive && !pollingStarting && retryAttempts > 0;
}

function getTelegramManualRepairCommands(): string[] {
  return [
    "joelclaw gateway diagnose --hours 1 --lines 50",
    "joelclaw gateway restart",
  ];
}

function getKnownIssueManualRepairCommands(channel: GatewayChannelId): string[] {
  const commands = [
    "joelclaw gateway diagnose --hours 1 --lines 50",
    "joelclaw gateway known-issues",
    "joelclaw gateway restart",
    `joelclaw gateway unmute ${channel}`,
  ];

  if (channel === "imessage") {
    return ["open /Applications/imsg-rpc.app", ...commands];
  }

  return commands;
}

function describeTelegramChannelHealth(channel: Record<string, unknown>): string {
  const ownerState = typeof channel.ownerState === "string" ? channel.ownerState : undefined;
  const leaseEnabled = channel.leaseEnabled === true;
  const retryAttempts = typeof channel.retryAttempts === "number" ? channel.retryAttempts : 0;
  const conflictStreak = typeof channel.conflictStreak === "number" ? channel.conflictStreak : 0;
  const retrying = isTelegramPollRetrying(channel);

  const suffix = retryAttempts > 0 || conflictStreak > 0
    ? ` (retries ${retryAttempts}, conflicts ${conflictStreak})`
    : "";

  if (retrying && conflictStreak > 0) {
    return `polling blocked by Bot API conflicts${suffix}`;
  }

  if (retrying) {
    return `polling retry scheduled${suffix}`;
  }

  switch (ownerState) {
    case "owner":
      return `poll owner active${suffix}`;
    case "passive":
      return `passive poll follower${suffix}`;
    case "fallback":
      return leaseEnabled
        ? `fallback polling with lease enabled${suffix}`
        : `fallback polling (lease disabled)${suffix}`;
    case "stopped":
      return `polling stopped${suffix}`;
    default:
      return channel.healthy === true ? `healthy${suffix}` : `degraded${suffix}`;
  }
}

function describeDiscordChannelHealth(channel: Record<string, unknown>): string {
  return channel.ready === true ? "gateway client ready" : "gateway client not ready";
}

function describeIMessageChannelHealth(channel: Record<string, unknown>): string {
  const reconnectAttempts = typeof channel.reconnectAttempts === "number" ? channel.reconnectAttempts : 0;
  const healing = channel.healing === true;
  const suffix = reconnectAttempts > 0 || healing
    ? ` (reconnect attempts ${reconnectAttempts}${healing ? ", healing" : ""})`
    : "";
  return channel.connected === true ? `socket connected${suffix}` : `socket disconnected${suffix}`;
}

function describeSlackChannelHealth(channel: Record<string, unknown>): string {
  return channel.connected === true ? "socket connected" : "socket not connected";
}

function getTelegramHealPolicy(channel: Record<string, unknown>): TelegramHealPolicy {
  const ownerState = typeof channel.ownerState === "string" ? channel.ownerState : undefined;
  const leaseEnabled = channel.leaseEnabled === true;
  const started = channel.started === true;
  const healthy = channel.healthy === true;
  const conflictStreak = typeof channel.conflictStreak === "number" ? channel.conflictStreak : 0;
  const retrying = isTelegramPollRetrying(channel);

  if (!channelInfo.telegram) {
    return { policy: "none", reason: null, manualRepairSummary: null, manualRepairCommands: [] };
  }

  if (ownerState === "passive") {
    return {
      policy: "manual",
      reason: "Telegram poll ownership is passive; investigate competing bot instances or lease coordination.",
      manualRepairSummary: "Leave only one long-polling gateway instance active, or restore Redis poll lease coordination before relying on Telegram ingress.",
      manualRepairCommands: getTelegramManualRepairCommands(),
    };
  }

  if (ownerState === "fallback" && leaseEnabled) {
    return {
      policy: "manual",
      reason: "Telegram fell back while lease coordination is enabled; check Redis lease ownership and competing pollers.",
      manualRepairSummary: "Restore Redis poll lease coordination or stop the competing poller so one gateway instance can regain Telegram poll ownership.",
      manualRepairCommands: getTelegramManualRepairCommands(),
    };
  }

  if (retrying && conflictStreak > 0) {
    return {
      policy: "manual",
      reason: "Telegram polling is retrying after Bot API conflicts; another bot process is probably polling the same token.",
      manualRepairSummary: "Stop the competing Bot API poller or switch back to coordinated poll leasing before trusting Telegram ingress again.",
      manualRepairCommands: getTelegramManualRepairCommands(),
    };
  }

  if (retrying) {
    return {
      policy: "restart",
      reason: "Telegram polling is down and retrying to re-establish long polling.",
      manualRepairSummary: null,
      manualRepairCommands: [],
    };
  }

  if (!started || ownerState === "stopped" || !healthy) {
    return {
      policy: "restart",
      reason: "Telegram channel stopped or lost healthy polling state.",
      manualRepairSummary: null,
      manualRepairCommands: [],
    };
  }

  return { policy: "none", reason: null, manualRepairSummary: null, manualRepairCommands: [] };
}

function getChannelHealthSummary(
  channels = getChannelRuntimeSnapshots(),
): ChannelHealthSnapshot & {
  alerting: {
    mutedChannels: GatewayChannelId[];
    muteReasons: Partial<Record<GatewayChannelId, string>>;
    lastEvent: {
      channel: GatewayChannelId;
      kind: ChannelHealthEvent["kind"];
      status: ChannelHealthEvent["status"];
      detail: string;
      muted: boolean;
      muteReason: string | null;
      at: string;
    } | null;
    channels: Record<GatewayChannelId, {
      status: string;
      lastChangedAt: string | null;
      lastEventAt: string | null;
      lastRecoveredAt: string | null;
    }>;
  };
  healing: {
    restartAfterConsecutiveDegraded: number;
    cooldownMs: number;
    channels: Record<GatewayChannelId, {
      status: string;
      policy: string;
      policyReason: string | null;
      manualRepairRequired: boolean;
      manualRepairSummary: string | null;
      manualRepairCommands: string[];
      consecutiveDegradedCount: number;
      attempts: number;
      lastAttemptAt: string | null;
      lastAttemptStatus: string;
      lastAttemptError: string | null;
    }>;
  };
} {
  const mutedSet = new Set(channelHealthMuteState.mutedChannels);
  const muteReasons = channelHealthMuteState.muteReasons;
  const telegram = channels.telegram ?? {};
  const discord = channels.discord ?? {};
  const imessage = channels.imessage ?? {};
  const slack = channels.slack ?? {};
  const telegramHealthy = telegram.healthy === true;
  const telegramMuted = mutedSet.has("telegram");
  const discordHealthy = discord.healthy === true;
  const discordMuted = mutedSet.has("discord");
  const imessageHealthy = imessage.healthy === true;
  const imessageMuted = mutedSet.has("imessage");
  const slackHealthy = slack.healthy === true;
  const slackMuted = mutedSet.has("slack");

  const telegramHeal = applyMutedChannelRepairPolicy(getTelegramHealPolicy(telegram), {
    degraded: !telegramHealthy,
    muted: telegramMuted,
    muteReason: muteReasons.telegram ?? null,
    manualRepairCommands: getKnownIssueManualRepairCommands("telegram"),
  });
  const discordHeal = applyMutedChannelRepairPolicy({
    policy: discordHealthy ? "none" : "restart",
    reason: discordHealthy ? null : "Discord client is not ready.",
    manualRepairSummary: null,
    manualRepairCommands: [],
  }, {
    degraded: !discordHealthy,
    muted: discordMuted,
    muteReason: muteReasons.discord ?? null,
    manualRepairCommands: getKnownIssueManualRepairCommands("discord"),
  });
  const imessageHeal = applyMutedChannelRepairPolicy({
    policy: imessageHealthy ? "none" : "restart",
    reason: imessageHealthy ? null : "iMessage socket is disconnected.",
    manualRepairSummary: null,
    manualRepairCommands: [],
  }, {
    degraded: !imessageHealthy,
    muted: imessageMuted,
    muteReason: muteReasons.imessage ?? null,
    manualRepairCommands: getKnownIssueManualRepairCommands("imessage"),
  });
  const slackHeal = applyMutedChannelRepairPolicy({
    policy: slackHealthy ? "none" : "restart",
    reason: slackHealthy ? null : "Slack channel is not connected.",
    manualRepairSummary: null,
    manualRepairCommands: [],
  }, {
    degraded: !slackHealthy,
    muted: slackMuted,
    muteReason: muteReasons.slack ?? null,
    manualRepairCommands: getKnownIssueManualRepairCommands("slack"),
  });

  const snapshot = buildChannelHealthSnapshot({
    entries: {
      telegram: {
        configured: channelInfo.telegram,
        healthy: telegramHealthy,
        detail: describeTelegramChannelHealth(telegram),
        muted: telegramMuted,
        muteReason: muteReasons.telegram ?? null,
        healPolicy: telegramHeal.policy,
        healReason: telegramHeal.reason,
        manualRepairSummary: telegramHeal.manualRepairSummary,
        manualRepairCommands: telegramHeal.manualRepairCommands,
      },
      discord: {
        configured: channelInfo.discord,
        healthy: discordHealthy,
        detail: describeDiscordChannelHealth(discord),
        muted: discordMuted,
        muteReason: muteReasons.discord ?? null,
        healPolicy: discordHeal.policy,
        healReason: discordHeal.reason,
        manualRepairSummary: discordHeal.manualRepairSummary,
        manualRepairCommands: discordHeal.manualRepairCommands,
      },
      imessage: {
        configured: channelInfo.imessage,
        healthy: imessageHealthy,
        detail: describeIMessageChannelHealth(imessage),
        muted: imessageMuted,
        muteReason: muteReasons.imessage ?? null,
        healPolicy: imessageHeal.policy,
        healReason: imessageHeal.reason,
        manualRepairSummary: imessageHeal.manualRepairSummary,
        manualRepairCommands: imessageHeal.manualRepairCommands,
      },
      slack: {
        configured: Boolean(SLACK_ALLOWED_USER_ID),
        healthy: slackHealthy,
        detail: describeSlackChannelHealth(slack),
        muted: slackMuted,
        muteReason: muteReasons.slack ?? null,
        healPolicy: slackHeal.policy,
        healReason: slackHeal.reason,
        manualRepairSummary: slackHeal.manualRepairSummary,
        manualRepairCommands: slackHeal.manualRepairCommands,
      },
    },
  });

  return {
    ...snapshot,
    alerting: {
      mutedChannels: channelHealthMuteState.mutedChannels,
      muteReasons,
      lastEvent: channelHealthAlertState.lastEvent
        ? {
            channel: channelHealthAlertState.lastEvent.channel,
            kind: channelHealthAlertState.lastEvent.kind,
            status: channelHealthAlertState.lastEvent.status,
            detail: channelHealthAlertState.lastEvent.detail,
            muted: channelHealthAlertState.lastEvent.muted,
            muteReason: channelHealthAlertState.lastEvent.muteReason,
            at: new Date(channelHealthAlertState.lastEvent.at).toISOString(),
          }
        : null,
      channels: Object.fromEntries(
        CHANNEL_HEALTH_IDS.map((channel) => {
          const state = channelHealthAlertState.channels[channel];
          return [
            channel,
            {
              status: state.status,
              lastChangedAt: state.lastChangedAt > 0 ? new Date(state.lastChangedAt).toISOString() : null,
              lastEventAt: state.lastEventAt > 0 ? new Date(state.lastEventAt).toISOString() : null,
              lastRecoveredAt: state.lastRecoveredAt > 0 ? new Date(state.lastRecoveredAt).toISOString() : null,
            },
          ];
        }),
      ) as Record<GatewayChannelId, {
        status: string;
        lastChangedAt: string | null;
        lastEventAt: string | null;
        lastRecoveredAt: string | null;
      }>,
    },
    healing: {
      restartAfterConsecutiveDegraded: CHANNEL_HEAL_RESTART_THRESHOLD,
      cooldownMs: CHANNEL_HEAL_COOLDOWN_MS,
      channels: Object.fromEntries(
        CHANNEL_HEALTH_IDS.map((channel) => {
          const state = channelHealState.channels[channel];
          return [
            channel,
            {
              status: state.status,
              policy: state.policy,
              policyReason: state.policyReason,
              manualRepairRequired: state.status === "degraded" && state.policy === "manual",
              manualRepairSummary: state.manualRepairSummary,
              manualRepairCommands: state.manualRepairCommands,
              consecutiveDegradedCount: state.consecutiveDegradedCount,
              attempts: state.attempts,
              lastAttemptAt: state.lastAttemptAt > 0 ? new Date(state.lastAttemptAt).toISOString() : null,
              lastAttemptStatus: state.lastAttemptStatus,
              lastAttemptError: state.lastAttemptError,
            },
          ];
        }),
      ) as Record<GatewayChannelId, {
        status: string;
        policy: string;
        policyReason: string | null;
        manualRepairRequired: boolean;
        manualRepairSummary: string | null;
        manualRepairCommands: string[];
        consecutiveDegradedCount: number;
        attempts: number;
        lastAttemptAt: string | null;
        lastAttemptStatus: string;
        lastAttemptError: string | null;
      }>,
    },
  };
}

function syncChannelHealthAlertState(snapshot: ChannelHealthSnapshot, at = Date.now()): void {
  for (const channel of CHANNEL_HEALTH_IDS) {
    const current = snapshot.entries[channel];
    const previous = channelHealthAlertState.channels[channel];
    if (!current || (previous.status === current.status && previous.lastChangedAt > 0)) continue;

    channelHealthAlertState.channels[channel] = {
      status: current.status,
      lastChangedAt: previous.lastChangedAt > 0 ? previous.lastChangedAt : at,
      lastEventAt: previous.lastEventAt,
      lastRecoveredAt: previous.lastRecoveredAt,
    };
  }
}

function syncChannelHealState(snapshot: ChannelHealthSnapshot): void {
  for (const channel of CHANNEL_HEALTH_IDS) {
    const current = snapshot.entries[channel];
    const previous = channelHealState.channels[channel];
    if (!current) continue;

    channelHealState.channels[channel] = {
      ...previous,
      status: current.status,
      policy: current.healPolicy,
      policyReason: current.healReason,
      manualRepairSummary: current.manualRepairSummary,
      manualRepairCommands: current.manualRepairCommands,
      consecutiveDegradedCount: current.status === "degraded" ? previous.consecutiveDegradedCount : 0,
      lastAttemptStatus: current.status === "degraded" && previous.lastAttemptStatus === "scheduled"
        ? "scheduled"
        : previous.lastAttemptStatus,
    };
  }
}

function buildChannelHealthAlertMessage(event: ChannelHealthEvent, entry?: ChannelHealthSnapshot["entries"][GatewayChannelId]): string {
  const icon = event.kind === "degraded" ? "⚠️" : "✅";
  const title = event.kind === "degraded"
    ? `Gateway channel degraded: ${event.channel}`
    : `Gateway channel recovered: ${event.channel}`;

  const manualCommands = entry?.manualRepairCommands ?? [];

  return [
    `${icon} <b>${escapeHtml(title)}</b>`,
    "",
    `State: <code>${escapeHtml(event.status)}</code>`,
    `Detail: <code>${escapeHtml(event.detail)}</code>`,
    ...(entry?.healPolicy && entry.healPolicy !== "none" ? [`Heal policy: <code>${escapeHtml(entry.healPolicy)}</code>`] : []),
    ...(entry?.healReason ? [`Heal reason: <code>${escapeHtml(entry.healReason)}</code>`] : []),
    ...(entry?.manualRepairSummary ? [`Manual repair: <code>${escapeHtml(entry.manualRepairSummary)}</code>`] : []),
    ...(manualCommands.length > 0
      ? [
          "Commands:",
          ...manualCommands.map((command) => `- <code>${escapeHtml(command)}</code>`),
        ]
      : []),
    ...(event.muted ? [`Known issue: <code>${escapeHtml(event.muteReason ?? "muted")}</code>`] : []),
  ].join("\n");
}

async function maybeNotifyChannelHealth(): Promise<void> {
  if (channelHealthEvaluatePromise) {
    return channelHealthEvaluatePromise;
  }

  channelHealthEvaluatePromise = (async () => {
    await maybeRefreshChannelHealthMuteState();
    const snapshot = getChannelHealthSummary();
    const now = Date.now();
    const decision = evaluateChannelHealthAlert(snapshot, channelHealthAlertState, now);
    channelHealthAlertState = decision.nextState;

    for (const event of decision.events) {
      const entry = snapshot.entries[event.channel];
      const metadata = {
        channel: event.channel,
        kind: event.kind,
        status: event.status,
        detail: event.detail,
        muted: event.muted,
        muteReason: event.muteReason,
        healPolicy: entry?.healPolicy ?? null,
        healReason: entry?.healReason ?? null,
        manualRepairSummary: entry?.manualRepairSummary ?? null,
        manualRepairCommands: entry?.manualRepairCommands ?? [],
      };

      void emitGatewayOtel({
        level: event.kind === "degraded" ? "warn" : "info",
        component: "daemon.channel-health",
        action: "channel_health.state.changed",
        success: event.kind === "recovered",
        metadata,
      });

      if (event.muted) {
        void emitGatewayOtel({
          level: "info",
          component: "daemon.channel-health",
          action: "channel_health.alert.suppressed",
          success: true,
          metadata,
        });
        continue;
      }

      if (!TELEGRAM_USER_ID) continue;

      try {
        await sendTelegram(TELEGRAM_USER_ID, buildChannelHealthAlertMessage(event, entry), {
          silent: event.kind !== "degraded",
        });
        void emitGatewayOtel({
          level: event.kind === "degraded" ? "warn" : "info",
          component: "daemon.channel-health",
          action: "channel_health.alert.sent",
          success: true,
          metadata,
        });
      } catch (error) {
        console.error("[gateway:channel-health] alert send failed", {
          channel: event.channel,
          error: String(error),
        });
        void emitGatewayOtel({
          level: "error",
          component: "daemon.channel-health",
          action: "channel_health.alert.failed",
          success: false,
          error: String(error),
          metadata,
        });
      }
    }
  })();

  try {
    await channelHealthEvaluatePromise;
  } finally {
    channelHealthEvaluatePromise = null;
  }
}

async function restartGatewayChannel(channel: GatewayChannelId, reason: string): Promise<void> {
  switch (channel) {
    case "telegram": {
      if (!TELEGRAM_TOKEN || !TELEGRAM_USER_ID) {
        throw new Error("telegram not configured");
      }
      await shutdownTelegram();
      await startTelegram(TELEGRAM_TOKEN, TELEGRAM_USER_ID, enqueueToGateway, {
        configureBot: async (bot) => {
          await initializeTelegramCommandHandler({
            bot,
            enqueue: enqueueToGateway,
            redis: redisClient,
            chatId: TELEGRAM_USER_ID,
            getStatusSnapshot: getGatewayStatusSnapshot,
          });
        },
        abortCurrentTurn: async () => {
          await session.abort();
        },
      });
      setOutboundMessageIdCallback((messageId: number) => {
        const threadCtx = getActiveThreadContext();
        if (threadCtx?.threadId) {
          recordOutboundAnchor(threadCtx.threadId, "telegram", String(messageId));
        }
      });
      await updatePinnedStatus().catch(() => {});
      return;
    }
    case "discord": {
      if (!DISCORD_TOKEN || !DISCORD_ALLOWED_USER_ID) {
        throw new Error("discord not configured");
      }
      await shutdownDiscord();
      await startDiscord(DISCORD_TOKEN, DISCORD_ALLOWED_USER_ID, enqueueToGateway, {
        redis: redisClient,
        abortCurrentTurn: async () => {
          await session.abort();
        },
      });
      registerDiscordMcqAdapter(fetchDiscordChannel, getDiscordClient as () => any);
      return;
    }
    case "imessage": {
      if (!IMESSAGE_ALLOWED_SENDER) {
        throw new Error("imessage not configured");
      }
      await shutdownIMessage();
      await startIMessage(IMESSAGE_ALLOWED_SENDER, enqueueToGateway, {
        abortCurrentTurn: async () => {
          await session.abort();
        },
      });
      return;
    }
    case "slack": {
      await shutdownSlack();
      await startSlack(enqueueToGateway, {
        allowedUserId: SLACK_ALLOWED_USER_ID,
      });
      channelInfo.slack = isSlackStarted();
      return;
    }
  }
}

async function maybeHealChannels(): Promise<void> {
  if (channelHealEvaluatePromise) {
    return channelHealEvaluatePromise;
  }

  channelHealEvaluatePromise = (async () => {
    await maybeRefreshChannelHealthMuteState();
    const summary = getChannelHealthSummary();
    const decision = evaluateChannelHealPolicy(summary, channelHealState, Date.now(), {
      restartAfterConsecutiveDegraded: CHANNEL_HEAL_RESTART_THRESHOLD,
      cooldownMs: CHANNEL_HEAL_COOLDOWN_MS,
    });
    channelHealState = decision.nextState;

    for (const action of decision.actions) {
      const metadata = {
        channel: action.channel,
        policy: action.policy,
        detail: action.detail,
        reason: action.reason,
        attempts: channelHealState.channels[action.channel]?.attempts ?? 0,
        consecutiveDegradedCount: channelHealState.channels[action.channel]?.consecutiveDegradedCount ?? 0,
      };

      void emitGatewayOtel({
        level: "warn",
        component: "daemon.channel-health",
        action: "channel_health.heal.attempted",
        success: true,
        metadata,
      });

      try {
        await restartGatewayChannel(action.channel, action.reason ?? action.detail);
        channelHealState = recordChannelHealAttemptResult(channelHealState, {
          channel: action.channel,
          succeeded: true,
        });
        const refreshed = getChannelHealthSummary();
        syncChannelHealthAlertState(refreshed);
        syncChannelHealState(refreshed);
        void emitGatewayOtel({
          level: "info",
          component: "daemon.channel-health",
          action: "channel_health.heal.succeeded",
          success: true,
          metadata,
        });
      } catch (error) {
        channelHealState = recordChannelHealAttemptResult(channelHealState, {
          channel: action.channel,
          succeeded: false,
          error: String(error),
        });
        console.error("[gateway:channel-health] channel heal failed", {
          channel: action.channel,
          error: String(error),
        });
        void emitGatewayOtel({
          level: "error",
          component: "daemon.channel-health",
          action: "channel_health.heal.failed",
          success: false,
          error: String(error),
          metadata,
        });
      }
    }
  })();

  try {
    await channelHealEvaluatePromise;
  } finally {
    channelHealEvaluatePromise = null;
  }
}

function getChannelRuntimeSnapshots(): Record<string, Record<string, unknown>> {
  const telegram = getTelegramRuntimeState();
  const discord = getDiscordRuntimeState();
  const imessage = getIMessageRuntimeState();
  const slack = getSlackRuntimeState();
  const telegramPollingState = !telegram.started
    ? "stopped"
    : telegram.pollingActive
      ? "active"
      : telegram.pollingStarting
        ? "starting"
        : telegram.pollConflictStreak > 0 && telegram.pollRetryAttempts > 0
          ? "retrying_conflict"
          : telegram.pollRetryAttempts > 0
            ? "retrying"
            : "idle";
  const telegramIngressHealthy = channelInfo.telegram
    ? telegram.started
      && !(telegram.pollLeaseState === "passive" || (telegram.pollLeaseState === "fallback" && telegram.pollLeaseEnabled) || telegram.pollLeaseState === "stopped")
      && (telegram.pollingActive || telegram.pollingStarting)
    : false;

  return {
    telegram: {
      configured: channelInfo.telegram,
      started: telegram.started,
      healthy: telegramIngressHealthy,
      ownerState: telegram.pollLeaseState,
      pollingState: telegramPollingState,
      pollingActive: telegram.pollingActive,
      pollingStarting: telegram.pollingStarting,
      leaseEnabled: telegram.pollLeaseEnabled,
      leaseOwned: telegram.pollLeaseOwned,
      retryAttempts: telegram.pollRetryAttempts,
      conflictStreak: telegram.pollConflictStreak,
      lastLeaseStatusAt: telegram.pollLeaseStatus?.updatedAt ?? null,
      lastLeaseReason: telegram.pollLeaseStatus?.reason ?? null,
    },
    discord: {
      configured: channelInfo.discord,
      started: discord.started,
      healthy: channelInfo.discord ? discord.ready : false,
      ready: discord.ready,
      botUserId: discord.botUserId,
    },
    imessage: {
      configured: channelInfo.imessage,
      started: imessage.running,
      healthy: channelInfo.imessage ? imessage.connected : false,
      connected: imessage.connected,
      reconnectAttempts: imessage.reconnectAttempts,
      reconnectDelayMs: imessage.reconnectDelayMs,
      healing: imessage.healing,
      lastHealAt: imessage.lastHealAt ? new Date(imessage.lastHealAt).toISOString() : null,
    },
    slack: {
      configured: Boolean(SLACK_ALLOWED_USER_ID),
      started: slack.started,
      healthy: Boolean(SLACK_ALLOWED_USER_ID) ? slack.connected : false,
      connected: slack.connected,
      botUserId: slack.botUserId,
      allowedUserId: slack.allowedUserId,
    },
  };
}

function getStatusPayload(): Record<string, unknown> {
  const fb = fallbackController.state;
  const redisState = getRedisRuntimeState();
  const sessionPressure = getSessionPressure();
  const supersessionSnapshot = getSupersessionState();
  const supersession = {
    ...supersessionSnapshot,
    batching: {
      ...supersessionSnapshot.batching,
      windowMs: HUMAN_TURN_BATCH_WINDOW_MS,
    },
  };
  const operatorTracing = getOperatorTraceSnapshot();
  const channels = getChannelRuntimeSnapshots();
  const channelHealth = getChannelHealthSummary(channels);
  const degradedCapabilities = getDegradedCapabilities();

  return {
    sessionId: session.sessionId,
    isStreaming: responseChunks.length > 0,
    model: describeModel(session.model),
    uptimeMs: Date.now() - startedAt,
    pid: process.pid,
    mode: redisState.mode,
    degradedCapabilities,
    runtime: {
      reason: redisState.reason,
      since: new Date(redisState.lastTransitionAt).toISOString(),
      reconnectAttempts: redisState.reconnectAttempts,
      lastError: redisState.lastError ?? null,
      redisHealthy: redisState.healthy,
      subscriberStatus: redisState.subscriberStatus,
      commandStatus: redisState.commandStatus,
    },
    context: {
      entries: sessionPressure.entries,
      estimatedTokens: sessionPressure.estimatedTokens,
      usagePercent: sessionPressure.usagePercent,
      maxTokens: sessionPressure.maxTokens,
      health: sessionPressure.health,
    },
    sessionPressure,
    supersession,
    operatorTracing,
    callbackTracing: operatorTracing,
    channels,
    channelHealth,
    channelInfo: {
      ...channelInfo,
      redis: isRedisHealthy() ? "ok" : "degraded",
      ws: {
        port: wsServer.port,
        clients: wsClients.size,
      },
    },
    queueDepth: getQueueDepth(),
    guardrails: {
      currentTurnToolCalls: currentTurnToolCallCount,
      currentTurnToolSummary: summarizeToolNames(currentTurnToolHistory),
      checkpointSentThisTurn: currentTurnCheckpointSent,
      lastCheckpointAt: lastCheckpointAt > 0 ? new Date(lastCheckpointAt).toISOString() : null,
      lastCheckpointReason: lastCheckpointReason ?? null,
      pendingDeployVerifications: [...pendingDeployVerifications.values()].map((pending) => ({
        repoPath: pending.repoPath,
        commitSha: pending.commitSha,
        changedFiles: pending.changedFiles,
        scheduledAt: new Date(pending.scheduledAt).toISOString(),
      })),
    },
    fallback: fb.active ? {
      active: true,
      model: `${fb.fallbackProvider}/${fb.fallbackModel}`,
      since: new Date(fb.activeSince).toISOString(),
      activationCount: fb.activationCount,
    } : { active: false },
  };
}

async function getLastHeartbeatAt(): Promise<number | undefined> {
  try {
    const content = await readFile(TRIPWIRE_PATH, "utf8");
    const match = content.match(/lastHeartbeatTs\s*=\s*(\d+)/);
    if (!match?.[1]) return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

async function getGatewayStatusSnapshot(): Promise<{
  modelName: string;
  thinkingLevel: string;
  verbose: boolean;
  uptimeMs: number;
  queueDepth: number;
  lastHeartbeatAt?: number;
}> {
  const runtimeConfig = await loadGatewayConfig(getRedisClient());

  return {
    modelName: runtimeConfig.model,
    thinkingLevel: runtimeConfig.thinkingLevel,
    verbose: runtimeConfig.verbose,
    uptimeMs: Date.now() - startedAt,
    queueDepth: getQueueDepth(),
    lastHeartbeatAt: await getLastHeartbeatAt(),
  };
}

function sendWsMessage(ws: Bun.ServerWebSocket<unknown>, payload: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[gateway] ws send failed", { error });
  }
}

function broadcastWs(payload: WsServerMessage): void {
  for (const client of wsClients) {
    sendWsMessage(client, payload);
  }
}

function parseClientMessage(raw: string | Buffer | Uint8Array): WsClientMessage | undefined {
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const parsed = JSON.parse(text) as WsClientMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

await mkdir(PID_DIR, { recursive: true });

const wsServer = Bun.serve({
  port: WS_PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      const health = getHealthStatus();
      return Response.json(health, { status: health.available ? 200 : 503 });
    }

    if (req.method === "GET" && url.pathname === "/health/slack") {
      const healthy = isSlackStarted();
      return Response.json(
        {
          ok: healthy,
          channel: "slack",
          started: healthy,
          checkedAt: new Date().toISOString(),
        },
        { status: healthy ? 200 : 503 },
      );
    }

    if (server.upgrade(req)) return;
    return new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      sendWsMessage(ws, { type: "status", data: getStatusPayload() });
    },
    async message(ws, message) {
      const data = parseClientMessage(message);
      if (!data) {
        sendWsMessage(ws, { type: "error", message: "Invalid message payload" });
        return;
      }

      if (data.type === "prompt") {
        const text = data.text?.trim();
        if (!text) {
          sendWsMessage(ws, { type: "error", message: "Prompt text is required" });
          return;
        }
        const withChannelContext = injectChannelContext(text, { source: "tui" });
        await enqueue("tui", withChannelContext, { via: "ws" });
        void drain();
        return;
      }

      if (data.type === "abort") {
        try {
          await session.abort();
        } catch (error: any) {
          sendWsMessage(ws, { type: "error", message: `Abort failed: ${error?.message ?? String(error)}` });
        }
        return;
      }

      if (data.type === "status") {
        sendWsMessage(ws, { type: "status", data: getStatusPayload() });
      }
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },
});

await writeFile(WS_PORT_FILE, `${wsServer.port}\n`);

session.subscribe((event: any) => {
  if (event.type === "turn_start") {
    turnInProgress = true;
    onModelTurnStart("turn_start");
  }

  if (event.type === "message_start") {
    turnInProgress = true;
    // Fallback path for SDKs that may emit message_start without turn_start.
    onModelTurnStart("message_start");
  }

  // Any model activity resets the fallback timeout (tool calls take time)
  if (event.type === "message_start" || event.type === "message_update") {
    fallbackController.onActivity();
  }

  if (event.type === "message_start") {
    captureResponseSource();
  }

  // Collect text deltas
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    captureResponseSource();
    const delta = typeof event.assistantMessageEvent.delta === "string"
      ? event.assistantMessageEvent.delta
      : "";
    if (!delta) return;
    responseChunks.push(delta);
    fallbackController.onFirstToken();
    broadcastWs({ type: "text_delta", delta });

    // Forward to Telegram streaming
    telegramStream.pushDelta(delta);
  }

  // On message end, route the full response to the source channel
  if (event.type === "message_end") {
    const fullText = responseChunks.join("");
    responseChunks = [];
    const stopReason = typeof event.message?.stopReason === "string"
      ? event.message.stopReason
      : undefined;

    if (isActiveRequestSuperseded()) {
      console.log("[gateway:supersession] dropped stale response after newer human turn", {
        source: getActiveSource(),
        textLength: fullText.length,
      });
      void emitGatewayOtel({
        level: "info",
        component: "daemon.supersession",
        action: "supersession.response_dropped",
        success: true,
        metadata: {
          source: getActiveSource() ?? "unknown",
          textLength: fullText.length,
        },
      });
      telegramStream.abort();
      return;
    }

    // Detect API errors (429, 529, overload) surfaced via errorMessage —
    // pi resolves (doesn't throw), so these bypass the throw-based fallback path.
    const errorMsg: string = event.message?.errorMessage ?? "";
    if (errorMsg) {
      const is429 = errorMsg.includes("rate_limit") || errorMsg.includes("429");
      const isOverload = errorMsg.includes("overloaded") || errorMsg.includes("529");
      if (is429 || isOverload) {
        fallbackController.cancelTimeoutWatch();
        const reason = is429 ? "Anthropic rate limit (429)" : "Anthropic overloaded (529)";
        const activeMetadata = getActiveRequestMetadata();
        const operatorTraceId = getOperatorTraceIdFromMetadata(activeMetadata);
        console.warn("[gateway:fallback] API error detected via message_end", {
          reason,
          errorMsg: errorMsg.slice(0, 120),
        });
        if (operatorTraceId) {
          failOperatorTrace(
            operatorTraceId,
            errorMsg,
            `${getOperatorCommandLabel(activeMetadata)} failed while waiting for downstream completion`,
          );
        }
        void emitGatewayOtel({
          level: "error",
          component: "daemon",
          action: "daemon.api_error.detected",
          success: false,
          error: reason,
        });
        const predictedFailures = getConsecutiveFailures() + 1;
        // Treat as a prompt failure — let fallback controller decide whether to swap
        void fallbackController.onPromptError(predictedFailures);
        void pingModelFailure({
          consecutiveFailures: predictedFailures,
          source: getActiveSource() ?? "unknown",
          error: errorMsg,
        });
        // Abort any active Telegram stream on API error
        telegramStream.abort();
        return;
      }
      // Other errors — log but don't route
      fallbackController.cancelTimeoutWatch();
      const activeMetadata = getActiveRequestMetadata();
      const operatorTraceId = getOperatorTraceIdFromMetadata(activeMetadata);
      console.error("[gateway] message_end with error", { errorMsg: errorMsg.slice(0, 200) });
      if (operatorTraceId) {
        failOperatorTrace(
          operatorTraceId,
          errorMsg,
          `${getOperatorCommandLabel(activeMetadata)} ended with an assistant error`,
        );
      }
      telegramStream.abort();
      return;
    }

    if (!fullText.trim()) {
      fallbackController.cancelTimeoutWatch();
      if (stopReason === "aborted") {
        console.warn("[gateway:fallback] cleared timeout watch after aborted message_end with no text");
        void emitGatewayOtel({
          level: "info",
          component: "daemon.fallback",
          action: "fallback.monitor_reset.aborted_message_end",
          success: true,
          metadata: {
            stopReason,
          },
        });
      }
      return;
    }
    const normalizedTurnText = fullText.trim();
    if (!turnKnowledgeText) {
      turnKnowledgeText = normalizedTurnText;
    } else {
      turnKnowledgeText = `${turnKnowledgeText}\n\n${normalizedTurnText}`;
    }

    const activeSource = getActiveSource();
    const capturedSource = captureResponseSource();
    const sourceRecoveryAgeMs = lastPromptSourceAt > 0 ? Date.now() - lastPromptSourceAt : undefined;
    const recoveredSource = (
      !activeSource
      && !capturedSource
      && typeof lastPromptSource === "string"
      && lastPromptSource.length > 0
      && sourceRecoveryAgeMs !== undefined
      && sourceRecoveryAgeMs <= RESPONSE_SOURCE_RECOVERY_WINDOW_MS
    )
      ? lastPromptSource
      : undefined;

    const source = activeSource ?? capturedSource ?? recoveredSource ?? "console";
    const sourceKind = getSourceKind(source);
    const backgroundSource = isBackgroundSource(source);
    const responseAttribution: OutboundAttribution = {
      sourceKind,
      backgroundSource,
      hasActiveSource: Boolean(activeSource),
      hasCapturedSource: Boolean(capturedSource),
      recoveredFromRecentPrompt: Boolean(recoveredSource),
      recentPromptSourceAgeMs: sourceRecoveryAgeMs,
    };

    void emitGatewayOtel({
      level: "debug",
      component: "daemon.response",
      action: "response.generated",
      success: true,
      metadata: {
        source,
        sourceKind,
        textLength: fullText.length,
        hasActiveSource: Boolean(activeSource),
        hasCapturedSource: Boolean(capturedSource),
        recoveredFromRecentPrompt: Boolean(recoveredSource),
        recentPromptSourcePrefix: lastPromptSource?.split(":")[0],
        recentPromptSourceAgeMs: sourceRecoveryAgeMs,
        backgroundSource,
      },
    });

    if (backgroundSource) {
      void emitGatewayOtel({
        level: "debug",
        component: "daemon.response",
        action: "response.generated.background_source",
        success: true,
        metadata: {
          source,
          sourceKind,
          textLength: fullText.length,
          hasActiveSource: Boolean(activeSource),
          hasCapturedSource: Boolean(capturedSource),
          recoveredFromRecentPrompt: Boolean(recoveredSource),
          recentPromptSourceAgeMs: sourceRecoveryAgeMs,
        },
      });
    }

    if (recoveredSource) {
      console.log("[gateway] recovered response source from recent prompt", {
        source,
        ageMs: sourceRecoveryAgeMs,
      });
      void emitGatewayOtel({
        level: "info",
        component: "daemon",
        action: "daemon.response.source_recovered_recent_prompt",
        success: true,
        metadata: {
          source,
          ageMs: sourceRecoveryAgeMs,
          length: fullText.length,
        },
      });
    } else if (source === "console") {
      const hasRecentPromptContext = sourceRecoveryAgeMs !== undefined
        && sourceRecoveryAgeMs <= RESPONSE_SOURCE_RECOVERY_WINDOW_MS;
      const fallbackMetadata = {
        length: fullText.length,
        hasActiveSource: Boolean(activeSource),
        hasCapturedSource: Boolean(capturedSource),
        recentPromptSourcePrefix: lastPromptSource?.split(":")[0],
        recentPromptSourceAgeMs: sourceRecoveryAgeMs,
      };

      if (hasRecentPromptContext) {
        // Suspicious: we recently handled a channel-origin prompt but lost source context.
        console.warn("[gateway] response source fallback to console", fallbackMetadata);
        void emitGatewayOtel({
          level: "warn",
          component: "daemon",
          action: "daemon.response.source_fallback_console",
          success: false,
          metadata: fallbackMetadata,
        });
      } else {
        // Expected in some startup/background console turns. Keep observable without paging.
        console.log("[gateway] response routed to console (no recent channel context)", fallbackMetadata);
        void emitGatewayOtel({
          level: "info",
          component: "daemon",
          action: "daemon.response.source_console_no_context",
          success: true,
          metadata: fallbackMetadata,
        });
      }
    }
    if (sourceKind === "channel") {
      markTurnCheckpoint("response");
    }

    console.log("[gateway] response ready", { source, length: fullText.length });

    // If Telegram streaming is active, finalize the current message segment.
    // finish() returns true if it handled delivery. After finishing, the stream
    // resets for the next message segment (tool calls may produce more text).
    if (telegramStream.isActive() && source.startsWith("telegram:")) {
      telegramStream.finish(fullText).then((handled) => {
        if (!handled) {
          // Streaming didn't actually send anything — fall back to normal path
          routeResponse(source, fullText, { attribution: responseAttribution });
        }
      }).catch((err) => {
        console.error("[telegram-stream] finish failed, falling back", { error: String(err) });
        routeResponse(source, fullText, { attribution: responseAttribution });
      });
      return;
    }

    routeResponse(source, fullText, { attribution: responseAttribution });
  }

  if (event.type === "tool_call") {
    fallbackController.onActivity(); // model is alive, restart timeout
    const toolName = typeof event.toolName === "string" ? event.toolName.trim() : "";
    if (toolName) {
      turnKnowledgeToolCalls.push(toolName);
      rememberToolName(toolName);
    }
    currentTurnToolCallCount += 1;
    pendingToolCalls.set(event.toolCallId, {
      toolName: toolName || "unknown",
      input: event.input,
      startedAt: Date.now(),
    });

    if (toolName === "mcq") {
      markTurnCheckpoint("mcq");
    } else {
      void maybeSendToolBudgetCheckpoint();
    }

    broadcastWs({
      type: "tool_call",
      id: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });

    // Show tool status in Telegram stream
    if (telegramStream.isActive()) {
      telegramStream.onToolCall(event.toolName ?? "tool");
    }
  }

  if (event.type === "tool_result") {
    fallbackController.onActivity(); // model is alive, restart timeout
    const pendingTool = pendingToolCalls.get(event.toolCallId);
    pendingToolCalls.delete(event.toolCallId);

    if (event.isError) {
      turnKnowledgeToolErrors += 1;
    }
    broadcastWs({
      type: "tool_result",
      id: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      isError: event.isError,
    });

    if (!event.isError && pendingTool?.toolName === "bash") {
      const command = extractBashCommand(pendingTool.input);
      if (command) {
        void maybeScheduleDeployVerification(command);
      }
    }

    if (event.isError) {
      broadcastWs({
        type: "error",
        message: `Tool ${event.toolName} failed (${event.toolCallId})`,
      });
    }
  }

  if (event.type === "turn_end") {
    turnInProgress = false;
    const turnEndAt = Date.now();
    _lastTurnEndAt = turnEndAt;

    if (stuckRecovery) {
      const recoveredAfterMs = turnEndAt - stuckRecovery.startedAt;
      console.warn("[gateway:watchdog] session recovered after stuck abort", {
        recoveredAfterMs,
      });
      void emitGatewayOtel({
        level: "info",
        component: "daemon.watchdog",
        action: "watchdog.session_stuck.recovered",
        success: true,
        metadata: {
          recoveredAfterMs,
          recoverySignal: "turn_end",
        },
      });
      stuckRecovery = undefined;
    }

    fallbackController.onTurnEnd();
    broadcastWs({ type: "turn_end" });
    // Clean up Telegram streaming state for this turn
    telegramStream.turnEnd();
    // Release the idle waiter so the drain loop can process the next entry
    if (_idleResolve) {
      const resolve = _idleResolve;
      _idleResolve = undefined;
      resolve();
    }

    const activeMetadata = getActiveRequestMetadata();
    const operatorTraceId = getOperatorTraceIdFromMetadata(activeMetadata);
    if (operatorTraceId) {
      completeOperatorTrace(
        operatorTraceId,
        buildOperatorTraceCompletionDetail(activeMetadata, turnKnowledgeText, turnKnowledgeToolCalls),
      );
    }

    const turnSource = getActiveSource() ?? responseSource ?? lastPromptSource ?? "gateway";
    const { payload, fingerprint } = buildGatewayTurnKnowledgeWrite({
      source: turnSource,
      sessionId: session.sessionId,
      turnNumber: Math.max(turnKnowledgeCounter, 1),
      assistantText: turnKnowledgeText,
      toolCalls: turnKnowledgeToolCalls,
      toolErrorCount: turnKnowledgeToolErrors,
      previousFingerprint: lastTurnKnowledgeFingerprint,
    });
    lastTurnKnowledgeFingerprint = fingerprint;
    turnKnowledgeText = "";
    turnKnowledgeToolCalls = [];
    turnKnowledgeToolErrors = 0;
    currentTurnToolCallCount = 0;
    currentTurnToolHistory = [];
    currentTurnCheckpointSent = false;
    pendingToolCalls.clear();
    void sendGatewayTurnKnowledgeWrite(payload);

    responseSource = undefined;

    // ── Proactive context health check (ADR-0141 + ADR-0211) ────
    // After each turn: check context usage, compaction freshness, and session age.
    // Compact or create fresh session BEFORE releasing the drain loop.
    const doHealthCheck = async () => {
      try {
        const now = Date.now();
        const sessionPressure = getSessionPressure();
        await maybeNotifySessionPressure(sessionPressure);

        // ── ADR-0211: Session age guard ──────────────────────────
        // Sessions older than 24h accumulate too much context history.
        // Even with compaction, the JSONL grows and pi's summarization
        // degrades. Fresh session with compression summary is better.
        const sessionAgeMs = now - sessionCreatedAt;
        if (sessionAgeMs > MAX_SESSION_AGE_MS) {
          console.warn("[gateway:health] session age limit reached — creating fresh session", {
            ageHours: Math.round(sessionAgeMs / 3_600_000),
            maxHours: MAX_SESSION_AGE_MS / 3_600_000,
            entries: sessionManager.getEntries().length,
          });
          void emitGatewayOtel({
            level: "warn",
            component: "daemon",
            action: "daemon.session.age_limit",
            success: true,
            metadata: {
              ageMs: sessionAgeMs,
              maxMs: MAX_SESSION_AGE_MS,
              entries: sessionManager.getEntries().length,
            },
          });

          // Keep recycled-session notices out of the operator relay by default.
          if (TELEGRAM_USER_ID && shouldSendSessionLifecycleTelegramNotice("recycled")) {
            sendTelegram(TELEGRAM_USER_ID, [
              "🔄 <b>Gateway session recycled</b>",
              "",
              `Session was ${Math.round(sessionAgeMs / 3_600_000)}h old.`,
              "Created fresh session with context summary.",
            ].join("\n"), { silent: true }).catch(() => {});
          }

          const summary = buildCompressionSummary();
          fallbackController.pauseTimeoutWatch();
          // Reset clocks BEFORE prompt — prompt triggers turn_end which
          // re-enters doHealthCheck(). Without pre-reset, the inner call
          // sees stale sessionCreatedAt and loops forever.
          sessionCreatedAt = now;
          lastCompactionAt = now;
          try {
            await session.newSession();
            lastProactiveCompactionAt = 0;
            lastProactiveCompactionUsagePercent = 0;
            if (summary) {
              await session.prompt(summary, { streamingBehavior: "followUp" });
            }
          } catch (err) {
            console.error("[gateway:health] session recycle failed", { err });
          }
          fallbackController.resumeTimeoutWatch();
          // Skip remaining checks — fresh session is clean
          return;
        }

        // ── ADR-0211: Compaction circuit breaker ─────────────────
        // If compaction hasn't fired in MAX_COMPACTION_GAP_MS, force it
        // regardless of token count. This prevents the context bloat that
        // caused the overnight thrash of 2026-03-05 (12h without compaction,
        // 92 fallback activations, 83 timeouts).
        const compactionGapMs = now - lastCompactionAt;
        if (compactionGapMs > MAX_COMPACTION_GAP_MS && !session.isCompacting) {
          const gapHours = Math.round(compactionGapMs / 3_600_000 * 10) / 10;
          console.warn("[gateway:health] compaction overdue — forcing compact", {
            lastCompactionAt: new Date(lastCompactionAt).toISOString(),
            gapHours,
            entries: sessionManager.getEntries().length,
          });
          void emitGatewayOtel({
            level: "warn",
            component: "daemon",
            action: "daemon.compaction.circuit_breaker",
            success: true,
            metadata: {
              gapMs: compactionGapMs,
              gapHours,
              entries: sessionManager.getEntries().length,
            },
          });
          try {
            await runGatewayMaintenance(
              {
                kind: "compact",
                reason: "compaction_gap",
                contextTokens: undefined,
                usagePercent: CONTEXT_COMPACT_THRESHOLD_PERCENT,
              },
              async () => {
                await session.compact(
                  `Compaction overdue (${gapHours}h since last). Aggressively summarize. `
                  + "Keep only essential recent context and active thread state.",
                );
                lastCompactionAt = Date.now();
                lastProactiveCompactionAt = lastCompactionAt;
                lastProactiveCompactionUsagePercent = CONTEXT_COMPACT_THRESHOLD_PERCENT;
              },
            );
            console.log("[gateway:health] circuit-breaker compaction complete");
          } catch (err) {
            console.error("[gateway:health] circuit-breaker compaction failed", { err });
          }
          // Continue to token check — compaction may not have reduced enough
        }

        const lastUsage = getLastAssistantUsage(sessionManager.getEntries());
        if (!lastUsage) return;

        const contextTokens = calculateContextTokens(lastUsage);
        const modelContextWindow = getCurrentModelContextWindow();
        const usageRatio = contextTokens / modelContextWindow;

        // ── Two-tier context management (ADR-0211 amendment, 2026-03-05) ──
        // Tier 2: 75% → session rotation (compaction can't recover enough).
        // System prompt (~40K) + compacted summary + 10K recent = ~60% floor.
        // Once past 75%, compaction just delays the inevitable thrash.
        if (usageRatio > 0.75 && !session.isCompacting) {
          const pct = Math.round(usageRatio * 100);
          console.warn("[gateway:health] context ceiling — rotating session", {
            contextTokens,
            usagePercent: pct,
            entries: sessionManager.getEntries().length,
          });
          void emitGatewayOtel({
            level: "warn",
            component: "daemon",
            action: "daemon.context.ceiling_rotation",
            success: true,
            metadata: { contextTokens, usageRatio: pct, entries: sessionManager.getEntries().length },
          });

          if (TELEGRAM_USER_ID && shouldSendSessionLifecycleTelegramNotice("rotated")) {
            sendTelegram(TELEGRAM_USER_ID, [
              "🔄 <b>Gateway session rotated</b>",
              "",
              `Context at ${pct}% (${contextTokens} tokens).`,
              "Fresh session with context summary.",
            ].join("\n"), { silent: true }).catch(() => {});
          }

          const summary = buildCompressionSummary();
          try {
            await runGatewayMaintenance(
              {
                kind: "rotate",
                reason: "context_ceiling",
                contextTokens,
                usagePercent: pct,
                modelContextWindow,
              },
              async () => {
                sessionCreatedAt = Date.now();
                lastCompactionAt = Date.now();
                await session.newSession();
                lastProactiveCompactionAt = 0;
                lastProactiveCompactionUsagePercent = 0;
                if (summary) {
                  await session.prompt(summary, { streamingBehavior: "followUp" });
                }
              },
            );
            console.log("[gateway:health] context-ceiling rotation complete");
          } catch (err) {
            console.error("[gateway:health] context-ceiling rotation failed", { err });
          }
          return;
        }

        // Tier 1: 65% → proactive compaction (buys time before we hit 75%).
        if (usageRatio > 0.65 && !session.isCompacting) {
          const usagePercent = Math.round(usageRatio * 100);
          const recentProactiveCompaction = lastProactiveCompactionAt > 0
            && now - lastProactiveCompactionAt < PROACTIVE_COMPACTION_COOLDOWN_MS;
          const usageJumped = usagePercent >= lastProactiveCompactionUsagePercent + PROACTIVE_COMPACTION_USAGE_DELTA_PERCENT;

          if (recentProactiveCompaction && !usageJumped) {
            console.log("[gateway:health] proactive compaction skipped (cooldown active)", {
              usagePercent,
              lastProactiveCompactionAt: new Date(lastProactiveCompactionAt).toISOString(),
              cooldownRemainingMs: PROACTIVE_COMPACTION_COOLDOWN_MS - (now - lastProactiveCompactionAt),
              lastProactiveCompactionUsagePercent,
            });
          } else {
            console.warn("[gateway:health] context elevated — proactive compaction", {
              contextTokens,
              usagePercent,
              entries: sessionManager.getEntries().length,
            });
            void emitGatewayOtel({
              level: "warn",
              component: "daemon",
              action: "daemon.context.proactive_compact",
              success: true,
              metadata: { contextTokens, usageRatio: usagePercent, entries: sessionManager.getEntries().length },
            });
            try {
              await runGatewayMaintenance(
                {
                  kind: "compact",
                  reason: "context_elevated",
                  contextTokens,
                  usagePercent,
                  modelContextWindow,
                },
                async () => {
                  await session.compact(
                    "Context is at " + usagePercent
                    + "% capacity. Aggressively summarize to prevent overflow. "
                    + "Keep only essential recent context and active thread state.",
                  );
                  lastCompactionAt = Date.now();
                  lastProactiveCompactionAt = lastCompactionAt;
                  lastProactiveCompactionUsagePercent = usagePercent;
                },
              );
              console.log("[gateway:health] proactive compaction complete");
            } catch (err) {
              console.error("[gateway:health] proactive compaction failed", { err });
            }
          }
        } else if (usageRatio > 0.5) {
          // Early warning — just log
          console.log("[gateway:health] context usage moderate", {
            contextTokens,
            usagePercent: Math.round(usageRatio * 100),
          });
        }
      } catch (healthErr) {
        // Non-fatal — don't let monitoring break the drain loop
        console.error("[gateway:health] context check failed", { healthErr });
      }
    };

    void doHealthCheck().then(() => drain());
  }
});


import { createPiProcessPool, type PiProcessPool } from "./lib/pi-process-pool";
// ── ADR-0209: Thread classification on inbound messages ──────
import {
  buildClassifierPrompt,
  buildThreadIndex,
  classifyByHaikuResult,
  classifyByReplyTo,
  formatThreadIndexForPrompt,
  getActiveThreads,
  getThreadsSnapshot,
  parseClassifierResponse,
  recordOutboundAnchor,
  resolveClassification,
  type ThreadClassification,
} from "./lib/thread-tracker";

const THREAD_SNAPSHOT_PATH = join(homedir(), ".joelclaw", "state", "thread-snapshot.json");

/** ADR-0209: Warm pi process pool for sub-second thread classification */
const classifierPool: PiProcessPool = createPiProcessPool({
  model: "anthropic/claude-haiku-4-5",
  timeoutMs: 6000,
  maxIdleMs: 5 * 60 * 1000, // recycle every 5min
  onEvent: (event, detail) => {
    // Log pool events at debug level (warm.used, cold.start, timeout, etc.)
    if (event === "timeout" || event === "spawn.failed" || event === "cold.start") {
      void emitGatewayOtel({
        level: event === "cold.start" ? "debug" : "warn",
        component: "pi-process-pool",
        action: `pool.${event}`,
        success: event === "cold.start",
        metadata: detail,
      });
    }
  },
});

/** Persist thread state so gateway extension can read it on compaction */
function persistThreadSnapshot(): void {
  try {
    const dir = join(homedir(), ".joelclaw", "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const snapshot = getThreadsSnapshot();
    writeFile(THREAD_SNAPSHOT_PATH, JSON.stringify({ threads: snapshot, ts: Date.now() }, null, 2)).catch(() => {});
  } catch {}
}
/** Cheap haiku call for thread classification (~200ms) */
async function classifyThread(
  userMessage: string,
  channel: string,
  replyToAnchor?: string,
  inboundAnchor?: string,
): Promise<{ threadId: string; replyToAnchor: string | null }> {
  // 1. Reply-to hard signal
  if (replyToAnchor) {
    const replyClassification = classifyByReplyTo(channel, replyToAnchor);
    if (replyClassification) {
      const resolved = resolveClassification(replyClassification, channel, inboundAnchor);
      return { threadId: resolved.thread.id, replyToAnchor: resolved.replyToAnchor };
    }
  }

  // 2. Haiku classifier
  const active = getActiveThreads();
  const classifierPrompt = buildClassifierPrompt(userMessage, active);

  try {
    const startMs = Date.now();
    const raw = await classifierPool.infer(classifierPrompt);

    const result = parseClassifierResponse(raw);
    if (result) {
      const classification = classifyByHaikuResult(result);
      const resolved = resolveClassification(classification, channel, inboundAnchor);
      const elapsed = Date.now() - startMs;
      const poolStats = classifierPool.stats();

      void emitGatewayOtel({
        level: "debug",
        component: "thread-tracker",
        action: "thread.classified",
        success: true,
        metadata: {
          threadId: resolved.thread.id,
          threadLabel: resolved.thread.label,
          isNew: classification.isNew,
          confidence: result.confidence,
          source: classification.source,
          activeThreads: active.length,
          classifyMs: elapsed,
          poolWarm: poolStats.warm,
          poolAvgMs: poolStats.avgMs,
        },
      });

      persistThreadSnapshot();
      return { threadId: resolved.thread.id, replyToAnchor: resolved.replyToAnchor };
    }
  } catch (err) {
    void emitGatewayOtel({
      level: "warn",
      component: "thread-tracker",
      action: "thread.classify.failed",
      success: false,
      error: String(err),
      metadata: { activeThreads: active.length, poolStats: classifierPool.stats() },
    });
  }

  // 3. Fallback: continue most recent active thread (never create junk "conversation" threads)
  if (active.length > 0 && active[0]) {
    const resolved = resolveClassification(
      { threadId: active[0].id, threadLabel: active[0].label, isNew: false, confidence: 0.5, source: "continuation" },
      channel,
      inboundAnchor,
    );
    persistThreadSnapshot();
    return { threadId: resolved.thread.id, replyToAnchor: resolved.replyToAnchor };
  }

  // 4. No threads at all → create first thread (only path that creates without haiku)
  const resolved = resolveClassification(
    { threadId: "new", threadLabel: "general", isNew: true, confidence: 0.3, source: "continuation" },
    channel,
    inboundAnchor,
  );
  persistThreadSnapshot();
  return { threadId: resolved.thread.id, replyToAnchor: null };
}

const enqueueToGateway = async (source: string, prompt: string, metadata?: Record<string, unknown>) => {
  // ADR-0209: Extract channel + anchors from source/metadata
  const channel = source.split(":")[0] ?? "unknown";
  const replyToAnchor = typeof metadata?.replyTo === "string" ? metadata.replyTo : undefined;
  const inboundAnchor = typeof metadata?.telegramMessageId === "number"
    ? String(metadata.telegramMessageId)
    : typeof metadata?.discordMessageId === "string"
      ? metadata.discordMessageId
      : undefined;
  // ADR-0209: Classify thread (haiku ~200ms, reply-to ~0ms)
  const threadCtx = await classifyThread(prompt, channel, replyToAnchor, inboundAnchor);

  const queueMetadata = buildHumanTurnQueueMetadata(source, metadata);

  const withChannelContext = injectChannelContext(prompt, {
    source,
    threadName: typeof metadata?.discordThreadName === "string" ? metadata.discordThreadName : undefined,
  });
  // ADR-0209 V4: Minimal thread tag only — full index is injected via
  // compaction recovery (V2), NOT per-prompt (causes context bloat).
  let threadTag = "";
  if (threadCtx.threadId) {
    const allThreads = getActiveThreads();
    const current = allThreads.find((t) => t.id === threadCtx.threadId);
    if (current && current.label !== "general") {
      threadTag = `[thread: ${current.label}]`;
    }
  }
  const withThreadContext = threadTag
    ? `${withChannelContext}\n${threadTag}`
    : withChannelContext;

  await enqueue(source, withThreadContext, queueMetadata, {
    threadId: threadCtx.threadId,
    replyToAnchor: threadCtx.replyToAnchor ?? undefined,
  });
  void drain();
};

// ── Redis channel (self-healing — retries on failure, won't crash daemon) ──
await startRedisChannel(enqueueToGateway);

const redisClient = getRedisClient();
await maybeRefreshChannelHealthMuteState(true);
if (redisClient) {
  await initMessageStore(
    redisClient,
    {
      emit: (action: string, detail: string, extra?: Record<string, unknown>) => {
        void emitGatewayOtel({
          level: detail === "error" ? "error" : detail === "warn" ? "warn" : detail === "info" ? "info" : "debug",
          component: "message-store",
          action,
          success: true,
          metadata: {
            ...extra,
            source: "gateway",
            message_store_detail: detail,
          },
        });
      },
    },
  );
  await trimOld();
} else {
  console.warn("[gateway:store] redis command client unavailable; durable replay skipped");
}

// ── Discord channel ────────────────────────────────────
if (DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID) {
  registerChannel("discord", {
    send: async (message, context) => {
      const envelope = normalizeOutboundMessage(message);
      const channelId = context?.source
        ? parseDiscordChannelId(context.source) ?? undefined
        : undefined;
      if (!channelId) {
        console.error("[gateway:discord] send: no channel ID in context", { source: context?.source });
        return;
      }
      try {
        await sendDiscord(channelId, envelope.text);
      } catch (error) {
        console.error("[gateway:discord] send failed", { channelId, error: String(error) });
      }
    },
  });

  try {
    await startDiscord(DISCORD_TOKEN, DISCORD_ALLOWED_USER_ID, enqueueToGateway, {
      redis: redisClient,
      abortCurrentTurn: async () => {
        await session.abort();
      },
    });

    // ── Discord MCQ adapter (ADR-0122) ────────────────────────
    const discordClient = getDiscordClient();
    if (discordClient) {
      try {
        registerDiscordMcqAdapter(fetchDiscordChannel, getDiscordClient as () => any);
        console.log("[gateway] discord MCQ adapter registered");
        void emitGatewayOtel({
          level: "info",
          component: "daemon",
          action: "daemon.discord.mcq_adapter_registered",
          success: true,
        });
      } catch (error) {
        console.error("[gateway] discord MCQ adapter registration failed", { error: String(error) });
        void emitGatewayOtel({
          level: "error",
          component: "daemon",
          action: "daemon.discord.mcq_adapter_failed",
          success: false,
          error: String(error),
        });
      }
    }
  } catch (error) {
    console.error("[gateway] discord failed to start; discord channel disabled", { error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "daemon",
      action: "daemon.discord.start_failed",
      success: false,
      error: String(error),
    });
  }
} else {
  console.warn("[gateway] discord disabled — set DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_ID env vars");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.discord.disabled",
    success: false,
  });
}

// ── iMessage channel ───────────────────────────────────
if (IMESSAGE_ALLOWED_SENDER) {
  registerChannel("imessage", {
    send: async (message) => {
      const envelope = normalizeOutboundMessage(message);
      try {
        await sendIMessage(IMESSAGE_ALLOWED_SENDER, envelope.text);
      } catch (error) {
        console.error("[gateway] imessage send failed", { error: String(error) });
      }
    },
  });

  await startIMessage(IMESSAGE_ALLOWED_SENDER, enqueueToGateway, {
    abortCurrentTurn: async () => {
      await session.abort();
    },
  });
} else {
  console.warn("[gateway] imessage disabled — set IMESSAGE_ALLOWED_SENDER env var");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.imessage.disabled",
    success: false,
  });
}

// ── Telegram channel ───────────────────────────────────
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  await startTelegram(TELEGRAM_TOKEN, TELEGRAM_USER_ID, enqueueToGateway, {
    configureBot: async (bot) => {
      await initializeTelegramCommandHandler({
        bot,
        enqueue: enqueueToGateway,
        redis: redisClient,
        chatId: TELEGRAM_USER_ID,
        getStatusSnapshot: getGatewayStatusSnapshot,
      });
    },
    abortCurrentTurn: async () => {
      await session.abort();
    },
  });

  // ADR-0209: Record outbound Telegram message IDs for thread reply-to
  setOutboundMessageIdCallback((messageId: number) => {
    const threadCtx = getActiveThreadContext();
    if (threadCtx?.threadId) {
      recordOutboundAnchor(threadCtx.threadId, "telegram", String(messageId));
    }
  });

  try {
    await updatePinnedStatus();
  } catch (error) {
    console.warn("[gateway] pinned status update failed after telegram startup; continuing", error);
  }
} else {
  console.warn("[gateway] telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID env vars");
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.telegram.disabled",
    success: false,
  });
}

// ── Slack channel ──────────────────────────────────────
registerChannel("slack", {
  send: async (message, context) => {
    // ADR-0131: suppress replies to passive intel messages
    if (context?.source?.startsWith("slack-intel:")) return;

    const envelope = normalizeOutboundMessage(message);
    const sourceTarget = context?.source?.startsWith("slack:")
      ? context.source
      : undefined;
    const target = sourceTarget ?? SLACK_DEFAULT_CHANNEL_ID;
    if (!target) {
      console.error("[gateway:slack] send: no slack target in context/source/default", {
        source: context?.source,
      });
      return;
    }

    try {
      await sendSlack(target, envelope.text);
    } catch (error) {
      console.error("[gateway:slack] send failed", { target, error: String(error) });
    }
  },
});

try {
  await startSlack(enqueueToGateway, {
    allowedUserId: SLACK_ALLOWED_USER_ID,
  });
  channelInfo.slack = isSlackStarted();
} catch (error) {
  channelInfo.slack = false;
  console.error("[gateway] slack failed to start; slack channel disabled", { error: String(error) });
  void emitGatewayOtel({
    level: "error",
    component: "daemon",
    action: "daemon.slack.start_failed",
    success: false,
    error: String(error),
  });
}

await maybeRefreshChannelHealthMuteState(true);
const initialChannelHealth = getChannelHealthSummary();
syncChannelHealthAlertState(initialChannelHealth);
syncChannelHealState(initialChannelHealth);

// ── Init fallback controller (ADR-0091) ──────────────────
// Must happen after Telegram starts so notify can send alerts.
fallbackController.init(
  {
    setModel: async (m) => {
      // Resolve the full pi model object (with api, baseUrl, cost, etc.)
      // The fallback controller passes { provider, id } from the joelclaw catalog,
      // but pi's stream() needs model.api to resolve the API provider.
      const ref = m as { provider: string; id: string };
      const fullModel = getModel(ref.provider as any, ref.id as any);
      if (!fullModel) {
        throw new Error(`[gateway:fallback] pi model not found: ${ref.provider}/${ref.id}`);
      }
      return session.setModel(fullModel as any);
    },
    get model() { return session.model; },
  },
  (text: string) => {
    console.log("[gateway:fallback]", text);
    if (TELEGRAM_TOKEN && TELEGRAM_USER_ID && shouldSendFallbackTelegramNotice(text)) {
      sendTelegram(TELEGRAM_USER_ID, text, { silent: false }).catch(() => {});
    }
  },
);

if (redisClient) {
  // Replay after channels initialize so telegram-originated turns can use command/callback adapters.
  await replayUnacked();
}

// ── Media outbound: satellite sessions push files, we deliver ──────
// Self-healing: retries connection independently, errors don't propagate
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  const startMediaOutbound = async () => {
    const Redis = (await import("ioredis")).default;
    const mediaSub = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    const mediaCmd = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    mediaSub.on("error", () => {});
    mediaCmd.on("error", () => {});
    await mediaSub.connect();
    await mediaCmd.connect();
    await mediaSub.subscribe("joelclaw:notify:media-outbound");

    const drainMediaOutbound = async () => {
      try {
        const raw = await mediaCmd.lrange("joelclaw:media:outbound", 0, -1);
        if (raw.length === 0) return;
        await mediaCmd.del("joelclaw:media:outbound");

        for (const item of raw) {
          try {
            const evt = JSON.parse(item) as {
              payload: { filePath: string; caption?: string; chatId?: number };
            };
            const chatId = evt.payload.chatId ?? TELEGRAM_USER_ID;
            if (!chatId) continue;
            console.log("[gateway] media outbound →", { chatId, filePath: evt.payload.filePath });
            await sendTelegramMedia(chatId, evt.payload.filePath, {
              caption: evt.payload.caption,
            });
          } catch (err) {
            console.error("[gateway] media outbound failed", { error: err });
          }
        }
      } catch (err) {
        console.error("[gateway] media outbound drain failed", { error: err });
      }
    };

    mediaSub.on("message", () => { void drainMediaOutbound(); });
    await drainMediaOutbound();
    console.log("[gateway] media outbound listener started");
  };

  // Don't let media outbound failure crash daemon startup
  startMediaOutbound().catch((error) => {
    console.error("[gateway] media outbound initial connect failed — ioredis will retry", { error: String(error) });
  });
}

// ── Message outbound: Inngest functions push messages, we deliver via channel interface ──
{
  const startMessageOutbound = async () => {
    const Redis = (await import("ioredis")).default;
    const msgSub = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    const msgCmd = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    msgSub.on("error", () => {});
    msgCmd.on("error", () => {});
    await msgSub.connect();
    await msgCmd.connect();
    await msgSub.subscribe("joelclaw:notify:outbound");
    const telegramMessageOutboundChannel = new TelegramChannel();
    type MessageChannelAdapter = {
      send: (target: string, text: string) => Promise<void>;
      sendMedia?: (target: string, media: SendMediaPayload) => Promise<void>;
    };

    const resolveMessageChannel = (channelRef: string): {
      adapter: MessageChannelAdapter;
      target: string;
      telegramChatId?: number;
    } | undefined => {
      if (channelRef === "telegram" || channelRef.startsWith("telegram:")) {
        const chatId = parseChatId(channelRef) ?? TELEGRAM_USER_ID;
        if (!chatId) return undefined;

        return {
          adapter: {
            send: (target, text) => telegramMessageOutboundChannel.send(target, text),
            sendMedia: telegramMessageOutboundChannel.sendMedia
              ? (target, media) => telegramMessageOutboundChannel.sendMedia!(target, media)
              : undefined,
          },
          target: `telegram:${chatId}`,
          telegramChatId: chatId,
        };
      }

      if (channelRef === "slack" || channelRef.startsWith("slack:")) {
        return {
          adapter: {
            send: (target, text) => sendSlack(target, text),
          },
          target: channelRef,
        };
      }

      if (channelRef === "discord" || channelRef.startsWith("discord:")) {
        return {
          adapter: {
            send: (target, text) => sendDiscord(target, text),
          },
          target: parseDiscordChannelId(channelRef) ?? channelRef,
        };
      }

      if (channelRef === "imessage" || channelRef.startsWith("imessage:")) {
        return {
          adapter: {
            send: (target, text) => sendIMessage(target, text),
          },
          target: channelRef.startsWith("imessage:") ? channelRef.slice("imessage:".length) : channelRef,
        };
      }

      return undefined;
    };

    const drainMessageOutbound = async () => {
      try {
        const raw = await msgCmd.lrange("joelclaw:outbound:messages", 0, -1);
        if (raw.length === 0) return;
        await msgCmd.del("joelclaw:outbound:messages");

        for (const item of raw) {
          try {
            const msg = JSON.parse(item) as {
              channel: string;
              text: string;
              inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
              edit_message_id?: number;
              remove_keyboard?: boolean;
              media_url?: string;
              media_path?: string;
              mime_type?: string;
              caption?: string;
            };

            const resolvedChannel = resolveMessageChannel(msg.channel);
            const hasMedia = Boolean(msg.media_url || msg.media_path);

            console.log("[gateway] message outbound →", {
              channel: msg.channel,
              hasKeyboard: !!msg.inline_keyboard,
              edit: msg.edit_message_id,
              hasMedia,
            });

            if (!resolvedChannel) {
              console.warn("[gateway] message outbound: unsupported channel", { channel: msg.channel });
              continue;
            }

            const { adapter, target, telegramChatId } = resolvedChannel;

            if (hasMedia) {
              const media: SendMediaPayload = {
                ...(msg.media_url ? { url: msg.media_url } : {}),
                ...(msg.media_path ? { path: msg.media_path } : {}),
                mimeType: msg.mime_type
                  ?? inferMimeTypeFromMediaPathOrUrl(msg.media_path ?? msg.media_url)
                  ?? "application/octet-stream",
                ...(msg.caption || msg.text ? { caption: msg.caption ?? msg.text } : {}),
              };

              if (adapter.sendMedia) {
                await adapter.sendMedia(target, media);
              } else {
                const mediaLink = msg.media_url ?? msg.media_path ?? "";
                const fallbackText = [msg.caption ?? msg.text, mediaLink]
                  .filter((part): part is string => Boolean(part && part.trim()))
                  .join("\n");
                await adapter.send(target, fallbackText || mediaLink);
              }
              continue;
            }

            if (msg.channel === "telegram" || msg.channel.startsWith("telegram:")) {
              const tgBot = getBot();
              if (!tgBot) {
                console.error("[gateway] message outbound: telegram bot not available");
                continue;
              }
              if (!telegramChatId) continue;

              if (msg.edit_message_id) {
                // Edit existing message
                await tgBot.api.editMessageText(telegramChatId, msg.edit_message_id, msg.text, {
                  parse_mode: "HTML",
                  reply_markup: msg.remove_keyboard ? { inline_keyboard: [] } : undefined,
                }).catch((err) => console.warn("[gateway] edit message failed", err));
              } else {
                // Send new message
                await tgBot.api.sendMessage(telegramChatId, msg.text, {
                  parse_mode: "HTML",
                  reply_markup: msg.inline_keyboard ? { inline_keyboard: msg.inline_keyboard } : undefined,
                });
              }
            } else {
              await adapter.send(target, msg.text);
            }
          } catch (err) {
            console.error("[gateway] message outbound item failed", { error: err });
          }
        }
      } catch (err) {
        console.error("[gateway] message outbound drain failed", { error: err });
      }
    };

    msgSub.on("message", () => { void drainMessageOutbound(); });
    await drainMessageOutbound();
    console.log("[gateway] message outbound listener started");
  };

  startMessageOutbound().catch((error) => {
    console.error("[gateway] message outbound initial connect failed — ioredis will retry", { error: String(error) });
  });
}

const heartbeatRunner = startHeartbeatRunner();
const queueDrainTimer = setInterval(() => {
  void drain();
}, 1000);

// ── Self-healing watchdog ──────────────────────────────
// Monitors subsystem health every 30s. Logs degraded state.
// Detects stuck sessions (no turn_end for 10min after a prompt).
// _lastTurnEndAt and _lastPromptAt declared near session init (line ~85) to avoid TDZ
const watchdogTimer = setInterval(() => {
  void maybeNotifyChannelHealth();
  void maybeHealChannels();
  void maybeRunIdleGatewayMaintenance().catch((error) => {
    console.error("[gateway:watchdog] idle maintenance failed", {
      error: String(error),
    });
  });

  const now = Date.now();
  const uptimeMs = now - startedAt;
  const redisOk = isRedisHealthy();
  const telegramOk = channelInfo.telegram; // grammy self-heals via long-polling retry
  const waitingForTurnEnd = Boolean(_idleResolve);
  const maintenanceActive = isGatewayMaintenanceActive();
  const stuckMs = waitingForTurnEnd && !maintenanceActive && _lastPromptAt > _lastTurnEndAt ? now - _lastPromptAt : 0;
  const isStuck = stuckMs > STUCK_THRESHOLD_MS;
  const failures = getConsecutiveFailures();
  const fallbackGraceRemainingMs = getFallbackWatchdogGraceRemainingMs({
    fallbackActive: fallbackController.state.active,
    fallbackActiveSince: fallbackController.state.activeSince,
    now,
    fallbackGraceMs: WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS,
  });
  const isDead = shouldTreatSessionAsDead({
    consecutiveFailures: failures,
    fallbackActive: fallbackController.state.active,
    fallbackActiveSince: fallbackController.state.activeSince,
    now,
    fallbackGraceMs: WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS,
  });
  const recoveryPending = Boolean(stuckRecovery);

  if (stuckRecovery && now >= stuckRecovery.deadlineAt) {
    const overdueMs = now - stuckRecovery.deadlineAt;
    console.error("[gateway:watchdog] stuck recovery timed out — restarting daemon", {
      overdueMs,
      queueDepth: getQueueDepth(),
      promptAgeMs: now - stuckRecovery.promptAt,
    });
    void emitGatewayOtel({
      level: "fatal",
      component: "daemon.watchdog",
      action: "watchdog.session_stuck.recovery_timeout",
      success: false,
      error: "stuck_recovery_timeout",
      metadata: {
        overdueMs,
        recoveryGraceMs: STUCK_RECOVERY_GRACE_MS,
        queueDepth: getQueueDepth(),
        immediateTelegram: true,
      },
    });
    void gracefulShutdown("watchdog:stuck-recovery-timeout");
    return;
  }

  if (!redisOk || isStuck || isDead || recoveryPending) {
    console.warn("[gateway:watchdog] health check", {
      redis: redisOk ? "ok" : "DEGRADED",
      telegram: telegramOk ? "ok" : "disabled",
      ws: { port: wsServer.port, clients: wsClients.size },
      queueDepth: getQueueDepth(),
      uptimeMs,
      consecutiveFailures: failures,
      waitingForTurnEnd,
      maintenanceActive,
      ...(maintenanceActive
        ? {
            maintenanceKind: activeGatewayMaintenance?.kind ?? (session.isCompacting ? "compact" : undefined),
            maintenanceReason: activeGatewayMaintenance?.reason ?? (session.isCompacting ? "session_compacting" : undefined),
            maintenanceElapsedMs: activeGatewayMaintenance ? now - activeGatewayMaintenance.startedAt : undefined,
          }
        : {}),
      ...(isStuck ? { stuckForMs: stuckMs, lastPromptAt: new Date(_lastPromptAt).toISOString() } : {}),
      ...(stuckRecovery
        ? {
            recoveryPending: true,
            recoveryDeadlineInMs: Math.max(0, stuckRecovery.deadlineAt - now),
          }
        : {}),
      ...(fallbackController.state.active && fallbackGraceRemainingMs > 0
        ? {
            fallbackActive: true,
            fallbackGraceRemainingMs,
          }
        : {}),
    });
  }

  if (isStuck && !stuckRecovery) {
    stuckRecovery = {
      startedAt: now,
      promptAt: _lastPromptAt,
      deadlineAt: now + STUCK_RECOVERY_GRACE_MS,
    };

    console.error("[gateway:watchdog] session appears stuck — attempting abort", {
      stuckForMs: stuckMs,
      recoveryGraceMs: STUCK_RECOVERY_GRACE_MS,
    });
    void emitGatewayOtel({
      level: "error",
      component: "daemon.watchdog",
      action: "watchdog.session_stuck",
      success: false,
      metadata: {
        stuckForMs: stuckMs,
        queueDepth: getQueueDepth(),
        recoveryGraceMs: STUCK_RECOVERY_GRACE_MS,
      },
    });

    session.abort().catch((e: any) => {
      console.error("[gateway:watchdog] abort failed", { error: e?.message });
      void emitGatewayOtel({
        level: "error",
        component: "daemon.watchdog",
        action: "watchdog.session_stuck.abort_failed",
        success: false,
        error: e?.message ?? String(e),
        metadata: {
          queueDepth: getQueueDepth(),
          recoveryGraceMs: STUCK_RECOVERY_GRACE_MS,
        },
      });
    });
  }

  if (isDead) {
    console.error("[gateway:watchdog] session appears dead — too many consecutive prompt failures", {
      consecutiveFailures: failures,
    });
    void emitGatewayOtel({
      level: "fatal",
      component: "daemon.watchdog",
      action: "watchdog.session_dead",
      success: false,
      error: "session_recovery_restart",
      metadata: {
        consecutiveFailures: failures,
        queueDepth: getQueueDepth(),
        immediateTelegram: true,
      },
    });
    // Self-restart: the launchd service will bring us back
    // Messages are persisted in Redis Stream, so they'll replay on restart
    console.error("[gateway:watchdog] initiating self-restart for session recovery");
    void gracefulShutdown("watchdog:dead-session");
  }
}, 30_000);

// Expose health for CLI / external checks
function getHealthStatus(): {
  ok: boolean;
  available: boolean;
  healthy: boolean;
  checkedAt: string;
  mode: string;
  degradedCapabilities: Array<{ key: string; reason: string }>;
  reason: string;
  since: string;
  reconnectAttempts: number;
  components: Record<string, string | number | boolean>;
  status: Record<string, unknown>;
} {
  const now = Date.now();
  const redisOk = isRedisHealthy();
  const redisState = getRedisRuntimeState();
  const waitingForTurnEnd = Boolean(_idleResolve);
  const maintenanceActive = isGatewayMaintenanceActive();
  const stuckMs = waitingForTurnEnd && !maintenanceActive && _lastPromptAt > _lastTurnEndAt ? now - _lastPromptAt : 0;
  const failures = getConsecutiveFailures();
  const fallbackGraceRemainingMs = getFallbackWatchdogGraceRemainingMs({
    fallbackActive: fallbackController.state.active,
    fallbackActiveSince: fallbackController.state.activeSince,
    now,
    fallbackGraceMs: WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS,
  });
  const isDead = shouldTreatSessionAsDead({
    consecutiveFailures: failures,
    fallbackActive: fallbackController.state.active,
    fallbackActiveSince: fallbackController.state.activeSince,
    now,
    fallbackGraceMs: WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS,
  });
  const recoveryPending = Boolean(stuckRecovery);
  const recoveryDeadlineInMs = stuckRecovery
    ? Math.max(0, stuckRecovery.deadlineAt - now)
    : 0;
  const available = stuckMs < STUCK_THRESHOLD_MS && !isDead;
  const healthy = redisOk && available;
  const degradedCapabilities = getDegradedCapabilities();
  const channels = getChannelRuntimeSnapshots();
  const status = getStatusPayload();

  return {
    ok: available,
    available,
    healthy,
    checkedAt: new Date(now).toISOString(),
    mode: redisState.mode,
    degradedCapabilities,
    reason: redisState.reason,
    since: new Date(redisState.lastTransitionAt).toISOString(),
    reconnectAttempts: redisState.reconnectAttempts,
    components: {
      redis: redisOk ? "ok" : "degraded",
      telegram: channelInfo.telegram
        ? channels.telegram?.healthy === true
          ? String(channels.telegram?.ownerState ?? "ok")
          : typeof channels.telegram?.pollingState === "string" && channels.telegram.pollingState !== "idle"
            ? String(channels.telegram.pollingState)
            : String(channels.telegram?.ownerState ?? "degraded")
        : "disabled",
      discord: channelInfo.discord
        ? (channels.discord?.healthy === true ? "ok" : "degraded")
        : "disabled",
      imessage: channelInfo.imessage
        ? (channels.imessage?.healthy === true ? "ok" : "degraded")
        : "disabled",
      slack: Boolean(SLACK_ALLOWED_USER_ID)
        ? (channels.slack?.healthy === true ? "ok" : "degraded")
        : "disabled",
      ws: `ok (${wsClients.size} clients)`,
      session: isDead
        ? `dead (${failures} consecutive failures)`
        : recoveryPending
          ? `recovering (${Math.round(recoveryDeadlineInMs / 1000)}s)`
          : maintenanceActive
            ? `maintenance (${activeGatewayMaintenance?.kind ?? (session.isCompacting ? "compact" : "active")})`
            : stuckMs > STUCK_THRESHOLD_MS
              ? `stuck (${Math.round(stuckMs / 1000)}s)`
              : "ok",
      consecutivePromptFailures: failures,
      waitingForTurnEnd,
      maintenanceActive,
      maintenanceKind: activeGatewayMaintenance?.kind ?? (session.isCompacting ? "compact" : undefined),
      maintenanceReason: activeGatewayMaintenance?.reason ?? (session.isCompacting ? "session_compacting" : undefined),
      maintenanceElapsedMs: activeGatewayMaintenance ? now - activeGatewayMaintenance.startedAt : undefined,
      stuckRecoveryPending: recoveryPending,
      stuckRecoveryDeadlineMs: recoveryDeadlineInMs,
      fallbackGraceRemainingMs,
    },
    status,
  };
}

await writeFile(PID_FILE, `${process.pid}\n`);
await writeFile(SESSION_ID_FILE, `${session.sessionId}\n`);

console.log("[gateway] daemon started", {
  pid: process.pid,
  sessionId: session.sessionId,
  model: describeModel(session.model),
  cwd: HOME,
  agentDir: AGENT_DIR,
  channels: [
    "redis",
    "console",
    ...(channelInfo.telegram ? ["telegram"] : []),
    ...(channelInfo.discord ? ["discord"] : []),
    ...(channelInfo.imessage ? ["imessage"] : []),
    ...(channelInfo.slack ? ["slack"] : []),
  ],
  pidFile: PID_FILE,
  wsPort: wsServer.port,
  wsPortFile: WS_PORT_FILE,
});

// Register gateway agent with agent-mail (non-blocking, non-fatal)
void registerGatewayAgent();

void emitGatewayOtel({
  level: "info",
  component: "daemon",
  action: "daemon.started",
  success: true,
  metadata: {
    pid: process.pid,
    wsPort: wsServer.port,
    telegramEnabled: Boolean(TELEGRAM_TOKEN && TELEGRAM_USER_ID),
    discordEnabled: Boolean(DISCORD_TOKEN && DISCORD_ALLOWED_USER_ID),
    imessageEnabled: Boolean(IMESSAGE_ALLOWED_SENDER),
    slackEnabled: channelInfo.slack,
  },
});

let shuttingDown = false;

async function removeFileIfOwned(path: string, expectedValue: string, label: string): Promise<void> {
  let currentValue: string | undefined;
  try {
    currentValue = (await readFile(path, "utf8")).trim();
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    console.error(`[gateway] failed reading ${label} before cleanup`, { error: String(error) });
    return;
  }

  if (currentValue !== expectedValue) {
    console.warn(`[gateway] skipping ${label} cleanup; ownership changed`, {
      expected: expectedValue,
      actual: currentValue,
    });
    return;
  }

  try {
    await rm(path, { force: true });
  } catch (error) {
    console.error(`[gateway] failed removing ${label}`, { error });
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[gateway] shutting down", { signal });
  void emitGatewayOtel({
    level: "warn",
    component: "daemon",
    action: "daemon.shutdown.started",
    success: true,
    metadata: { signal },
  });

  clearInterval(queueDrainTimer);
  clearInterval(watchdogTimer);

  try {
    wsServer.stop(true);
  } catch (error) {
    console.error("[gateway] ws server shutdown failed", { error });
  }

  try {
    await heartbeatRunner.shutdown();
  } catch (error) {
    console.error("[gateway] heartbeat shutdown failed", { error });
  }

  try {
    await shutdownDiscord();
  } catch (error) {
    console.error("[gateway] discord shutdown failed", { error });
  }

  try {
    await shutdownIMessage();
  } catch (error) {
    console.error("[gateway] imessage shutdown failed", { error });
  }

  try {
    await shutdownSlack();
  } catch (error) {
    console.error("[gateway] slack shutdown failed", { error });
  }

  try {
    await shutdownTelegram();
  } catch (error) {
    console.error("[gateway] telegram shutdown failed", { error });
  }

  try {
    await shutdownRedisChannel();
  } catch (error) {
    console.error("[gateway] redis shutdown failed", { error });
  }

  try {
    fallbackController.dispose();
  } catch { /* swallow */ }

  try {
    session.dispose();
  } catch (error) {
    console.error("[gateway] session disposal failed", { error });
  }

  await removeFileIfOwned(PID_FILE, String(process.pid), "PID file");
  await removeFileIfOwned(WS_PORT_FILE, String(wsServer.port), "WS port file");
  await removeFileIfOwned(SESSION_ID_FILE, session.sessionId, "session ID file");

  process.exit(0);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

// Keep the event loop alive — Bun may exit after session.prompt() resolves
// even with bot.start() polling and setInterval timers active
setInterval(() => {}, 30_000);

process.on("uncaughtException", (error) => {
  console.error("[gateway] uncaught exception", { error: error.message, stack: error.stack });
  void emitGatewayOtel({
    level: "fatal",
    component: "daemon",
    action: "daemon.uncaught_exception",
    success: false,
    error: error.message,
    metadata: { stack: error.stack, immediateTelegram: true },
  });
  broadcastWs({ type: "error", message: error.message });
});

const REDIS_RETRY_REJECTION_WINDOW_MS = 30_000;
let lastRedisRetryRejectionAt = 0;
let suppressedRedisRetryRejections = 0;

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);

  if (message.includes("Theme not initialized")) {
    console.error("[gateway] suppressed TUI extension error:", message);
    return;
  }

  const normalizedMessage = message.toLowerCase();
  const isRedisRetryRejection = normalizedMessage.includes("max retries per request limit")
    || message.includes("MaxRetriesPerRequestError");

  if (isRedisRetryRejection) {
    const now = Date.now();
    if (now - lastRedisRetryRejectionAt < REDIS_RETRY_REJECTION_WINDOW_MS) {
      suppressedRedisRetryRejections += 1;
      return;
    }

    const suppressedCount = suppressedRedisRetryRejections;
    suppressedRedisRetryRejections = 0;
    lastRedisRetryRejectionAt = now;

    console.warn("[gateway] redis command retries exhausted", {
      suppressedInWindow: suppressedCount,
      message,
    });

    void emitGatewayOtel({
      level: "warn",
      component: "daemon",
      action: "daemon.redis.max_retries_rejection",
      success: false,
      error: message,
      metadata: {
        suppressedInWindow: suppressedCount,
      },
    });
    return;
  }

  console.error("[gateway] unhandled rejection", { reason });
  void emitGatewayOtel({
    level: "error",
    component: "daemon",
    action: "daemon.unhandled_rejection",
    success: false,
    error: message,
  });
  broadcastWs({ type: "error", message: `Unhandled rejection: ${message}` });
});
