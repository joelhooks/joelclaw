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
} from "./inngest/functions";
import { dailyDigest } from "./inngest/functions/daily-digest";

const app = new Hono();

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
];

// Derive function names from the actual array — no stale hardcoded list
const functionNames = registeredFunctions.map(
  (fn) => (fn as any).opts?.id ?? "unknown"
);

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
    },
  })
);

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
