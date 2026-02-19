import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest } from "./inngest/client";
import { webhookApp } from "./webhooks/server";
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
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
} from "./inngest/functions";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "system-bus",
    status: "running",
    functions: [
      "video-download",
      "transcript-process",
      "content-summarize",
      "system-logger",
      "memory/observe-session",
      "memory/reflect",
      "content-sync",
      "discovery-capture",
      "memory/review-promote",
      "embedding-generate",
      "memory/backfill-observe",
      "system-heartbeat",
      "system-heartbeat-wake",
      "system/agent-dispatch",
      "agent-loop-plan",
      "agent-loop-test-writer",
      "agent-loop-implement",
      "agent-loop-review",
      "agent-loop-judge",
      "agent-loop-complete",
      "agent-loop-retro",
      "media-process",
    ],
    webhooks: {
      endpoint: "/webhooks/:provider",
      providers: ["todoist"],
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
    functions: [
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
    ],
    serveHost: "http://host.docker.internal:3111",
  })
);

export default {
  port: 3111,
  fetch: app.fetch,
};

console.log("🚌 system-bus worker running on http://localhost:3111");
console.log("📡 Inngest endpoint: http://localhost:3111/api/inngest");
console.log(
  "📋 Functions: video-download, transcript-process, content-summarize, system-logger, memory/observe-session, memory/reflect, memory/review-promote, memory/backfill-observe, system-heartbeat, system/heartbeat.wake, system/agent-dispatch, agent-loop-plan, agent-loop-test-writer, agent-loop-implement, agent-loop-review, agent-loop-judge, agent-loop-complete, agent-loop-retro"
);
