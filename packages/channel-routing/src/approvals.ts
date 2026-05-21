import { createReplyGrantFromEvent } from "./reply-grants";
import type { ReplyGrant } from "./types";

export type ReplyGrantApprovalState = {
  platform: "slack";
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId?: string;
  userLabel?: string;
  text: string;
  createdAt: number;
};

export type ReplyGrantApprovalDecision =
  | { type: "ignored" }
  | { type: "granted"; grant: ReplyGrant };

export function createReplyGrantFromApproval(input: {
  approval: ReplyGrantApprovalState;
  grantedByUserId: string;
  now: number;
}): ReplyGrant {
  const { approval, grantedByUserId, now } = input;
  return createReplyGrantFromEvent(
    {
      platform: "slack",
      channelId: approval.channelId,
      threadTs: approval.threadTs,
      messageTs: approval.messageTs,
      senderUserId: grantedByUserId,
      senderRole: "owner",
      text: approval.text,
      botMentioned: false,
      isJoelOriginated: true,
      now,
    },
    grantedByUserId,
    approval.userId ? [approval.userId] : [],
  );
}

export function resolveReplyGrantApproval(input: {
  approval: ReplyGrantApprovalState;
  action: "grant" | "ignore";
  grantedByUserId: string;
  now: number;
}): ReplyGrantApprovalDecision {
  if (input.action === "ignore") return { type: "ignored" };
  return {
    type: "granted",
    grant: createReplyGrantFromApproval({
      approval: input.approval,
      grantedByUserId: input.grantedByUserId,
      now: input.now,
    }),
  };
}
