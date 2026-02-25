/**
 * Vercel webhook provider adapter.
 * HMAC-SHA1 signature verification + deployment event normalization.
 * ADR-0048: Webhook Gateway for External Service Integration (Phase 3)
 *
 * Vercel webhook docs: https://vercel.com/docs/webhooks/webhooks-api
 * Signature: HMAC-SHA1(secret, rawBody) → hex, header: x-vercel-signature
 * Events: deployment.created, deployment.succeeded, deployment.error, deployment.canceled, deployment.ready
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

/** Vercel webhook type → normalized event name */
const EVENT_MAP: Record<string, string> = {
  "deployment.created": "deploy.created",
  "deployment.succeeded": "deploy.succeeded",
  "deployment.error": "deploy.error",
  "deployment.canceled": "deploy.canceled",
  "deployment.ready": "deploy.ready",
  "deployment.promoted": "deploy.promoted",
  // Legacy event names (Vercel sends both formats)
  "deployment-error": "deploy.error",
  "deployment-ready": "deploy.ready",
  "deployment-canceled": "deploy.canceled",
};

let warnedMissingSecret = false;

function getWebhookSecret(): string | null {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret || secret.trim().length === 0) {
    return null;
  }
  return secret;
}

export const vercelProvider: WebhookProvider = {
  id: "vercel",
  eventPrefix: "vercel",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-vercel-signature"];
    if (!signature) return false;

    const secret = getWebhookSecret();
    if (!secret) {
      if (!warnedMissingSecret) {
        console.warn("[vercel-webhook] VERCEL_WEBHOOK_SECRET not set — rejecting all inbound webhooks");
        warnedMissingSecret = true;
      }
      return false;
    }

    const computed = createHmac("sha1", secret)
      .update(rawBody)
      .digest("hex");

    try {
      return timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(computed, "hex"),
      );
    } catch {
      return false;
    }
  },

  normalizePayload(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): NormalizedEvent[] {
    const type = body.type as string | undefined;
    if (!type) return [];

    const mappedName = EVENT_MAP[type];
    if (!mappedName) return [];

    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const deployment = (payload.deployment ?? {}) as Record<string, unknown>;
    const links = (payload.links ?? {}) as Record<string, string>;
    const project = (payload.project ?? {}) as Record<string, unknown>;
    const meta = (deployment.meta ?? {}) as Record<string, unknown>;

    const deploymentId = String(deployment.id ?? "");
    const eventId = String(body.id ?? "");
    const idempotencyKey = `vercel-${type}-${eventId || deploymentId}-${body.createdAt ?? Date.now()}`;

    return [
      {
        name: mappedName,
        data: {
          deploymentId,
          deploymentUrl: String(deployment.url ?? ""),
          projectName: String(deployment.name ?? payload.name ?? ""),
          projectId: String(project.id ?? payload.projectId ?? ""),
          target: String(payload.target ?? ""),
          plan: String(payload.plan ?? ""),
          regions: Array.isArray(payload.regions) ? payload.regions : [],
          dashboardUrl: links.deployment ?? "",
          projectDashboardUrl: links.project ?? "",
          // Git metadata from deployment.meta
          gitCommitSha: String(meta.githubCommitSha ?? meta.gitlabCommitSha ?? ""),
          gitCommitMessage: String(meta.githubCommitMessage ?? meta.gitlabCommitMessage ?? ""),
          gitCommitAuthor: String(meta.githubCommitAuthorName ?? meta.gitlabCommitAuthorName ?? ""),
          gitBranch: String(meta.githubCommitRef ?? meta.gitlabCommitRef ?? ""),
          gitRepo: String(meta.githubCommitOrg ?? "") && String(meta.githubCommitRepo ?? "")
            ? `${meta.githubCommitOrg}/${meta.githubCommitRepo}`
            : "",
        },
        idempotencyKey,
      },
    ];
  },
};
