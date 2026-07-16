import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEvent } from "@joelclaw/message-journal";
import { createChannelDeliveryAudit } from "@joelclaw/telemetry";
import { __redisTestUtils } from "./channels/redis";
import { __messageJournalTestUtils } from "./message-journal";
import {
  __telegramOutboundPolicyTestUtils,
  resolveTelegramOutboundPolicyContext,
  routeTelegramOutbound,
  specializedTelegramApi,
  TELEGRAM_SPECIALIZED_UI_SURFACES,
  telegramConversationReplyExemption,
} from "./telegram-outbound-policy";

const noOpDependencies = {
  queueDigest: async () => {},
  journalSuppression: async () => {},
};

function input(
  sourceEventType: string,
  content: string,
  flowId = "flow-1",
) {
  return {
    chatId: 42,
    content,
    audit: createChannelDeliveryAudit(content, {
      flowId,
      producer: "fixture-producer",
      originSystemId: "test",
      eventId: "event-1",
      route: "fixture",
    }),
    policy: { sourceEventType },
  };
}

afterEach(() => {
  __telegramOutboundPolicyTestUtils.clearInvestigations();
  __messageJournalTestUtils.clear();
});

describe("Telegram outbound policy routing", () => {
  test("routes verify-voice failures into an investigating lifecycle actor", async () => {
    const routed = await routeTelegramOutbound(
      input("verify-voice.failed", "verify-voice FAILED: probe timed out", "verify-voice-1"),
      noOpDependencies,
    );

    expect(routed).toMatchObject({
      disposition: "investigate",
      lifecycleState: "investigating",
      decision: {
        category: "infra",
        reason: "investigate.infrastructure-or-escalation-signal",
      },
    });
    expect(
      __telegramOutboundPolicyTestUtils.activeInvestigationState("verify-voice-1"),
    ).toBe("investigating");
  });

  test("queues digest candidates instead of delivering them", async () => {
    const queued: string[] = [];
    const routed = await routeTelegramOutbound(
      input("memory.candidate", "A useful memory"),
      {
        ...noOpDependencies,
        queueDigest: async (_input, decision) => {
          queued.push(decision.reason);
        },
      },
    );

    expect(routed.disposition).toBe("digest");
    expect(queued).toEqual(["digest.memory-candidate"]);
  });

  test("journals suppressed noise with the queryable policy reason", async () => {
    const journaled: JournalEvent[] = [];
    __messageJournalTestUtils.setWriteOverride(async (row) => {
      journaled.push(row);
    });

    const routed = await routeTelegramOutbound(
      input("health.probe.ok", "healthy"),
    );

    expect(routed.disposition).toBe("suppress");
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      event_type: "delivery.suppressed",
      classification: "noise",
      reason: "suppress.routine-machine-noise",
      text: "healthy",
      delivery_state: "suppressed",
    });
  });

  test("explicitly delivers assembled digests without a specialized UI exemption", async () => {
    const routed = await routeTelegramOutbound(
      input("signal/digest.assembled", "Qualified digest"),
      noOpDependencies,
    );

    expect(routed).toMatchObject({
      disposition: "deliver",
      decision: {
        category: "action",
        reason: "deliver.explicit.signal-digest-assembled",
      },
    });
  });

  test("explicitly delivers contract-v2 operator-lane messages at normal urgency", async () => {
    const routed = await routeTelegramOutbound(
      {
        ...input("message-contract/operator", "A surfaced memory"),
        policy: {
          sourceEventType: "message-contract/operator",
          sourceClassification: "memory",
          priority: "normal",
          level: "info",
        },
      },
      noOpDependencies,
    );

    expect(routed).toMatchObject({
      disposition: "deliver",
      decision: {
        category: "action",
        reason: "deliver.explicit.message-contract-operator-lane",
      },
    });
  });

  test("explicit Joel conversation replies bypass classification", async () => {
    const routed = await routeTelegramOutbound(
      {
        ...input("telegram.message.received", "Yep, done."),
        policy: {
          sourceEventType: "telegram.message.received",
          exemption: telegramConversationReplyExemption(42),
        },
      },
      noOpDependencies,
    );

    expect(routed).toMatchObject({
      disposition: "deliver",
      decision: { reason: "deliver.exempt.joel-initiated-conversation-reply" },
    });
  });

  test("rejects a conversation exemption for a different outbound chat", async () => {
    const routed = await routeTelegramOutbound(
      {
        ...input("telegram.message.received", "cross-chat reply"),
        policy: {
          sourceEventType: "telegram.message.received",
          exemption: telegramConversationReplyExemption(7),
        },
      },
      noOpDependencies,
    );

    expect(routed.disposition).toBe("investigate");
  });

  test("grants conversation exemption only to trusted matching inbound metadata", () => {
    expect(
      resolveTelegramOutboundPolicyContext(undefined, "telegram:42").exemption,
    ).toBeUndefined();
    expect(
      resolveTelegramOutboundPolicyContext(
        {
          trustedTelegramInbound: true,
          telegramChatId: 7,
          telegramMessageId: 99,
        },
        "telegram:42",
      ).exemption,
    ).toBeUndefined();
    expect(
      resolveTelegramOutboundPolicyContext(
        {
          trustedTelegramInbound: true,
          telegramChatId: 42,
          telegramMessageId: 99,
        },
        "telegram:42",
      ).exemption,
    ).toMatchObject({ marker: "telegram-policy-exempt:conversation-reply" });
  });

  test("preserves Redis triage classification and reason for journaling", () => {
    expect(resolveTelegramOutboundPolicyContext({
      signalClassification: "immediate",
      signalReason: "immediate.high-priority",
    }, "gateway")).toMatchObject({
      sourceClassification: "immediate",
      sourceReason: "immediate.high-priority",
    });
  });

  test("maps gateway.notify priority into the immediate policy seam", () => {
    const base = {
      id: "event-1",
      type: "notify.message",
      source: "fixture",
      ts: 1,
    };

    expect(
      __redisTestUtils.isImmediateTelegramEvent({
        ...base,
        payload: { priority: "urgent" },
      }),
    ).toBe(true);
    expect(
      __redisTestUtils.isImmediateTelegramEvent({
        ...base,
        payload: { priority: "high" },
      }),
    ).toBe(true);
    expect(
      __redisTestUtils.isImmediateTelegramEvent({
        ...base,
        payload: { priority: "normal" },
      }),
    ).toBe(false);
  });

  test("selects the strongest batch event independent of arrival order", () => {
    const noise = {
      id: "noise",
      type: "health.probe.ok",
      source: "fixture",
      ts: 1,
      payload: {},
    };
    const recovery = {
      id: "recovery",
      type: "service.recovered",
      source: "fixture",
      ts: 2,
      payload: { priority: "urgent", level: "warn" },
    };

    expect(__redisTestUtils.selectPolicySourceEventType([noise, recovery]))
      .toBe("service.recovered");
    expect(__redisTestUtils.selectPolicySourceEventType([recovery, noise]))
      .toBe("service.recovered");
  });

  test("specialized UI bypasses are explicit and type-checked", () => {
    const api = { sendMessage: () => "ok" };
    for (const surface of TELEGRAM_SPECIALIZED_UI_SURFACES) {
      expect(specializedTelegramApi(api, surface)).toBe(api);
    }
  });
});
