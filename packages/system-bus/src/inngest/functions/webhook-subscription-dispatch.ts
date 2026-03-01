import {
  claimWebhookDelivery,
  findMatchingWebhookSubscriptions,
  publishWebhookSubscriptionEvent,
  type WebhookSubscription,
} from "../../lib/webhook-subscriptions";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

type GithubWorkflowRunCompletedPayload = {
  deliveryId?: string;
  runId: number;
  runNumber: number | null;
  workflowName: string;
  conclusion: string;
  status: string;
  branch: string;
  headSha: string;
  actorLogin: string;
  repository: string;
  htmlUrl: string;
  completedAt: string;
  [key: string]: unknown;
};

type GithubWorkflowArtifact = {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  archiveDownloadUrl: string;
  url: string;
  createdAt?: string;
  expiresAt?: string;
};

function parseRepository(fullName: string): { owner: string; repo: string } | null {
  const trimmed = fullName.trim();
  if (!trimmed) return null;

  const [owner, repo, ...rest] = trimmed.split("/");
  if (!owner || !repo || rest.length > 0) return null;

  return { owner, repo };
}

async function fetchGithubWorkflowArtifacts(
  payload: GithubWorkflowRunCompletedPayload,
): Promise<{ artifacts: GithubWorkflowArtifact[]; error?: string }> {
  const repo = parseRepository(String(payload.repository ?? ""));
  if (!repo) {
    return { artifacts: [], error: "invalid repository" };
  }

  const runId = Number(payload.runId ?? 0);
  if (!Number.isFinite(runId) || runId <= 0) {
    return { artifacts: [], error: "invalid runId" };
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}/artifacts?per_page=100`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "joelclaw-webhook-subscriptions/1.0",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        artifacts: [],
        error: `GitHub artifacts API ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const parsed = (await response.json()) as {
      artifacts?: Array<{
        id?: number;
        name?: string;
        size_in_bytes?: number;
        expired?: boolean;
        archive_download_url?: string;
        url?: string;
        created_at?: string;
        expires_at?: string;
      }>;
    };

    const artifacts = Array.isArray(parsed.artifacts)
      ? parsed.artifacts
          .map((artifact) => ({
            id: Number(artifact.id ?? 0),
            name: String(artifact.name ?? ""),
            sizeInBytes: Number(artifact.size_in_bytes ?? 0),
            expired: Boolean(artifact.expired),
            archiveDownloadUrl: String(artifact.archive_download_url ?? ""),
            url: String(artifact.url ?? ""),
            createdAt: artifact.created_at,
            expiresAt: artifact.expires_at,
          }))
          .filter((artifact) => artifact.id > 0 && artifact.name.trim().length > 0)
      : [];

    return { artifacts };
  } catch (error) {
    return {
      artifacts: [],
      error: `GitHub artifacts fetch failed: ${String(error)}`,
    };
  }
}

function shortSha(value: string): string {
  return value ? value.slice(0, 8) : "unknown";
}

function buildWebhookPrompt(
  subscription: WebhookSubscription,
  payload: GithubWorkflowRunCompletedPayload,
  artifacts: GithubWorkflowArtifact[],
  artifactFetchError?: string,
): string {
  const artifactLines = artifacts.length > 0
    ? artifacts.slice(0, 10).map((artifact) =>
        `- ${artifact.name} (${artifact.sizeInBytes} bytes${artifact.expired ? ", expired" : ""})`
      )
    : ["- none"];

  const lines = [
    "## 🔔 Webhook Subscription Match",
    "",
    `**Subscription**: ${subscription.id}`,
    `**Repo**: ${String(payload.repository ?? "unknown")}`,
    `**Workflow**: ${String(payload.workflowName ?? "unknown")}`,
    `**Conclusion**: ${String(payload.conclusion || payload.status || "unknown")}`,
    `**Branch**: ${String(payload.branch ?? "unknown")}`,
    `**SHA**: \`${shortSha(String(payload.headSha ?? ""))}\``,
    `**Run**: #${String(payload.runNumber ?? payload.runId ?? "unknown")}`,
    `**Actor**: ${String(payload.actorLogin ?? "unknown")}`,
    payload.htmlUrl ? `**URL**: ${String(payload.htmlUrl)}` : "",
    "",
    "### Artifacts",
    ...artifactLines,
    artifactFetchError ? `\n⚠️ Artifact fetch error: ${artifactFetchError}` : "",
    "",
    "Take immediate follow-up action if needed.",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildDeliveryKey(payload: GithubWorkflowRunCompletedPayload): string {
  const runId = Number(payload.runId ?? 0);
  const deliveryId = typeof payload.deliveryId === "string" && payload.deliveryId.trim().length > 0
    ? payload.deliveryId.trim()
    : "no-delivery";

  return `${deliveryId}:${runId}`;
}

export const webhookSubscriptionDispatchGithubWorkflowRunCompleted = inngest.createFunction(
  {
    id: "webhook-subscription-dispatch-github-workflow-run-completed",
    name: "Webhook Subscriptions: Dispatch GitHub Workflow Run Completed",
    retries: 2,
    concurrency: {
      limit: 8,
      key: "event.data.runId",
    },
  },
  { event: "github/workflow_run.completed" },
  async ({ event, step }) => {
    const payload = event.data as GithubWorkflowRunCompletedPayload;
    const provider = "github";
    const eventName = "workflow_run.completed";

    await step.run("otel-webhook-dispatch-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "webhook-subscriptions",
        action: "webhook.subscription.dispatch.started",
        success: true,
        metadata: {
          provider,
          event: eventName,
          runId: payload.runId,
          repository: payload.repository,
        },
      });
    });

    const subscriptions = await step.run("match-subscriptions", async () =>
      findMatchingWebhookSubscriptions(provider, eventName, payload),
    );

    if (subscriptions.length === 0) {
      await step.run("otel-webhook-dispatch-noop", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "webhook-subscriptions",
          action: "webhook.subscription.dispatch.no_match",
          success: true,
          metadata: {
            provider,
            event: eventName,
            runId: payload.runId,
            repository: payload.repository,
          },
        });
      });

      return {
        status: "noop",
        provider,
        event: eventName,
        runId: payload.runId,
        matchedSubscriptions: 0,
      };
    }

    const artifactOutcome = await step.run("fetch-artifacts", async () =>
      fetchGithubWorkflowArtifacts(payload),
    );

    const dispatchResult = await step.run("dispatch-matches", async () => {
      let duplicates = 0;
      let notifiedSessions = 0;
      const delivered: Array<{
        subscriptionId: string;
        status: "delivered" | "duplicate";
        sessionId?: string;
      }> = [];

      const deliveryKey = buildDeliveryKey(payload);

      for (const subscription of subscriptions) {
        const claimed = await claimWebhookDelivery(
          subscription.id,
          `${deliveryKey}:${subscription.id}`,
        );

        if (!claimed) {
          duplicates += 1;
          delivered.push({
            subscriptionId: subscription.id,
            status: "duplicate",
            ...(subscription.sessionId ? { sessionId: subscription.sessionId } : {}),
          });
          continue;
        }

        const matchedPayload: Record<string, unknown> = {
          provider,
          event: eventName,
          subscriptionId: subscription.id,
          matchedAt: new Date().toISOString(),
          repository: payload.repository,
          workflowName: payload.workflowName,
          conclusion: payload.conclusion,
          status: payload.status,
          branch: payload.branch,
          headSha: payload.headSha,
          actorLogin: payload.actorLogin,
          runId: payload.runId,
          runNumber: payload.runNumber,
          htmlUrl: payload.htmlUrl,
          completedAt: payload.completedAt,
          deliveryId: payload.deliveryId,
          artifacts: artifactOutcome.artifacts,
          ...(artifactOutcome.error ? { artifactFetchError: artifactOutcome.error } : {}),
        };

        await publishWebhookSubscriptionEvent(subscription.id, matchedPayload);

        if (subscription.sessionId) {
          const prompt = buildWebhookPrompt(
            subscription,
            payload,
            artifactOutcome.artifacts,
            artifactOutcome.error,
          );

          await pushGatewayEvent({
            type: "webhook.subscription.matched",
            source: "inngest/github/workflow_run.completed",
            originSession: subscription.sessionId,
            payload: {
              ...matchedPayload,
              originSession: subscription.sessionId,
              prompt,
            },
          });

          notifiedSessions += 1;
        }

        delivered.push({
          subscriptionId: subscription.id,
          status: "delivered",
          ...(subscription.sessionId ? { sessionId: subscription.sessionId } : {}),
        });
      }

      return {
        delivered,
        duplicates,
        notifiedSessions,
      };
    });

    await step.run("otel-webhook-dispatch-completed", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "webhook-subscriptions",
        action: "webhook.subscription.dispatch.completed",
        success: true,
        metadata: {
          provider,
          event: eventName,
          runId: payload.runId,
          repository: payload.repository,
          matchedSubscriptions: subscriptions.length,
          deliveredCount: dispatchResult.delivered.filter((item) => item.status === "delivered").length,
          duplicates: dispatchResult.duplicates,
          notifiedSessions: dispatchResult.notifiedSessions,
          artifactCount: artifactOutcome.artifacts.length,
          artifactFetchError: artifactOutcome.error,
        },
      });
    });

    return {
      status: "dispatched",
      provider,
      event: eventName,
      runId: payload.runId,
      repository: payload.repository,
      matchedSubscriptions: subscriptions.length,
      artifacts: artifactOutcome.artifacts,
      ...(artifactOutcome.error ? { artifactFetchError: artifactOutcome.error } : {}),
      ...dispatchResult,
    };
  },
);
