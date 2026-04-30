import { describe, expect, test } from "bun:test";
import {
  buildSignalDigestPrompt,
  buildSignalRelayGuidance,
  classifyOperatorSignal,
  isImmediateOperatorPriorityEvent,
  normalizeOperatorRelayText,
  type OperatorRelayEvent,
} from "./operator-relay";

function makeEvent(overrides: Partial<OperatorRelayEvent>): OperatorRelayEvent {
  return {
    type: "front.message.received",
    source: "inngest/front-notify",
    payload: {},
    ...overrides,
  };
}

describe("normalizeOperatorRelayText", () => {
  test("strips HEARTBEAT_OK leakage from non-heartbeat project relay", () => {
    expect(
      normalizeOperatorRelayText(
        "slack-intel:C07CURG8YB1",
        "HEARTBEAT_OK — egghead Slack, Joel asking the team for help with a link swap in Kit.",
      ),
    ).toBe("egghead Slack, Joel asking the team for help with a link swap in Kit.");
  });

  test("preserves actual heartbeat acknowledgements", () => {
    expect(normalizeOperatorRelayText("heartbeat", "HEARTBEAT_OK. 2 VIP emails, noted.")).toBe(
      "HEARTBEAT_OK. 2 VIP emails, noted.",
    );
  });
});

describe("classifyOperatorSignal", () => {
  test("ingests VIP email events that are delivered directly to Telegram", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "vip.email.received",
        source: "inngest/vip-email-received",
        payload: {
          from: "alex@example.com",
          fromName: "Alex Hillman",
          subject: "AI Hero pricing + membership",
          prompt: "Questions for Joel: should AI Hero cohort pricing change before launch?",
          conversationId: "cnv_123",
        },
      }),
    );

    expect(decision.bucket).toBe("ingested");
    expect(decision.reason).toBe("ingested.vip-delivered-direct");
    expect(decision.projectKeys).toContain("ai-hero");
    expect(decision.correlationKeys).toContain("conversation:cnv_123");
  });

  test("treats actionable Joel Slack intel as immediate signal", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "slack.signal.received",
        source: "slack-intel:C07CURG8YB1",
        payload: {
          prompt: "egghead Slack Joel: need help with a link swap in Kit for the AI Hero teaser page",
          joelSignal: true,
          slackChannelId: "C07CURG8YB1",
        },
      }),
    );

    expect(decision.bucket).toBe("immediate");
    expect(decision.reason).toBe("immediate.signal-score");
    expect(decision.projectKeys).toContain("ai-hero");
  });

  test("batches lower-signal Slack intel instead of paging immediately", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "slack.signal.received",
        source: "slack-intel:C07GAAF7RCY",
        payload: {
          prompt: "Interesting — that's a skills.sh listing for the Vercel Labs agent-browser.",
          joelSignal: true,
          slackChannelId: "C07GAAF7RCY",
        },
      }),
    );

    expect(decision.bucket).toBe("batched");
  });

  test("suppresses raw inbound email newsletters instead of paging Telegram", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "front.message.received",
        source: "inngest/front-notify",
        payload: {
          from: "news@example.com",
          subject: "Restocked: summer drop",
          prompt: "## 📧 Inbound Email\n\nSubject: Restocked: summer drop\n\nTriage: needs reply? Needs scheduling? Forward to someone? Tag for follow-up? If it's noise (newsletter, notification), acknowledge briefly.",
        },
      }),
    );

    expect(decision.bucket).toBe("suppressed");
    expect(decision.reason).toBe("suppressed.email-noise");
  });

  test("pages production and money email failures", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "front.message.received",
        source: "inngest/front-notify",
        payload: {
          from: "mailer@shopify.com",
          subject: "Customers can't check out — Update business details",
          prompt: "Shopify says customers can't check out until business details are updated.",
        },
      }),
    );

    expect(decision.bucket).toBe("immediate");
    expect(decision.reason).toBe("immediate.email-page-now");
  });

  test("batches project emails without a direct ask", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "front.message.received",
        source: "inngest/front-notify",
        payload: {
          fromName: "Matt Pocock",
          from: "matt@example.com",
          subject: "AI Hero curriculum shape",
          prompt: "Matt is thinking through the AI Hero cohort and crash course structure.",
        },
      }),
    );

    expect(decision.bucket).toBe("batched");
    expect(decision.reason).toBe("batched.email-project-or-human");
  });

  test("suppresses low-signal recovered automation chatter", () => {
    const decision = classifyOperatorSignal(
      makeEvent({
        type: "recovered",
        source: "system-health",
        payload: {
          status: "recovered",
          preview: "Agent Secrets daemon healthy",
          prompt: "Agent Secrets daemon healthy",
        },
      }),
    );

    expect(decision.bucket).toBe("suppressed");
    expect(decision.reason).toBe("suppressed.recovered-low-signal");
  });
});

describe("isImmediateOperatorPriorityEvent", () => {
  test("reflects the canonical signal classifier", () => {
    expect(
      isImmediateOperatorPriorityEvent(
        makeEvent({
          type: "vip.email.received",
          source: "inngest/vip-email-received",
          payload: { subject: "AI Hero launch" },
        }),
      ),
    ).toBe(false);
  });
});

describe("signal digest and guidance", () => {
  test("omits ingested VIP email events from the digest", () => {
    const prompt = buildSignalDigestPrompt([
      makeEvent({
        type: "vip.email.received",
        source: "inngest/vip-email-received",
        payload: {
          fromName: "Alex Hillman",
          from: "alex@example.com",
          subject: "AI Hero membership",
          prompt: "Questions for Joel: should the AI Hero membership teaser title change?",
          conversationId: "cnv_123",
        },
      }),
      makeEvent({
        type: "cron.heartbeat",
        source: "inngest/heartbeat.cron",
        payload: {
          status: "HEARTBEAT_OK",
          prompt: "HEARTBEAT_OK",
        },
      }),
      makeEvent({
        type: "slack.signal.received",
        source: "slack-intel:C07CURG8YB1",
        payload: {
          prompt: "egghead Slack Joel: need help with a link swap in Kit for the AI Hero teaser page",
          joelSignal: true,
          slackChannelId: "C07CURG8YB1",
        },
      }),
    ]);

    expect(prompt).toContain("## 🔔 Signal Digest");
    expect(prompt).not.toContain("VIP email from Alex Hillman — AI Hero membership");
    expect(prompt).not.toContain("misc:cron.heartbeat");
    expect(prompt).not.toContain("inngest/heartbeat.cron");
    expect(prompt).toContain("Slack C07CURG8YB1");
  });

  test("guidance bans heartbeat sludge", () => {
    const guidance = buildSignalRelayGuidance([
      makeEvent({
        type: "slack.signal.received",
        source: "slack-intel:C07CURG8YB1",
        payload: {
          prompt: "egghead Slack Joel: need help with a link swap in Kit",
          joelSignal: true,
          slackChannelId: "C07CURG8YB1",
        },
      }),
    ]);

    expect(guidance).toContain("Never answer with HEARTBEAT_OK");
    expect(guidance).toContain("project:egghead");
  });
});
