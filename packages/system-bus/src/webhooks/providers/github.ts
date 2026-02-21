/**
 * GitHub webhook provider adapter.
 * HMAC-SHA256 signature verification + workflow/package event normalization.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

function getWebhookSecret(): string | null {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.trim().length === 0) return null;
  return secret;
}

function buildSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function safeEqualSignature(expected: string, received: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

export const githubProvider: WebhookProvider = {
  id: "github",
  eventPrefix: "github",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-hub-signature-256"];
    if (!signature) return false;

    const secret = getWebhookSecret();
    if (!secret) return false;

    const computed = buildSignature(secret, rawBody);
    return safeEqualSignature(computed, signature);
  },

  normalizePayload(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): NormalizedEvent[] {
    const githubEvent = headers["x-github-event"];
    const delivery = headers["x-github-delivery"] ?? "no-delivery";

    if (githubEvent === "workflow_run") {
      const action = String(body.action ?? "");
      if (action !== "completed") return [];

      const workflowRun = (body.workflow_run ?? {}) as Record<string, unknown>;
      const repository = (body.repository ?? {}) as Record<string, unknown>;
      const workflow = (body.workflow ?? {}) as Record<string, unknown>;
      const headRepository = (workflowRun.head_repository ?? {}) as Record<string, unknown>;

      const runId = Number(workflowRun.id ?? 0) || 0;
      const workflowId = Number(workflow.id ?? workflowRun.workflow_id ?? 0) || 0;

      return [{
        name: "workflow_run.completed",
        idempotencyKey: `github-workflow-run-completed-${delivery}-${runId || Date.now()}`,
        data: {
          action,
          runId,
          runNumber: Number(workflowRun.run_number ?? 0) || null,
          runAttempt: Number(workflowRun.run_attempt ?? 0) || null,
          workflowId,
          workflowName: String(workflow.name ?? workflowRun.name ?? ""),
          event: String(workflowRun.event ?? ""),
          status: String(workflowRun.status ?? ""),
          conclusion: String(workflowRun.conclusion ?? ""),
          htmlUrl: String(workflowRun.html_url ?? ""),
          jobsUrl: String(workflowRun.jobs_url ?? ""),
          logsUrl: String(workflowRun.logs_url ?? ""),
          branch: String(workflowRun.head_branch ?? ""),
          headSha: String(workflowRun.head_sha ?? ""),
          actorLogin: String((workflowRun.actor as Record<string, unknown> | undefined)?.login ?? ""),
          repository: String(repository.full_name ?? ""),
          repositoryUrl: String(repository.html_url ?? ""),
          headRepository: String(headRepository.full_name ?? repository.full_name ?? ""),
          createdAt: String(workflowRun.created_at ?? ""),
          updatedAt: String(workflowRun.updated_at ?? ""),
          completedAt: String(workflowRun.updated_at ?? workflowRun.created_at ?? ""),
        },
      }];
    }

    if (githubEvent === "package") {
      const action = String(body.action ?? "");
      if (action !== "published") return [];

      const repository = (body.repository ?? {}) as Record<string, unknown>;
      const pkg = (body.package ?? {}) as Record<string, unknown>;
      const packageVersion = (body.package_version ?? {}) as Record<string, unknown>;

      return [{
        name: "package.published",
        idempotencyKey: `github-package-published-${delivery}`,
        data: {
          action,
          ecosystem: String(pkg.ecosystem ?? ""),
          packageName: String(pkg.name ?? ""),
          packageType: String(pkg.package_type ?? ""),
          packageHtmlUrl: String(pkg.html_url ?? ""),
          versionName: String(packageVersion.name ?? ""),
          versionHtmlUrl: String(packageVersion.html_url ?? ""),
          repository: String(repository.full_name ?? ""),
          repositoryUrl: String(repository.html_url ?? ""),
          sender: String(((body.sender ?? {}) as Record<string, unknown>).login ?? ""),
        },
      }];
    }

    return [];
  },
};
