import { execSync } from "node:child_process";
import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest } from "./inngest/client";
import { webhookApp } from "./webhooks/server";

// ── Load webhook secrets from agent-secrets at startup ──────────
// ADR-0048: Webhook providers read from process.env at verification time.
// Secrets are leased once at startup with a long TTL.
const BOOT_WORKER_ROLE = (process.env.WORKER_ROLE ?? "host").trim().toLowerCase();
const SHOULD_LEASE_WEBHOOK_SECRETS = BOOT_WORKER_ROLE !== "cluster";

const WEBHOOK_SECRETS = [
  { env: "VERCEL_WEBHOOK_SECRET", secret: "vercel_webhook_secret" },
  { env: "FRONT_WEBHOOK_SECRET", secret: "front_webhook_secret" },
  { env: "TODOIST_CLIENT_SECRET", secret: "todoist_client_secret" },
  { env: "GITHUB_WEBHOOK_SECRET", secret: "github_webhook_secret" },
  { env: "MUX_WEBHOOK_SECRET", secret: "mux_signing_secret" },
] as const;

if (SHOULD_LEASE_WEBHOOK_SECRETS) {
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
} else {
  console.log("[secrets] skipping local webhook secret leasing in cluster worker role");
}

import { emitInngestRegistryLoaded } from "./inngest/functions";
import {
  clusterFunctionDefinitions,
  clusterFunctionIds,
} from "./inngest/functions/index.cluster";
import {
  hostFunctionDefinitions,
  hostFunctionIds,
} from "./inngest/functions/index.host";
import { emitOtelEvent, emitValidatedOtelEvent } from "./observability/emit";

const app = new Hono();
const OTEL_EMIT_TOKEN = process.env.OTEL_EMIT_TOKEN;
const WORKER_STARTED_AT = new Date().toISOString();
const WORKER_CWD = process.cwd();
const LEGACY_WORKER_CLONE_FRAGMENT = "/Code/system-bus-worker/";
const LEGACY_WORKER_CLONE_DETECTED = WORKER_CWD.includes(LEGACY_WORKER_CLONE_FRAGMENT);

type WorkerRole = "host" | "cluster";
type FunctionDefinition = { opts?: { id?: string } };

function parseWorkerRole(value: string | undefined): WorkerRole {
  const normalized = (value ?? "host").trim().toLowerCase();
  if (normalized === "cluster") return "cluster";
  if (normalized !== "host") {
    console.warn(`[worker] unknown WORKER_ROLE="${value}", defaulting to host`);
  }
  return "host";
}

function getFunctionId(fn: FunctionDefinition): string {
  return fn.opts?.id ?? "unknown";
}

function findDuplicateIds(ids: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
}

const WORKER_ROLE = parseWorkerRole(process.env.WORKER_ROLE);
let lastRegistrationAt = WORKER_STARTED_AT;
const configuredServeHost = process.env.INNGEST_SERVE_HOST?.trim();
const serveHost = configuredServeHost
  ? configuredServeHost
  : (WORKER_ROLE === "host" ? "http://host.docker.internal:3111" : undefined);

const registeredFunctions = (
  WORKER_ROLE === "cluster"
    ? clusterFunctionDefinitions
    : hostFunctionDefinitions
) as any[];
const duplicateFunctionIds = findDuplicateIds([
  ...hostFunctionIds,
  ...clusterFunctionIds,
]);

// Derive function names from the actual array — no stale hardcoded list
const functionNames = registeredFunctions.map(
  (fn) => getFunctionId(fn as FunctionDefinition)
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
    worker: {
      role: WORKER_ROLE,
      startedAt: WORKER_STARTED_AT,
      lastRegistrationAt,
      roleCounts: {
        host: hostFunctionDefinitions.length,
        cluster: clusterFunctionDefinitions.length,
        active: registeredFunctions.length,
      },
      duplicateFunctionIds,
      hasDuplicateFunctionIds: duplicateFunctionIds.length > 0,
    },
    runtime: {
      cwd: WORKER_CWD,
      deploymentModel: "single-source",
      legacyCloneDetected: LEGACY_WORKER_CLONE_DETECTED,
    },
    webhooks: {
      endpoint: "/webhooks/:provider",
      providers: ["todoist", "front", "vercel", "github"],
    },
    events: {
      "pipeline/video.requested": "Download video + NAS transfer → emits transcript.requested",
      "pipeline/transcript.requested":
        "Transcribe audio or accept text → vault note → emits content/summarize.requested",
      "content/summarize.requested": "Enrich any vault note with pi + web research",
      "content/updated": "Vault content changed → sync ADRs + discoveries to website",
      "typesense/vault-sync.requested": "Queue request for debounced/targeted vault re-index",
      "discovery/noted": "Investigate interesting find → vault note in Resources/discoveries/",
      "system/log.written": "Write canonical log entry",
      "media/received": "Process media from channels → vision/transcribe → notify gateway",
      "todoist/*": "Todoist webhook events (comment.added, task.completed, task.created)",
      "front/*": "Front webhook events (message.received, message.sent, assignee.changed)",
      "vip/email.received": "VIP email deep-dive workflow (Opus + meetings + memory + GitHub + todos)",
      "vercel/*": "Vercel webhook events (deploy.succeeded, deploy.error, deploy.created, deploy.canceled)",
      "github/*": "GitHub webhook events (workflow_run.completed, package.published)",
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

// Inngest serve endpoint — registers functions and handles execution.
// ADR-0089: host workers keep explicit serveHost for Docker callback compatibility.
// Cluster workers rely on connect mode and should not advertise host.docker.internal.
const inngestApiOptions: {
  client: typeof inngest;
  functions: any[];
  serveHost?: string;
} = {
  client: inngest,
  functions: registeredFunctions,
};
if (serveHost) {
  inngestApiOptions.serveHost = serveHost;
}
const inngestApiHandler = inngestServe(inngestApiOptions);

const INNGEST_DEBUG_KEYS = ["fnId", "stepId", "runId", "probe", "sync", "batch"] as const;

function parseQueryMap(req: Request): Record<string, string> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if ((INNGEST_DEBUG_KEYS as readonly string[]).includes(key)) {
      filtered[key] = value;
      continue;
    }

    if (key.length < 40) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function summarizeInngestBody(rawBody: string | null): Record<string, unknown> | null {
  if (!rawBody) return null;

  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { kind: "empty", size: rawBody.length };
  }

  if (trimmed.length > 3_000) {
    return {
      kind: "body_truncated",
      size: rawBody.length,
      preview: trimmed.slice(0, 200),
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const objectParsed = parsed as Record<string, unknown>;
      return {
        kind: "json",
        keys: Object.keys(objectParsed),
        size: rawBody.length,
      };
    }

    return {
      kind: typeof parsed,
      value: String(parsed).slice(0, 200),
      size: rawBody.length,
    };
  } catch {
    return {
      kind: "text",
      size: rawBody.length,
      preview: trimmed.slice(0, 200),
    };
  }
}

app.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  async (c) => {
    const start = Date.now();
    if (c.req.method === "PUT") {
      lastRegistrationAt = new Date().toISOString();
    }

    const query = parseQueryMap(c.req.raw);
    const rawBody = await c.req.raw.clone().text().catch(() => null);
    const bodySummary = summarizeInngestBody(rawBody);
    const fnId = query.fnId;

    const response = await inngestApiHandler(c);
    const status = response.status;

    if (c.req.method === "POST" || c.req.method === "PUT") {
      if (status >= 400 || !fnId) {
        const elapsedMs = Date.now() - start;
        const remote = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
        console.warn("[inngest:req]", {
          method: c.req.method,
          path: c.req.path,
          status,
          remote,
          fnId: fnId ?? "missing",
          runId: query.runId ?? "missing",
          stepId: query.stepId ?? "missing",
          probe: query.probe ?? "missing",
          query,
          bodySummary,
          elapsedMs,
          contentType: c.req.header("content-type") ?? "unknown",
          userAgent: c.req.header("user-agent") ?? "unknown",
          requestId: c.req.header("x-request-id") ?? c.req.header("x-inngest-request-id") ?? null,
        });
      }
    }

    return response;
  }
);

export default {
  port: 3111,
  fetch: app.fetch,
};

console.log("🚌 system-bus worker running on http://localhost:3111");
console.log(`👷 worker role: ${WORKER_ROLE}`);
console.log("📡 Inngest endpoint: http://localhost:3111/api/inngest");
if (serveHost) {
  console.log(`🌐 serveHost: ${serveHost}`);
} else {
  console.log("🌐 serveHost: (connect-mode default)");
}
console.log(`📋 ${registeredFunctions.length} functions registered`);
if (duplicateFunctionIds.length > 0) {
  console.warn(
    `[worker] duplicate function ids detected across roles: ${duplicateFunctionIds.join(", ")}`
  );
}
setTimeout(() => {
  void fetch("http://127.0.0.1:3111/api/inngest", { method: "PUT" }).catch(() => {});
}, 5_000);
void emitOtelEvent({
  level: "info",
  source: "worker",
  component: "serve",
  action: "worker.started",
  success: true,
  metadata: {
    port: 3111,
    workerRole: WORKER_ROLE,
    registeredFunctions: registeredFunctions.length,
    duplicateFunctionIds,
    serveHost: serveHost ?? null,
    startedAt: WORKER_STARTED_AT,
    deploymentModel: "single-source",
    workerCwd: WORKER_CWD,
    legacyCloneDetected: LEGACY_WORKER_CLONE_DETECTED,
  },
}).catch((error) => {
  console.warn("[otel] failed to emit worker start event", error);
});
