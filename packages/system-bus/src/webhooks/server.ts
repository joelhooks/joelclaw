/**
 * Webhook gateway HTTP server.
 * Routes POST /webhooks/:provider to the correct adapter.
 * ADR-0048: Webhook Gateway for External Service Integration
 */

import { Hono } from "hono";
import { inngest } from "../inngest/client";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../observability/emit";
import { isTodoistTaskAgentClosed } from "../lib/todoist-agent-closed";
import type { WebhookProvider, NormalizedEvent } from "./types";
import { todoistProvider } from "./providers/todoist";
import { frontProvider } from "./providers/front";
import { vercelProvider } from "./providers/vercel";
import { githubProvider } from "./providers/github";

// ── Provider registry ────────────────────────────────────
const providers = new Map<string, WebhookProvider>();
providers.set(todoistProvider.id, todoistProvider);
providers.set(frontProvider.id, frontProvider);
providers.set(vercelProvider.id, vercelProvider);
providers.set(githubProvider.id, githubProvider);

// ── Rate limiting (auth failures per IP) ─────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 20;
const authFailures = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authFailures.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    return true; // no failures or window expired
  }

  return entry.count < RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    authFailures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// ── Max body size ────────────────────────────────────────
const MAX_BODY_SIZE = 256 * 1024; // 256KB

async function filterTodoistTaskCompletedEchoes(events: NormalizedEvent[]): Promise<NormalizedEvent[]> {
  const filtered: NormalizedEvent[] = [];

  for (const event of events) {
    if (event.name !== "task.completed") {
      filtered.push(event);
      continue;
    }

    const taskId = String(event.data.taskId ?? "").trim();
    if (!taskId) {
      filtered.push(event);
      continue;
    }

    const agentClosed = await isTodoistTaskAgentClosed(taskId);
    if (agentClosed) {
      console.debug("[webhooks] skipped todoist task.completed echo for agent-closed task", { taskId });
      continue;
    }

    filtered.push(event);
  }

  return filtered;
}

// ── Hono app ─────────────────────────────────────────────
export const webhookApp = new Hono();

// O11y: log every request before routing
webhookApp.use("*", async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const ua = c.req.header("user-agent") ?? "none";
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "direct";
  const funnel = c.req.header("tailscale-funnel-request") ?? "no";
  const deliveryId = c.req.header("x-todoist-delivery-id") ?? "";
  console.log(`[webhooks:req] ${method} ${path} ip=${ip} ua=${ua.slice(0, 40)} funnel=${funnel} delivery=${deliveryId}`);
  await next();
  console.log(`[webhooks:res] ${method} ${path} → ${c.res.status}`);
});

webhookApp.get("/", (c) =>
  c.json({
    service: "webhook-gateway",
    status: "running",
    providers: Array.from(providers.keys()),
    endpoint: "POST /webhooks/:provider",
  })
);

webhookApp.post("/:provider", async (c) => {
  const providerId = c.req.param("provider");
  const provider = providers.get(providerId);

  if (!provider) {
    return c.json({ ok: false, error: `Unknown provider: ${providerId}` }, 404);
  }

  return emitMeasuredOtelEvent(
    {
      level: "info",
      source: "worker",
      component: "webhook",
      action: "webhook.handler",
      metadata: { provider: providerId },
    },
    async () => {
      // Rate limit check
      const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
      if (!checkRateLimit(ip)) {
        return c.json({ ok: false, error: "Too many auth failures" }, 429);
      }

      // Read raw body (needed for HMAC verification)
      const rawBody = await c.req.text();

      if (rawBody.length > MAX_BODY_SIZE) {
        return c.json({ ok: false, error: "Request body too large" }, 413);
      }

      // Extract headers as plain object
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // Verify signature
      if (!provider.verifySignature(rawBody, headers)) {
        recordAuthFailure(ip);
        console.error("[webhooks] signature verification failed", {
          provider: providerId,
          ip,
        });
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "webhook",
          action: "webhook.signature_failed",
          success: false,
          metadata: {
            provider: providerId,
          },
        });
        return c.json({ ok: false, error: "Invalid signature" }, 401);
      }

      // Parse and normalize
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ ok: false, error: "Invalid JSON" }, 400);
      }

      let events = provider.normalizePayload(body, headers);
      if (providerId === "todoist" && events.length > 0) {
        events = await filterTodoistTaskCompletedEchoes(events);
      }
      const eventType =
        typeof body.type === "string"
          ? body.type
          : (headers["x-github-event"] ?? events[0]?.name ?? "unknown");

      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "webhook",
        action: "webhook.received",
        success: true,
        metadata: {
          provider: providerId,
          event_type: eventType,
        },
      });

      if (events.length === 0) {
        console.log("[webhooks] no matching events", {
          provider: providerId,
          type: body.type ?? "no-type",
          keys: Object.keys(body),
        });
        return c.json({ ok: true, events: 0, note: "No matching events" });
      }

      // Handle challenge/validation requests (Front sends x-front-challenge)
      const challengeEvent = events.find((e) => e.name === "_challenge");
      if (challengeEvent) {
        const challenge = (challengeEvent.data as any).challenge;
        console.log("[webhooks] challenge response", { provider: providerId });
        return c.text(challenge, 200, { "Content-Type": "text/plain" });
      }

      // Emit to Inngest
      try {
        await inngest.send(
          events.map((evt) => ({
            name: `${provider.eventPrefix}/${evt.name}` as any,
            data: evt.data as any,
            id: evt.idempotencyKey,
          }))
        );

        console.log("[webhooks] events emitted", {
          provider: providerId,
          count: events.length,
          names: events.map((e) => e.name),
        });

        return c.json({ ok: true, events: events.length });
      } catch (error: any) {
        console.error("[webhooks] inngest send failed", {
          provider: providerId,
          error: error?.message,
        });
        return c.json({ ok: false, error: "Failed to emit events" }, 500);
      }
    }
  );
});
