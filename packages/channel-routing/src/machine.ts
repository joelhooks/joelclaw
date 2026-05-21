import { setup } from "xstate";
import { canChannel, isChannelEligible } from "./policy";
import { canConsumeGrant, isGrantExhausted, isGrantExpired } from "./reply-grants";
import type { ChannelPermissionPolicy, ChannelPrincipal, ReplyGrant, RoutingIntent, SlackMentionEvent } from "./types";

export type SlackMentionMachineContext = {
  event: SlackMentionEvent;
  policy: ChannelPermissionPolicy;
  activeGrant?: ReplyGrant;
  intents: RoutingIntent[];
};

type SlackMentionMachineEvent = { type: "ROUTE" };

function principalFromEvent(event: SlackMentionEvent): ChannelPrincipal {
  return {
    platform: event.platform,
    userId: event.senderUserId,
    role: event.senderRole,
  };
}

function grantSubject(grant: ReplyGrant) {
  return {
    kind: "ReplyGrant" as const,
    channelId: grant.channelId,
    threadTs: grant.threadTs,
    invokerUserIds: grant.invokerUserIds,
  };
}

function appendIntent(ctx: SlackMentionMachineContext, intent: RoutingIntent): SlackMentionMachineContext {
  return { ...ctx, intents: [...ctx.intents, intent] };
}

export const slackMentionApprovalMachine = setup({
  types: {
    context: {} as SlackMentionMachineContext,
    events: {} as SlackMentionMachineEvent,
    input: {} as SlackMentionMachineContext,
  },
  guards: {
    channelEligible: ({ context }) => isChannelEligible(context.event.channelId, context.policy),
    actorCanMention: ({ context }) => canChannel(
      principalFromEvent(context.event),
      "mention",
      { kind: "SlackUser", userId: context.event.senderUserId },
      context.policy,
    ),
    joelOriginated: ({ context }) => context.event.isJoelOriginated,
    hasActiveConsumableGrant: ({ context }) => {
      const grant = context.activeGrant;
      if (!grant) return false;
      if (!canConsumeGrant(grant, context.event)) return false;
      return canChannel(principalFromEvent(context.event), "consumeGrant", grantSubject(grant), context.policy);
    },
    grantExpiredOrExhausted: ({ context }) => {
      const grant = context.activeGrant;
      if (!grant) return false;
      return isGrantExpired(grant, context.event.now) || isGrantExhausted(grant);
    },
  },
  actions: {
    rejectBlocked: ({ context }) => {
      context.intents.push({ type: "reject", reason: "actor-or-channel-not-eligible" });
      context.intents.push({ type: "recordOtel", action: "reply_grant.rejected", success: false, reason: "actor-or-channel-not-eligible" });
    },
    notifyAndDraft: ({ context }) => {
      context.intents.push({ type: "notifyUser", reason: "mention-without-active-grant" });
      context.intents.push({ type: "draftPrivateReply", reason: "approval-required" });
      context.intents.push({ type: "recordOtel", action: "reply_grant.approval_requested", success: true });
    },
    createGrantAndPost: ({ context }) => {
      context.intents.push({ type: "createGrant", reason: "joel-originated-public-instruction" });
      context.intents.push({ type: "postPublicReply", reason: "joel-originated-public-instruction" });
      context.intents.push({ type: "recordOtel", action: "reply_grant.created_and_posted", success: true });
    },
    postUnderGrant: ({ context }) => {
      context.intents.push({ type: "postPublicReply", reason: "active-grant-consumed" });
      context.intents.push({ type: "updateGrant", reason: "active-grant-consumed" });
      context.intents.push({ type: "notifyUser", reason: "active-grant-used" });
      context.intents.push({ type: "recordOtel", action: "reply_grant.consumed", success: true });
    },
    rejectExpiredGrant: ({ context }) => {
      context.intents.push({ type: "notifyUser", reason: "grant-expired-or-exhausted" });
      context.intents.push({ type: "recordOtel", action: "reply_grant.rejected", success: false, reason: "grant-expired-or-exhausted" });
    },
  },
}).createMachine({
  id: "slackMentionApproval",
  context: ({ input }: { input: SlackMentionMachineContext }) => input,
  initial: "mentioned",
  states: {
    mentioned: {
      always: [
        { target: "rejected", guard: ({ context }) => !isChannelEligible(context.event.channelId, context.policy), actions: "rejectBlocked" },
        { target: "rejected", guard: ({ context }) => !canChannel(principalFromEvent(context.event), "mention", { kind: "SlackUser", userId: context.event.senderUserId }, context.policy), actions: "rejectBlocked" },
        { target: "grantExpired", guard: "grantExpiredOrExhausted", actions: "rejectExpiredGrant" },
        { target: "posting", guard: "joelOriginated", actions: "createGrantAndPost" },
        { target: "posting", guard: "hasActiveConsumableGrant", actions: "postUnderGrant" },
        { target: "awaitingApproval", actions: "notifyAndDraft" },
      ],
    },
    awaitingApproval: { type: "final" },
    posting: { type: "final" },
    grantExpired: { type: "final" },
    rejected: { type: "final" },
  },
});

export function routeSlackMention(input: Omit<SlackMentionMachineContext, "intents">): RoutingIntent[] {
  const context: SlackMentionMachineContext = { ...input, intents: [] };
  const principal = principalFromEvent(context.event);

  if (!isChannelEligible(context.event.channelId, context.policy)) {
    return [
      { type: "reject", reason: "actor-or-channel-not-eligible" },
      { type: "recordOtel", action: "reply_grant.rejected", success: false, reason: "actor-or-channel-not-eligible" },
    ];
  }

  if (!canChannel(principal, "mention", { kind: "SlackUser", userId: context.event.senderUserId }, context.policy)) {
    return [
      { type: "reject", reason: "actor-or-channel-not-eligible" },
      { type: "recordOtel", action: "reply_grant.rejected", success: false, reason: "actor-or-channel-not-eligible" },
    ];
  }

  if (context.activeGrant && (isGrantExpired(context.activeGrant, context.event.now) || isGrantExhausted(context.activeGrant))) {
    return [
      { type: "notifyUser", reason: "grant-expired-or-exhausted" },
      { type: "recordOtel", action: "reply_grant.rejected", success: false, reason: "grant-expired-or-exhausted" },
    ];
  }

  if (context.event.isJoelOriginated) {
    return [
      { type: "createGrant", reason: "joel-originated-public-instruction" },
      { type: "postPublicReply", reason: "joel-originated-public-instruction" },
      { type: "recordOtel", action: "reply_grant.created_and_posted", success: true },
    ];
  }

  if (
    context.activeGrant
    && canConsumeGrant(context.activeGrant, context.event)
    && canChannel(principal, "consumeGrant", grantSubject(context.activeGrant), context.policy)
  ) {
    return [
      { type: "postPublicReply", reason: "active-grant-consumed" },
      { type: "updateGrant", reason: "active-grant-consumed" },
      { type: "notifyUser", reason: "active-grant-used" },
      { type: "recordOtel", action: "reply_grant.consumed", success: true },
    ];
  }

  return [
    { type: "notifyUser", reason: "mention-without-active-grant" },
    { type: "draftPrivateReply", reason: "approval-required" },
    { type: "recordOtel", action: "reply_grant.approval_requested", success: true },
  ];
}
