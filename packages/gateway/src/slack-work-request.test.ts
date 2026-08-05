import { describe, expect, test } from "bun:test";
import type { InboundEvent } from "@joelclaw/message-contract";
import {
  hasShitRatTrigger,
  isShitRatWorkChannel,
  resolveSlackWorkRequest,
} from "./slack-work-request";

function slackMessage(input: {
  text: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string | null;
  isMention?: boolean;
  isBot?: boolean;
  isSelf?: boolean;
}): InboundEvent {
  const messageTs = input.messageTs ?? "1785950000.100";
  return {
    contractVersion: "2",
    eventId: `slack:message:${messageTs}`,
    platform: "slack",
    type: "message",
    occurredAt: "2026-08-05T16:00:00.000Z",
    observedAt: "2026-08-05T16:00:00.100Z",
    shadow: true,
    actor: {
      platformUserId: "UTEAM",
      userName: "teammate",
      displayName: "Teammate",
      isBot: input.isBot ?? false,
      isSelf: input.isSelf ?? false,
    },
    platformIds: {
      conversationId: input.channelId ?? "CEXAMPLE",
      messageId: messageTs,
      threadId: null,
      actorId: "UTEAM",
      workspaceId: null,
    },
    rawAnchors: {
      transportEventId: messageTs,
      updateId: null,
      callbackQueryId: null,
      sourceMessageId: messageTs,
      sourceThreadId: input.threadTs ?? null,
    },
    audit: {
      source: "gateway.slack.chat-sdk.message",
      transport: "socket",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: "2026-08-05T16:00:00.100Z",
      rawEventType: "chat-sdk.message",
      rawEventId: messageTs,
      lineageId: messageTs,
    },
    authorization: {
      verdict: "rejected",
      reason: "non_joel_actor",
      policyAction: "reject",
      expectedActorId: "UJOEL",
      actualActorId: "UTEAM",
      canPublish: true,
      canExecute: false,
    },
    text: input.text,
    isMention: input.isMention ?? false,
    attachmentCount: 0,
  } as unknown as InboundEvent;
}

describe("Slack ShitRat work trigger", () => {
  test("uses the exact custom emoji token", () => {
    expect(hasShitRatTrigger("please review this :shitrat:")).toBe(true);
    expect(hasShitRatTrigger("please review this shitrat")).toBe(false);
  });

  test("accepts lc-* and cc-* channel names only", () => {
    expect(isShitRatWorkChannel("lc-example-project")).toBe(true);
    expect(isShitRatWorkChannel("#cc-matt-p")).toBe(true);
    expect(isShitRatWorkChannel("brain-joel")).toBe(false);
  });

  test("builds the root-thread launch context and loads the channel binding", async () => {
    const request = await resolveSlackWorkRequest({
      event: slackMessage({ text: "review assessment :shitrat:" }),
      resolveChannelName: async () => "lc-example-project",
      loadBinding: async () => ({
        repo: "/tmp/example-project",
        cwd: "/tmp/example-project",
        brainEntry: ".brain/projects/mega-assessment/mega-assessment-brief.svx",
      }),
    });

    expect(request).toEqual({
      trigger: "shitrat",
      addressedBy: "emoji",
      channelId: "CEXAMPLE",
      channelName: "lc-example-project",
      messageTs: "1785950000.100",
      threadTs: "1785950000.100",
      replyThreadId: "slack:CEXAMPLE:1785950000.100",
      binding: {
        repo: "/tmp/example-project",
        cwd: "/tmp/example-project",
        brainEntry: ".brain/projects/mega-assessment/mega-assessment-brief.svx",
      },
    });
  });

  test("keeps replies on the existing thread", async () => {
    const request = await resolveSlackWorkRequest({
      event: slackMessage({
        text: ":shitrat: check the follow-up",
        messageTs: "1785950001.200",
        threadTs: "1785950000.100",
      }),
      resolveChannelName: async () => "cc-matt-p",
    });

    expect(request?.threadTs).toBe("1785950000.100");
    expect(request?.replyThreadId).toBe("slack:CEXAMPLE:1785950000.100");
  });

  test("repurposes a direct @joelclaw mention as ShitRat work", async () => {
    const event = slackMessage({
      text: "review the assessment logic",
      isMention: true,
    });
    const request = await resolveSlackWorkRequest({
      event,
      resolveChannelName: async () => "lc-example-project",
    });
    expect(request?.addressedBy).toBe("mention");
  });

  test("does not recurse on bot or self-authored messages", async () => {
    for (const event of [
      slackMessage({ text: ":shitrat: loop", isBot: true }),
      slackMessage({ text: ":shitrat: loop", isSelf: true }),
    ]) {
      const request = await resolveSlackWorkRequest({
        event,
        resolveChannelName: async () => "lc-example-project",
      });
      expect(request).toBeUndefined();
    }
  });

  test("does not trigger outside lc/cc channels", async () => {
    const request = await resolveSlackWorkRequest({
      event: slackMessage({ text: ":shitrat: review this" }),
      resolveChannelName: async () => "brain-joel",
    });
    expect(request).toBeUndefined();
  });
});
