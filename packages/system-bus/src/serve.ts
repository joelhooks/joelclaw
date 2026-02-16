import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest } from "./inngest/client";
import {
  videoDownload,
  transcriptProcess,
  summarize,
  systemLogger,
  observeSessionFunction,
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
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
      "agent-loop-plan",
      "agent-loop-test-writer",
      "agent-loop-implement",
      "agent-loop-review",
      "agent-loop-judge",
      "agent-loop-complete",
      "agent-loop-retro",
    ],
    events: {
      "pipeline/video.requested": "Download video + NAS transfer → emits transcript.requested",
      
      "pipeline/transcript.requested":
        "Transcribe audio or accept text → vault note → emits content/summarize.requested",
      "content/summarize.requested": "Enrich any vault note with pi + web research",
      "system/log.written": "Write canonical log entry",
    },
  })
);

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
      agentLoopPlan,
      agentLoopTestWriter,
      agentLoopImplement,
      agentLoopReview,
      agentLoopJudge,
      agentLoopComplete,
      agentLoopRetro,
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
  "📋 Functions: video-download, transcript-process, content-summarize, system-logger, memory/observe-session"
);
