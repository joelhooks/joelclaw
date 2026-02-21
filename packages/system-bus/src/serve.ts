import { execSync } from "node:child_process";
import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest } from "./inngest/client";
import { webhookApp } from "./webhooks/server";

// ── Load webhook secrets from agent-secrets at startup ──────────
// ADR-0048: Webhook providers read from process.env at verification time.
// Secrets are leased once at startup with a long TTL.
const WEBHOOK_SECRETS = [
  { env: "VERCEL_WEBHOOK_SECRET", secret: "vercel_webhook_secret" },
  { env: "FRONT_WEBHOOK_SECRET", secret: "front_webhook_secret" },
  { env: "TODOIST_CLIENT_SECRET", secret: "todoist_client_secret" },
] as const;

for (const { env, secret } of WEBHOOK_SECRETS) {
  if (!process.env[env]) {
    try {
      const value = execSync(`secrets lease ${secret} --ttl 24h`, {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (value) {
        process.env[env] = value;
        console.log(`[secrets] loaded ${env} from agent-secrets`);
      }
    } catch {
      console.warn(`[secrets] ⚠️ failed to load ${env} — ${secret} webhook verification will fail`);
    }
  }
}
import {
  videoDownload,
  transcriptProcess,
  summarize,
  systemLogger,
  observeSessionFunction,
  reflect,
  contentSync,
  discoveryCapture,
  promote,
  embedText,
  backfillObserve,
  heartbeatCron,
  heartbeatWake,
  approvalRequest,
  approvalResolve,
  agentDispatch,
  mediaProcess,
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
  todoistMemoryReviewBridge,
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
  emailInboxCleanup,
  meetingAnalyze,
  granolaBackfill,
  friction,
  frictionFix,
  telnyxNotify,
  proposalTriage,
  batchReview,
  nightlyMaintenance,
  echoFizzle,
  taskTriage,
  checkSessions,
  checkTriggers,
  checkSystemHealth,
  networkStatusUpdate,
  checkMemoryReview,
  checkVaultSync,
  checkGranola,
  checkEmail,
  vipEmailReceived,
  checkCalendar,
  checkLoops,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  nasSoakSample,
  nasSoakReview,
  emitInngestRegistryLoaded,
} from "./inngest/functions";
import { dailyDigest } from "./inngest/functions/daily-digest";
import { emitOtelEvent, emitValidatedOtelEvent } from "./observability/emit";

const app = new Hono();
const OTEL_EMIT_TOKEN = process.env.OTEL_EMIT_TOKEN;

// Single source of truth for registered functions — never maintain a separate list.
const registeredFunctions = [
  videoDownload,
  transcriptProcess,
  summarize,
  systemLogger,
  observeSessionFunction,
  reflect,
  contentSync,
  discoveryCapture,
  promote,
  embedText,
  backfillObserve,
  heartbeatCron,
  heartbeatWake,
  approvalRequest,
  approvalResolve,
  agentDispatch,
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
  mediaProcess,
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
  emailInboxCleanup,
  meetingAnalyze,
  granolaBackfill,
  todoistMemoryReviewBridge,
  friction,
  frictionFix,
  telnyxNotify,
  proposalTriage,
  batchReview,
  nightlyMaintenance,
  echoFizzle,
  taskTriage,
  checkSessions,
  checkTriggers,
  checkSystemHealth,
  networkStatusUpdate,
  checkMemoryReview,
  checkVaultSync,
  checkGranola,
  checkEmail,
  vipEmailReceived,
  checkCalendar,
  checkLoops,
  dailyDigest,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  nasSoakSample,
  nasSoakReview,
];

// Derive function names from the actual array — no stale hardcoded list
const functionNames = registeredFunctions.map(
  (fn) => (fn as any).opts?.id ?? "unknown"
);
void emitInngestRegistryLoaded(functionNames).catch((error) => {
  console.warn("[otel] failed to emit registry snapshot", error);
});

app.get("/", (c) =>
  c.json({
    service: "system-bus",
    status: "running",
    functions: functionNames,
    count: registeredFunctions.length,
    webhooks: {
      endpoint: "/webhooks/:provider",
      providers: ["todoist", "front", "vercel"],
    },
    events: {
      "pipeline/video.requested": "Download video + NAS transfer → emits transcript.requested",
      "pipeline/transcript.requested":
        "Transcribe audio or accept text → vault note → emits content/summarize.requested",
      "content/summarize.requested": "Enrich any vault note with pi + web research",
      "content/updated": "Vault content changed → sync ADRs + discoveries to website",
      "discovery/noted": "Investigate interesting find → vault note in Resources/discoveries/",
      "system/log.written": "Write canonical log entry",
      "media/received": "Process media from channels → vision/transcribe → notify gateway",
      "todoist/*": "Todoist webhook events (comment.added, task.completed, task.created)",
      "front/*": "Front webhook events (message.received, message.sent, assignee.changed)",
      "vip/email.received": "VIP email deep-dive workflow (Opus + meetings + memory + GitHub + todos)",
      "vercel/*": "Vercel webhook events (deploy.succeeded, deploy.error, deploy.created, deploy.canceled)",
      "email/inbox.cleanup": "AI-powered inbox triage — classify + archive noise",
      "meeting/noted": "Analyze meeting → extract action items, decisions, people (ADR-0055)",
      "granola/backfill.requested": "Backfill all historical Granola meetings (ADR-0055)",
      "memory/digest.created": "Structured daily digest generated from raw daily memory log",
      "notification/call.requested": "Place outbound call via Telnyx, fallback to SMS if unanswered",
      "nas/soak.review.requested": "Evaluate NAS soak gates vs ADR-0088 and notify gateway",
    },
    observability: {
      ingestEndpoint: "/observability/emit",
    },
  })
);

// Internal ingest endpoint so gateway can emit events through the single worker write path.
app.post("/observability/emit", async (c) => {
  if (OTEL_EMIT_TOKEN) {
    const token = c.req.header("x-otel-emit-token");
    if (!token || token !== OTEL_EMIT_TOKEN) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const result = await emitValidatedOtelEvent(payload);
  if (!result.stored && !result.dropped) {
    return c.json(
      { ok: false, error: result.error ?? result.typesense.error ?? "store_failed", result },
      500
    );
  }
  return c.json({ ok: true, result });
});

// Webhook gateway — external services POST here
// ADR-0048: Webhook Gateway for External Service Integration
app.route("/webhooks", webhookApp);

// Inngest serve endpoint — registers functions and handles execution
// serveHost must match how the Inngest server (in Docker) reaches this worker
app.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  inngestServe({
    client: inngest,
    functions: registeredFunctions,
    serveHost: "http://host.docker.internal:3111",
  })
);

export default {
  port: 3111,
  fetch: app.fetch,
};

console.log("🚌 system-bus worker running on http://localhost:3111");
console.log("📡 Inngest endpoint: http://localhost:3111/api/inngest");
console.log(`📋 ${registeredFunctions.length} functions registered`);
void emitOtelEvent({
  level: "info",
  source: "worker",
  component: "serve",
  action: "worker.started",
  success: true,
  metadata: {
    port: 3111,
    registeredFunctions: registeredFunctions.length,
  },
}).catch((error) => {
  console.warn("[otel] failed to emit worker start event", error);
});
