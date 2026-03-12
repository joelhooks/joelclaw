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
  test("promotes VIP email events out of digest batching", () => {
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

    expect(decision.bucket).toBe("immediate");
    expect(decision.reason).toBe("immediate.vip-email");
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
    ).toBe(true);
  });
});

describe("signal digest and guidance", () => {
  test("builds a correlated digest across email and slack", () => {
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
    expect(prompt).toContain("### ai-hero");
    expect(prompt).toContain("VIP email from Alex Hillman — AI Hero membership");
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
