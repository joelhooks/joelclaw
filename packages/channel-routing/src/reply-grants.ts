import type { ReplyGrant, SlackMentionEvent } from "./types";

export const DEFAULT_REPLY_GRANT_LIMITS = {
  maxReplies: 5,
  idleTtlMs: 30 * 60 * 1000,
  absoluteTtlMs: 2 * 60 * 60 * 1000,
  maxHumanMessagesSinceBotReply: 2,
} as const;

export function replyGrantId(platform: "slack", channelId: string, threadTs: string): string {
  return `${platform}:${channelId}:${threadTs}`;
}

export function isGrantExpired(grant: ReplyGrant, now: number): boolean {
  return now >= grant.idleExpiresAt || now >= grant.absoluteExpiresAt;
}

export function isGrantExhausted(grant: ReplyGrant): boolean {
  return grant.repliesUsed >= grant.maxReplies;
}

export function canConsumeGrant(grant: ReplyGrant, event: SlackMentionEvent): boolean {
  if (grant.platform !== event.platform) return false;
  if (grant.channelId !== event.channelId || grant.threadTs !== event.threadTs) return false;
  if (isGrantExpired(grant, event.now) || isGrantExhausted(grant)) return false;
  if (grant.conversationMode !== "active") return false;
  return grant.invokerUserIds.includes(event.senderUserId) || event.isJoelOriginated;
}

export function createReplyGrantFromEvent(
  event: SlackMentionEvent,
  grantedByUserId: string,
  invokerUserIds: string[],
  limits = DEFAULT_REPLY_GRANT_LIMITS,
): ReplyGrant {
  const uniqueInvokers = [...new Set(invokerUserIds.filter(Boolean))];
  return {
    id: replyGrantId(event.platform, event.channelId, event.threadTs),
    platform: event.platform,
    channelId: event.channelId,
    threadTs: event.threadTs,
    grantedByUserId,
    mode: "public-chat",
    invokerUserIds: uniqueInvokers,
    maxReplies: limits.maxReplies,
    repliesUsed: 0,
    idleExpiresAt: event.now + limits.idleTtlMs,
    absoluteExpiresAt: event.now + limits.absoluteTtlMs,
    conversationMode: "active",
    humanMessagesSinceBotReply: 0,
    createdAt: event.now,
    updatedAt: event.now,
  };
}

export function recordGrantPublicReply(
  grant: ReplyGrant,
  now: number,
  limits = DEFAULT_REPLY_GRANT_LIMITS,
): ReplyGrant {
  return {
    ...grant,
    repliesUsed: grant.repliesUsed + 1,
    idleExpiresAt: Math.min(now + limits.idleTtlMs, grant.absoluteExpiresAt),
    conversationMode: "active",
    humanMessagesSinceBotReply: 0,
    updatedAt: now,
  };
}

export function recordGrantHumanMessage(
  grant: ReplyGrant,
  now: number,
  limits = DEFAULT_REPLY_GRANT_LIMITS,
): ReplyGrant {
  const humanMessagesSinceBotReply = grant.humanMessagesSinceBotReply + 1;
  return {
    ...grant,
    humanMessagesSinceBotReply,
    conversationMode: humanMessagesSinceBotReply >= limits.maxHumanMessagesSinceBotReply ? "idle" : grant.conversationMode,
    updatedAt: now,
  };
}
