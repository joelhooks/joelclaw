type EmailThreadMessageLike = {
  id: string;
  senderDisplay: string;
  senderEmail: string;
  senderName: string;
  createdAt: number;
  text: string;
  isInbound: boolean;
};

type EmailThreadContextLike = {
  summary: {
    status: string;
    tags: string[];
  };
  messages: EmailThreadMessageLike[];
  latestMessage: EmailThreadMessageLike | null;
  lastJoelReplyAt?: number;
};

type FollowedLinkLike = {
  url: string;
  content: string;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function buildEmailThreadCacheDocument(input: {
  conversationId: string;
  subject: string;
  vipSender: string;
  frontContext: EmailThreadContextLike;
  followedLinks?: FollowedLinkLike[];
  summary?: string;
}): Record<string, unknown> {
  const followedLinks = input.followedLinks ?? [];
  const participants = uniqueStrings([
    input.vipSender,
    ...input.frontContext.messages.flatMap((message) => [message.senderEmail, message.senderName]),
  ]);
  const messages = input.frontContext.messages.map((message) => ({
    id: message.id,
    sender: message.senderDisplay,
    sender_email: message.senderEmail,
    timestamp: message.createdAt,
    text: message.text,
    is_inbound: message.isInbound,
  }));

  return {
    id: input.conversationId,
    conversation_id: input.conversationId,
    subject: input.subject,
    participants,
    vip_sender: input.vipSender,
    status: input.frontContext.summary.status || "unknown",
    last_message_at: input.frontContext.latestMessage?.createdAt ?? Date.now(),
    ...(input.frontContext.lastJoelReplyAt != null ? { last_joel_reply_at: input.frontContext.lastJoelReplyAt } : {}),
    message_count: input.frontContext.messages.length,
    messages_json: JSON.stringify(messages),
    ...(followedLinks.length > 0 ? { followed_links_json: JSON.stringify(followedLinks) } : {}),
    ...(input.frontContext.summary.tags.length > 0 ? { tags: input.frontContext.summary.tags } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    updated_at: Date.now(),
  };
}
