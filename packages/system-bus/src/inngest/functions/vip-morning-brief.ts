import { infer } from "../../lib/inference";
import {
  EMAIL_THREADS_COLLECTION,
  ensureEmailThreadsCollection,
  search,
} from "../../lib/typesense";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const COMPONENT = "vip-email-brief";
const FRONT_CONVERSATION_URL = "https://app.frontapp.com/open";
const LOS_ANGELES_TIME_ZONE = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const QUERY_LIMIT = 20;
const QUERY_SCAN_LIMIT = 50;
const EMPTY_BRIEF = "☀️ VIP inbox clear — nothing needs your attention.";

const VIP_EMAIL_BRIEF_SYSTEM_PROMPT = `You are Joel's VIP email intelligence briefer. Produce a concise, scannable brief of VIP email threads that need attention.

Rules:
- Lead with what needs action NOW
- Group by urgency: dangling replies first, then new activity, then stale
- Include the Front link for each thread
- Keep each thread to 2-3 lines max
- If nothing needs attention, say so in one line
- No fluff, no greetings, no sign-offs`;

type CachedThreadMessage = {
  timestamp?: unknown;
  text?: unknown;
};

type VipThreadDocument = {
  conversation_id?: unknown;
  subject?: unknown;
  participants?: unknown;
  vip_sender?: unknown;
  status?: unknown;
  last_message_at?: unknown;
  last_joel_reply_at?: unknown;
  message_count?: unknown;
  messages_json?: unknown;
  summary?: unknown;
};

type NormalizedVipThread = {
  conversationId: string;
  subject: string;
  participants: string[];
  vipSender: string;
  status: string;
  lastMessageAt: number;
  lastJoelReplyAt: number | null;
  messageCount: number;
  summary: string;
  latestMessageText: string;
  frontLink: string;
  lastMessageRelative: string;
  lastJoelReplyRelative: string;
  joelHasReplied: boolean;
};

type ClassifiedThreads = {
  generatedAt: number;
  dangling: NormalizedVipThread[];
  newActivity: NormalizedVipThread[];
  stale: NormalizedVipThread[];
  skippedCount: number;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = asString(item);
    if (normalized) deduped.add(normalized);
  }

  return [...deduped];
}

function frontConversationUrl(conversationId: string): string {
  return `${FRONT_CONVERSATION_URL}/${conversationId}`;
}

function formatRelativeTime(timestampMs?: number | null, now = Date.now()): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "none";

  const diffMs = now - timestampMs;
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) return diffMs >= 0 ? "just now" : "in <1m";
  if (absMs < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(absMs / 60_000));
    return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }
  if (absMs < DAY_MS) {
    const hours = Math.max(1, Math.floor(absMs / (60 * 60_000)));
    return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
  }
  if (diffMs >= DAY_MS && diffMs < 2 * DAY_MS) return "yesterday";
  if (absMs < WEEK_MS) {
    const days = Math.max(1, Math.floor(absMs / DAY_MS));
    return diffMs >= 0 ? `${days} days ago` : `in ${days} days`;
  }
  if (absMs < 30 * DAY_MS) {
    const weeks = Math.max(1, Math.floor(absMs / WEEK_MS));
    return diffMs >= 0 ? `${weeks} week${weeks === 1 ? "" : "s"} ago` : `in ${weeks} week${weeks === 1 ? "" : "s"}`;
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: LOS_ANGELES_TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(new Date(timestampMs));
}

function formatLocalDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LOS_ANGELES_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function truncateText(value: string, limit = 220): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function stripMarkdownFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function parseLatestMessageText(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";

  try {
    const parsed = JSON.parse(raw) as CachedThreadMessage[];
    if (!Array.isArray(parsed) || parsed.length === 0) return "";

    const latest = parsed.reduce<CachedThreadMessage | null>((currentLatest, current) => {
      const currentTimestamp = asNumber(current.timestamp) ?? 0;
      const latestTimestamp = currentLatest ? (asNumber(currentLatest.timestamp) ?? 0) : 0;
      return currentTimestamp >= latestTimestamp ? current : currentLatest;
    }, null);

    return truncateText(asString(latest?.text));
  } catch {
    return "";
  }
}

function normalizeThreadDocument(doc: VipThreadDocument, now: number): NormalizedVipThread | null {
  const conversationId = asString(doc.conversation_id);
  const lastMessageAt = asNumber(doc.last_message_at);

  if (!conversationId || lastMessageAt == null) return null;

  const subject = asString(doc.subject) || "(no subject)";
  const participants = asStringArray(doc.participants);
  const vipSender = asString(doc.vip_sender);
  const status = asString(doc.status).toLowerCase() || "unknown";
  const lastJoelReplyAtRaw = asNumber(doc.last_joel_reply_at);
  const lastJoelReplyAt = lastJoelReplyAtRaw != null && lastJoelReplyAtRaw > 0
    ? lastJoelReplyAtRaw
    : null;
  const messageCount = asNumber(doc.message_count) ?? 0;
  const latestMessageText = parseLatestMessageText(doc.messages_json);
  const summary = truncateText(asString(doc.summary) || latestMessageText || subject);

  return {
    conversationId,
    subject,
    participants,
    vipSender,
    status,
    lastMessageAt,
    lastJoelReplyAt,
    messageCount,
    summary,
    latestMessageText,
    frontLink: frontConversationUrl(conversationId),
    lastMessageRelative: formatRelativeTime(lastMessageAt, now),
    lastJoelReplyRelative: formatRelativeTime(lastJoelReplyAt, now),
    joelHasReplied: lastJoelReplyAt != null,
  };
}

function classifyThread(thread: NormalizedVipThread, now: number): "dangling" | "new-activity" | "stale" | null {
  const lastJoelReplyAt = thread.lastJoelReplyAt ?? 0;
  const isDangling = lastJoelReplyAt <= 0 || lastJoelReplyAt < thread.lastMessageAt;

  if (isDangling) return "dangling";
  if (thread.lastMessageAt >= now - DAY_MS) return "new-activity";
  if (thread.status === "open" && thread.lastMessageAt <= now - WEEK_MS) return "stale";

  return null;
}

function buildThreadLines(thread: NormalizedVipThread): string[] {
  const participants = thread.participants.length > 0 ? thread.participants.join(", ") : "unknown";
  const joelReplyLine = thread.joelHasReplied
    ? `Joel replied ${thread.lastJoelReplyRelative}`
    : "Joel has not replied";
  const summarySource = thread.summary || thread.latestMessageText || thread.subject;

  return [
    `- ${thread.subject} — ${thread.vipSender || participants}`,
    `  ${thread.lastMessageRelative} · ${thread.messageCount} msg · ${joelReplyLine}`,
    `  ${truncateText(summarySource, 180)} · ${thread.frontLink}`,
  ];
}

function buildFallbackBrief(classified: ClassifiedThreads): string {
  const sections: string[] = [];
  const orderedSections: Array<[string, NormalizedVipThread[]]> = [
    ["## Dangling replies", classified.dangling],
    ["## New activity", classified.newActivity],
    ["## Stale threads", classified.stale],
  ];

  for (const [heading, threads] of orderedSections) {
    if (threads.length === 0) continue;
    sections.push(heading, "");
    for (const thread of threads) {
      sections.push(...buildThreadLines(thread), "");
    }
  }

  return sections.length > 0 ? sections.join("\n").trim() : EMPTY_BRIEF;
}

function buildBriefUserPrompt(classified: ClassifiedThreads): string {
  const buildSection = (label: string, threads: NormalizedVipThread[]) => {
    if (threads.length === 0) return `${label}: none`;

    const blocks = threads.map((thread, index) => {
      const participants = thread.participants.length > 0 ? thread.participants.join(", ") : "unknown";
      return [
        `${index + 1}. ${thread.subject}`,
        `   VIP sender: ${thread.vipSender || "unknown"}`,
        `   Participants: ${participants}`,
        `   Messages: ${thread.messageCount}`,
        `   Last activity: ${thread.lastMessageRelative} (${formatLocalDateTime(thread.lastMessageAt)} ${LOS_ANGELES_TIME_ZONE})`,
        `   Joel replied: ${thread.joelHasReplied ? `yes, ${thread.lastJoelReplyRelative}` : "no"}`,
        `   Summary: ${thread.summary || thread.latestMessageText || "No cached summary available."}`,
        `   Front link: ${thread.frontLink}`,
      ].join("\n");
    });

    return `${label} (${threads.length}):\n${blocks.join("\n\n")}`;
  };

  return [
    `VIP email brief for ${formatLocalDateTime(classified.generatedAt)} ${LOS_ANGELES_TIME_ZONE}.`,
    "Summarize only the threads below.",
    "",
    buildSection("Dangling replies", classified.dangling),
    "",
    buildSection("New activity", classified.newActivity),
    "",
    buildSection("Stale threads", classified.stale),
    "",
    `Skipped threads already being handled: ${classified.skippedCount}`,
  ].join("\n");
}

function buildGatewayPrompt(briefText: string): string {
  return [
    "Operator relay rules:",
    "- This is a VIP email brief. Deliver to Joel on Telegram as-is.",
    "- Do not summarize or reformat — the brief is already formatted for mobile.",
    `- If all sections are empty, send: "${EMPTY_BRIEF}"`,
    "",
    stripMarkdownFences(briefText).trim() || EMPTY_BRIEF,
  ].join("\n");
}

export const vipEmailBrief = inngest.createFunction(
  {
    id: "vip/email-brief",
    name: "VIP Email Brief",
    retries: 1,
    concurrency: { limit: 1 },
  },
  [
    { cron: "30 13 * * 1-5" },
    { cron: "0 17 * * 1-5" },
    { cron: "0 22 * * 1-5" },
    { cron: "0 2 * * 2-6" },
  ],
  async ({ step }) => {
    const queried = await step.run("query-vip-threads", async () => {
      try {
        await ensureEmailThreadsCollection();

        const result = await search({
          collection: EMAIL_THREADS_COLLECTION,
          q: "*",
          query_by: "subject,summary,vip_sender",
          filter_by: "status:!=archived",
          sort_by: "last_message_at:desc",
          per_page: QUERY_SCAN_LIMIT,
          include_fields: [
            "conversation_id",
            "subject",
            "participants",
            "vip_sender",
            "status",
            "last_message_at",
            "last_joel_reply_at",
            "message_count",
            "messages_json",
            "summary",
          ].join(","),
        });

        const now = Date.now();
        const threads = (result.hits ?? [])
          .map((hit) => normalizeThreadDocument((hit.document ?? {}) as VipThreadDocument, now))
          // Typesense can filter status server-side, but non-empty string checks are
          // more reliable to enforce after hydration than via filter syntax.
          .filter((thread): thread is NormalizedVipThread => thread != null && thread.vipSender.length > 0)
          .slice(0, QUERY_LIMIT);

        return {
          status: "ok" as const,
          found: result.found ?? 0,
          threads,
        };
      } catch (error) {
        return {
          status: "noop" as const,
          reason: "typesense-unavailable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    if (queried.status !== "ok") {
      return queried;
    }

    if (queried.threads.length === 0) {
      return {
        status: "noop",
        reason: "no-open-vip-threads",
        found: queried.found,
      };
    }

    const classified = await step.run("classify-threads", async () => {
      const now = Date.now();
      const dangling: NormalizedVipThread[] = [];
      const newActivity: NormalizedVipThread[] = [];
      const stale: NormalizedVipThread[] = [];
      let skippedCount = 0;

      for (const thread of queried.threads) {
        const category = classifyThread(thread, now);
        if (category === "dangling") {
          dangling.push(thread);
          continue;
        }
        if (category === "new-activity") {
          newActivity.push(thread);
          continue;
        }
        if (category === "stale") {
          stale.push(thread);
          continue;
        }
        skippedCount += 1;
      }

      return {
        generatedAt: now,
        dangling,
        newActivity,
        stale,
        skippedCount,
      } satisfies ClassifiedThreads;
    });

    if (
      classified.dangling.length === 0 &&
      classified.newActivity.length === 0 &&
      classified.stale.length === 0
    ) {
      return {
        status: "noop",
        reason: "no-signal",
        threadCount: queried.threads.length,
        danglingCount: 0,
        newActivityCount: 0,
        staleCount: 0,
        skippedCount: classified.skippedCount,
      };
    }

    const generated = await step.run("generate-brief", async () => {
      const fallback = buildFallbackBrief(classified);

      try {
        const result = await infer(buildBriefUserPrompt(classified), {
          task: "summary",
          system: VIP_EMAIL_BRIEF_SYSTEM_PROMPT,
          component: COMPONENT,
          action: "vip.email-brief.generate",
          requireTextOutput: true,
          noTools: true,
          timeout: 120_000,
          env: {
            ...process.env,
            TERM: "dumb",
          },
          metadata: {
            threadCount: queried.threads.length,
            danglingCount: classified.dangling.length,
            newActivityCount: classified.newActivity.length,
            staleCount: classified.stale.length,
          },
        });

        const briefText = stripMarkdownFences(result.text).trim();

        return {
          briefText: briefText || fallback,
          mode: briefText ? "infer" : "fallback",
        };
      } catch (error) {
        return {
          briefText: fallback,
          mode: "fallback",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    await step.run("notify-gateway", async () => {
      await pushGatewayEvent({
        type: "vip.email.brief",
        source: "inngest/vip-email-brief",
        payload: {
          prompt: buildGatewayPrompt(generated.briefText),
          threadCount: queried.threads.length,
          danglingCount: classified.dangling.length,
          newActivityCount: classified.newActivity.length,
          staleCount: classified.stale.length,
        },
      });
    });

    return {
      status: "briefed",
      threadCount: queried.threads.length,
      danglingCount: classified.dangling.length,
      newActivityCount: classified.newActivity.length,
      staleCount: classified.stale.length,
      skippedCount: classified.skippedCount,
      mode: generated.mode,
      ...(generated.error ? { generationError: generated.error } : {}),
    };
  }
);
