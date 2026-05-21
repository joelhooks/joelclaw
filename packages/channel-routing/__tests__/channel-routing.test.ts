import { describe, expect, it } from "vitest";
import {
  canChannel,
  createReplyGrantFromEvent,
  DEFAULT_REPLY_GRANT_LIMITS,
  recordGrantHumanMessage,
  recordGrantPublicReply,
  resolveReplyGrantApproval,
  routeSlackMention,
  type ChannelPermissionPolicy,
  type ReplyGrant,
  type SlackMentionEvent,
} from "../src";

const now = Date.now();
const policy: ChannelPermissionPolicy = {
  principals: {
    UJOEL: "owner",
    UJOHN: "trusted-collaborator",
    UCRE: "participant",
    UNOISE: "observer",
    UBLOCKED: "blocked",
  },
  channelAllowlist: ["CBRAIN"],
};

function event(overrides: Partial<SlackMentionEvent> = {}): SlackMentionEvent {
  return {
    platform: "slack",
    channelId: "CBRAIN",
    threadTs: "111.222",
    messageTs: "333.444",
    senderUserId: "UJOHN",
    senderRole: "trusted-collaborator",
    text: "@joelclaw what do you think?",
    botMentioned: true,
    isJoelOriginated: false,
    now,
    ...overrides,
  };
}

function grant(overrides: Partial<ReplyGrant> = {}): ReplyGrant {
  return {
    ...createReplyGrantFromEvent(event(), "UJOEL", ["UJOHN"]),
    ...overrides,
  };
}

describe("channel permission policy", () => {
  it("blocks blocked users from mentioning", () => {
    expect(canChannel({ platform: "slack", userId: "UBLOCKED", role: "blocked" }, "mention", { kind: "SlackUser", userId: "UBLOCKED" }, policy)).toBe(false);
  });

  it("lets trusted collaborators request grants but not administer", () => {
    const principal = { platform: "slack" as const, userId: "UJOHN", role: "trusted-collaborator" as const };
    expect(canChannel(principal, "requestGrant", { kind: "ReplyGrant", channelId: "CBRAIN", threadTs: "111.222", invokerUserIds: ["UJOHN"] }, policy)).toBe(true);
    expect(canChannel(principal, "administer", { kind: "ReplyGrant", channelId: "CBRAIN", threadTs: "111.222", invokerUserIds: ["UJOHN"] }, policy)).toBe(false);
  });
});

describe("reply grant routing", () => {
  it("routes non-Joel mention without grant to private alert and draft, never public post", () => {
    const intents = routeSlackMention({ event: event(), policy });
    expect(intents.map((intent) => intent.type)).toEqual(["notifyUser", "draftPrivateReply", "recordOtel"]);
    expect(intents.some((intent) => intent.type === "postPublicReply")).toBe(false);
  });

  it("routes Joel-originated Slack instruction to create grant and public post", () => {
    const intents = routeSlackMention({ event: event({ senderUserId: "UJOEL", senderRole: "owner", isJoelOriginated: true }), policy });
    expect(intents.map((intent) => intent.type)).toEqual(["createGrant", "postPublicReply", "recordOtel"]);
  });

  it("routes active grant follow-up from allowed invoker to public post", () => {
    const intents = routeSlackMention({ event: event(), policy, activeGrant: grant() });
    expect(intents.map((intent) => intent.type)).toEqual(["postPublicReply", "updateGrant", "notifyUser", "recordOtel"]);
  });

  it("does not let a non-allowlisted participant consume an active grant", () => {
    const intents = routeSlackMention({
      event: event({ senderUserId: "UCRE", senderRole: "participant" }),
      policy,
      activeGrant: grant({ invokerUserIds: ["UJOHN"] }),
    });
    expect(intents.map((intent) => intent.type)).toEqual(["notifyUser", "draftPrivateReply", "recordOtel"]);
  });

  it("rejects expired grants", () => {
    const intents = routeSlackMention({ event: event(), policy, activeGrant: grant({ idleExpiresAt: now - 1 }) });
    expect(intents.map((intent) => intent.type)).toEqual(["notifyUser", "recordOtel"]);
    expect(intents[0]).toMatchObject({ type: "notifyUser", reason: "grant-expired-or-exhausted" });
  });

  it("updates grant counters after public replies", () => {
    const updated = recordGrantPublicReply(grant(), now + 1_000);
    expect(updated.repliesUsed).toBe(1);
    expect(updated.conversationMode).toBe("active");
    expect(updated.humanMessagesSinceBotReply).toBe(0);
  });

  it("idles conversation mode after the configured human-only message count", () => {
    const once = recordGrantHumanMessage(grant(), now + 1_000, DEFAULT_REPLY_GRANT_LIMITS);
    const twice = recordGrantHumanMessage(once, now + 2_000, DEFAULT_REPLY_GRANT_LIMITS);
    expect(twice.conversationMode).toBe("idle");
  });
});

describe("reply grant approval resolution", () => {
  it("turns a Telegram Grant approval into a thread-scoped Reply Grant", () => {
    const decision = resolveReplyGrantApproval({
      action: "grant",
      grantedByUserId: "UJOEL",
      now,
      approval: {
        platform: "slack",
        channelId: "CBRAIN",
        threadTs: "111.222",
        messageTs: "333.444",
        userId: "UJOHN",
        userLabel: "John",
        text: "@joelclaw can you answer?",
        createdAt: now - 1_000,
      },
    });

    expect(decision.type).toBe("granted");
    if (decision.type !== "granted") throw new Error("expected granted decision");
    expect(decision.grant.channelId).toBe("CBRAIN");
    expect(decision.grant.threadTs).toBe("111.222");
    expect(decision.grant.grantedByUserId).toBe("UJOEL");
    expect(decision.grant.invokerUserIds).toEqual(["UJOHN"]);
  });

  it("keeps Ignore as a non-granting terminal approval decision", () => {
    const decision = resolveReplyGrantApproval({
      action: "ignore",
      grantedByUserId: "UJOEL",
      now,
      approval: {
        platform: "slack",
        channelId: "CBRAIN",
        threadTs: "111.222",
        messageTs: "333.444",
        userId: "UJOHN",
        text: "nope",
        createdAt: now,
      },
    });

    expect(decision).toEqual({ type: "ignored" });
  });
});
