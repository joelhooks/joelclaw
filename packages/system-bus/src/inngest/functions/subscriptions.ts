import { inngest } from "../client";
import {
  checkAtomFeed,
  checkGitHubRepo,
  checkPageHash,
  parseGitHubRepo,
  type FeedCheckResult,
  type FeedEntry,
} from "../../lib/feed-checker";
import {
  getSubscription,
  listSubscriptions,
  type Subscription,
  updateSubscription,
} from "../../lib/subscriptions";
import { emitOtelEvent } from "../../observability/emit";
import { MODEL } from "../../lib/models";
import { parsePiJsonAssistant, traceLlmGeneration } from "../../lib/langfuse";

type SubscriptionCheckEvent = {
  subscriptionId: string;
  forced?: boolean;
  source?: string;
};

type SummaryResult = {
  summary: string;
  publishEntryIds: string[];
  model: string;
};

const INTERVAL_MS: Record<Subscription["checkInterval"], number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function isDueForCheck(subscription: Subscription, now: number, forced = false): boolean {
  if (forced) return true;
  if (!subscription.lastChecked || subscription.lastChecked <= 0) return true;
  const interval = INTERVAL_MS[subscription.checkInterval] ?? INTERVAL_MS.daily;
  return now - subscription.lastChecked >= interval;
}

function summarizeEntriesFallback(entries: FeedEntry[]): string {
  if (entries.length === 0) return "No new updates.";
  const lines = entries.slice(0, 5).map((entry) => `- ${entry.title}${entry.url ? ` (${entry.url})` : ""}`);
  return `New updates detected:\n${lines.join("\n")}`;
}

function parseSummaryJson(raw: string): { summary?: string; publishEntryIds?: string[] } | null {
  const direct = raw.trim();
  const candidates: string[] = [direct];

  const match = direct.match(/\{[\s\S]*\}/u);
  if (match?.[0]) candidates.push(match[0]);

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate) as {
        summary?: unknown;
        publishEntryIds?: unknown;
      };

      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : undefined;

      const publishEntryIds = Array.isArray(parsed.publishEntryIds)
        ? parsed.publishEntryIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : undefined;

      return { summary, publishEntryIds };
    } catch {
      // continue
    }
  }

  return null;
}

async function runSubscriptionCheck(subscription: Subscription): Promise<FeedCheckResult> {
  switch (subscription.type) {
    case "atom":
    case "rss":
      return checkAtomFeed(subscription.feedUrl, subscription.lastEntryId || undefined);

    case "github": {
      const parsed = parseGitHubRepo(subscription.feedUrl);
      if (!parsed) {
        throw new Error(`Invalid GitHub repository identifier: ${subscription.feedUrl}`);
      }

      return checkGitHubRepo(parsed.owner, parsed.repo, subscription.lastEntryId || undefined);
    }

    case "page":
      return checkPageHash(subscription.feedUrl, subscription.lastContentHash || undefined);

    case "bluesky":
      return {
        hasChanges: false,
        newEntries: [],
        latestEntryId: subscription.lastEntryId,
      };

    default:
      return {
        hasChanges: false,
        newEntries: [],
      };
  }
}

async function summarizeUpdates(
  subscription: Subscription,
  entries: FeedEntry[]
): Promise<SummaryResult> {
  if (entries.length === 0) {
    return {
      summary: "No new updates.",
      publishEntryIds: [],
      model: MODEL.HAIKU,
    };
  }

  const prompt = [
    "You summarize subscription updates for Joel.",
    "Return strict JSON with keys: summary (string), publishEntryIds (string[]).",
    "Only include entry IDs in publishEntryIds if they are meaningfully new and worth posting to discovery.",
    `Subscription: ${subscription.name}`,
    `Source URL: ${subscription.feedUrl}`,
    "Entries:",
    ...entries.map((entry, index) => {
      const lines = [
        `Entry ${index + 1}`,
        `id: ${entry.id}`,
        `title: ${entry.title}`,
        `url: ${entry.url ?? ""}`,
        `publishedAt: ${entry.publishedAt ?? ""}`,
        `summary: ${entry.summary ?? entry.content?.slice(0, 600) ?? ""}`,
      ];
      return lines.join("\n");
    }),
  ].join("\n\n");

  const llmStartedAt = Date.now();
  const proc = Bun.spawn(
    [
      "pi",
      "-p",
      "--no-session",
      "--no-extensions",
      "--mode",
      "json",
      "--model",
      MODEL.HAIKU,
      prompt,
    ],
    {
      env: { ...process.env, TERM: "dumb" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const parsedPi = parsePiJsonAssistant(stdoutRaw);
  const assistantText = parsedPi?.text ?? stdoutRaw;

  if (exitCode !== 0 && !assistantText.trim()) {
    throw new Error(`summary model failed (${exitCode}): ${stderrRaw.slice(0, 500)}`);
  }

  await traceLlmGeneration({
    traceName: "subscription_summary",
    generationName: "subscription_summary_haiku",
    component: "subscription-check",
    action: "subscription.summary.generated",
    input: {
      subscriptionId: subscription.id,
      entryCount: entries.length,
    },
    output: assistantText.slice(0, 1200),
    provider: parsedPi?.provider,
    model: parsedPi?.model ?? MODEL.HAIKU,
    usage: parsedPi?.usage,
    durationMs: Date.now() - llmStartedAt,
    metadata: {
      subscriptionId: subscription.id,
      entryCount: entries.length,
    },
  });

  const structured = parseSummaryJson(assistantText);
  const summary = structured?.summary ?? summarizeEntriesFallback(entries);
  const publishEntryIds = structured?.publishEntryIds?.length
    ? structured.publishEntryIds
    : entries.slice(0, 3).map((entry) => entry.id);

  return {
    summary,
    publishEntryIds,
    model: MODEL.HAIKU,
  };
}

function selectPublishEntries(entries: FeedEntry[], publishIds: string[]): FeedEntry[] {
  if (entries.length === 0) return [];
  if (publishIds.length === 0) return [];

  const index = new Map(entries.map((entry) => [entry.id, entry] as const));
  const selected: FeedEntry[] = [];

  for (const id of publishIds) {
    const entry = index.get(id);
    if (entry) selected.push(entry);
  }

  return selected;
}

function checkpointFrom(result: FeedCheckResult, fallback: Subscription): {
  lastEntryId: string;
  lastContentHash: string;
} {
  return {
    lastEntryId: result.latestEntryId ?? result.newEntries[0]?.id ?? fallback.lastEntryId,
    lastContentHash: result.contentHash ?? fallback.lastContentHash,
  };
}

export const subscriptionCheckFeeds = inngest.createFunction(
  {
    id: "subscription/check-feeds",
    retries: 1,
    concurrency: { limit: 1, key: "subscription-check-feeds" },
  },
  [{ cron: "0 * * * *" }, { event: "subscription/check-feeds.requested" }],
  async ({ event, step }) => {
    const now = Date.now();
    const forced = event.name === "subscription/check-feeds.requested"
      && Boolean((event.data as { forceAll?: boolean })?.forceAll);

    await step.run("otel-subscription-check-feeds-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "subscription-check",
        action: "subscription.check_feeds.started",
        success: true,
        metadata: {
          trigger: event.name,
          forced,
        },
      });
    });

    const activeSubscriptions = await step.run("load-active-subscriptions", async () => {
      const subscriptions = await listSubscriptions();
      return subscriptions.filter((subscription) => subscription.active);
    });

    const dueSubscriptions = await step.run("filter-due-subscriptions", async (): Promise<Subscription[]> => {
      return activeSubscriptions.filter((subscription) => isDueForCheck(subscription, now, forced));
    });

    if (dueSubscriptions.length === 0) {
      await step.run("otel-subscription-check-feeds-noop", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "subscription-check",
          action: "subscription.check_feeds.noop",
          success: true,
          metadata: {
            trigger: event.name,
            activeCount: activeSubscriptions.length,
            dueCount: 0,
          },
        });
      });

      return {
        status: "noop",
        activeCount: activeSubscriptions.length,
        dueCount: 0,
      };
    }

    await step.sendEvent(
      "fan-out-subscription-checks",
      dueSubscriptions.map((subscription) => ({
        name: "subscription/check.requested" as const,
        data: {
          subscriptionId: subscription.id,
          forced,
          source: event.name,
        },
      }))
    );

    await step.run("otel-subscription-check-feeds-completed", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "subscription-check",
        action: "subscription.check_feeds.completed",
        success: true,
        metadata: {
          trigger: event.name,
          activeCount: activeSubscriptions.length,
          dueCount: dueSubscriptions.length,
        },
      });
    });

    return {
      status: "dispatched",
      activeCount: activeSubscriptions.length,
      dueCount: dueSubscriptions.length,
      subscriptionIds: dueSubscriptions.map((subscription) => subscription.id),
    };
  }
);

export const subscriptionCheckSingle = inngest.createFunction(
  {
    id: "subscription/check-single",
    retries: 1,
    concurrency: { limit: 4, key: "subscription-check-single" },
  },
  { event: "subscription/check.requested" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as
      | import("../middleware/gateway").GatewayContext
      | undefined;

    const payload = event.data as SubscriptionCheckEvent;
    const subscriptionId = payload.subscriptionId;

    await step.run("otel-subscription-check-single-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "subscription-check",
        action: "subscription.check_single.started",
        success: true,
        metadata: {
          subscriptionId,
          forced: payload.forced ?? false,
          source: payload.source ?? event.name,
        },
      });
    });

    const subscription = await step.run("load-subscription", async () => {
      return getSubscription(subscriptionId);
    });

    if (!subscription || !subscription.active) {
      await step.run("otel-subscription-check-single-skip", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "subscription-check",
          action: "subscription.check_single.skipped",
          success: true,
          metadata: {
            subscriptionId,
            reason: "missing_or_inactive",
          },
        });
      });

      return {
        status: "noop",
        reason: "missing_or_inactive",
        subscriptionId,
      };
    }

    try {
      const checkResult = await step.run("fetch-feed", async () => {
        return runSubscriptionCheck(subscription);
      });

      const checkpoint = checkpointFrom(checkResult, subscription);

      const isFirstCheck = !subscription.lastChecked || subscription.lastChecked <= 0;
      if (isFirstCheck) {
        await step.run("update-subscription-initial-baseline", async () => {
          await updateSubscription(subscription.id, {
            lastChecked: Date.now(),
            lastEntryId: checkpoint.lastEntryId,
            lastContentHash: checkpoint.lastContentHash,
          });
        });

        await step.run("otel-subscription-check-single-initialized", async () => {
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "subscription-check",
            action: "subscription.check_single.initialized",
            success: true,
            metadata: {
              subscriptionId: subscription.id,
              entryCount: checkResult.newEntries.length,
              baselineEntryId: checkpoint.lastEntryId,
            },
          });
        });

        return {
          status: "initialized",
          subscriptionId: subscription.id,
          baselineEntryId: checkpoint.lastEntryId,
        };
      }

      if (!checkResult.hasChanges || checkResult.newEntries.length === 0) {
        await step.run("update-subscription-last-checked", async () => {
          await updateSubscription(subscription.id, {
            lastChecked: Date.now(),
            lastEntryId: checkpoint.lastEntryId,
            lastContentHash: checkpoint.lastContentHash,
          });
        });

        await step.run("otel-subscription-check-single-noop", async () => {
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "subscription-check",
            action: "subscription.check_single.no_changes",
            success: true,
            metadata: {
              subscriptionId: subscription.id,
            },
          });
        });

        return {
          status: "noop",
          reason: "no_changes",
          subscriptionId: subscription.id,
        };
      }

      const summaryResult = await step.run("summarize", async () => {
        if (!subscription.summarize) {
          return {
            summary: summarizeEntriesFallback(checkResult.newEntries),
            publishEntryIds: checkResult.newEntries.slice(0, 3).map((entry) => entry.id),
            model: "none",
          } satisfies SummaryResult;
        }

        return summarizeUpdates(subscription, checkResult.newEntries);
      });

      const entriesToPublish = selectPublishEntries(
        checkResult.newEntries,
        summaryResult.publishEntryIds
      );

      const publishedCount = subscription.publishToCool
        ? await step.run("publish", async () => {
            if (entriesToPublish.length === 0) return 0;

            const events = entriesToPublish.map((entry) => ({
              name: "discovery/noted" as const,
              data: {
                url: entry.url ?? subscription.feedUrl,
                context: [
                  `Subscription: ${subscription.name}`,
                  `Title: ${entry.title}`,
                  entry.summary ? `Summary: ${entry.summary}` : undefined,
                  entry.publishedAt ? `Published: ${entry.publishedAt}` : undefined,
                ]
                  .filter((line): line is string => Boolean(line))
                  .join("\n"),
              },
            }));

            await step.sendEvent("publish-discovery-events", events);
            return events.length;
          })
        : 0;

      const notified = await step.run("notify", async () => {
        if (!subscription.notify || !gateway) return false;

        await gateway.notify("subscription.updated", {
          subscriptionId: subscription.id,
          name: subscription.name,
          source: subscription.feedUrl,
          newEntries: checkResult.newEntries.length,
          summary: summaryResult.summary,
        });

        return true;
      });

      await step.run("update-subscription", async () => {
        await updateSubscription(subscription.id, {
          lastChecked: Date.now(),
          lastEntryId: checkpoint.lastEntryId,
          lastContentHash: checkpoint.lastContentHash,
        });
      });

      await step.run("otel-subscription-check-single-complete", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "subscription-check",
          action: "subscription.check_single.completed",
          success: true,
          metadata: {
            subscriptionId: subscription.id,
            model: summaryResult.model,
            newEntries: checkResult.newEntries.length,
            published: publishedCount,
            notified,
          },
        });
      });

      return {
        status: "updated",
        subscriptionId: subscription.id,
        newEntries: checkResult.newEntries.length,
        published: publishedCount,
        notified,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await step.run("otel-subscription-check-single-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "subscription-check",
          action: "subscription.check_single.failed",
          success: false,
          error: message,
          metadata: {
            subscriptionId,
          },
        });
      });

      throw error;
    }
  }
);
