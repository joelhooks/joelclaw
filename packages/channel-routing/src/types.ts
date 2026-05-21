export type ChannelPlatform = "slack";

export type ChannelRole =
  | "owner"
  | "trusted-collaborator"
  | "participant"
  | "observer"
  | "blocked";

export type ChannelAction =
  | "mention"
  | "requestGrant"
  | "consumeGrant"
  | "autoInvoke"
  | "administer";

export type ChannelSubjectType = "SlackThread" | "SlackChannel" | "SlackUser" | "ReplyGrant";

export type ChannelPrincipal = {
  platform: ChannelPlatform;
  userId: string;
  role: ChannelRole;
};

export type ChannelPermissionPolicy = {
  principals: Record<string, ChannelRole>;
  channelAllowlist?: string[];
  channelBlocklist?: string[];
};

export type SlackThreadSubject = {
  kind: "SlackThread";
  channelId: string;
  threadTs: string;
};

export type SlackChannelSubject = {
  kind: "SlackChannel";
  channelId: string;
};

export type SlackUserSubject = {
  kind: "SlackUser";
  userId: string;
};

export type ReplyGrantSubject = {
  kind: "ReplyGrant";
  channelId: string;
  threadTs: string;
  invokerUserIds: string[];
};

export type ChannelSubject = SlackThreadSubject | SlackChannelSubject | SlackUserSubject | ReplyGrantSubject;

export type ReplyGrantMode = "public-chat";
export type ConversationMode = "active" | "idle";

export type ReplyGrant = {
  id: string;
  platform: ChannelPlatform;
  channelId: string;
  threadTs: string;
  grantedByUserId: string;
  mode: ReplyGrantMode;
  invokerUserIds: string[];
  maxReplies: number;
  repliesUsed: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  conversationMode: ConversationMode;
  humanMessagesSinceBotReply: number;
  createdAt: number;
  updatedAt: number;
};

export type SlackMentionEvent = {
  platform: "slack";
  channelId: string;
  threadTs: string;
  messageTs: string;
  senderUserId: string;
  senderRole: ChannelRole;
  text: string;
  botMentioned: boolean;
  isJoelOriginated: boolean;
  now: number;
};

export type ApprovalAction = "sendSuggested" | "editFirst" | "grantOnly" | "ignore" | "closeGrant";

export type RoutingIntent =
  | { type: "notifyUser"; reason: string }
  | { type: "draftPrivateReply"; reason: string }
  | { type: "createGrant"; reason: string }
  | { type: "postPublicReply"; reason: string }
  | { type: "updateGrant"; reason: string }
  | { type: "recordOtel"; action: string; success: boolean; reason?: string }
  | { type: "reject"; reason: string };
