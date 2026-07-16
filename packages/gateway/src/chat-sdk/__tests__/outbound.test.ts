import { afterEach, describe, expect, test } from "bun:test";
import type {
  FlowIdType,
  OutboundIntent,
  RoutingTable,
} from "@joelclaw/message-contract";
import { MESSAGE_CONTRACT_VERSION, mintFlowId } from "@joelclaw/message-contract";
import type { JournalEventInput } from "@joelclaw/message-journal";
import {
  CHAT_SDK_VERSION,
  createChatSdkRuntime,
  startChatSdkRuntime,
  TELEGRAM_ALLOWED_UPDATES,
} from "../instance";
import { mapNotifySendToIntent } from "../notify-compat";
import {
  __outboundTestUtils,
  gatewayOutboundJournal,
  makeOutboundSender,
  type OutboundFlowAnchor,
  type OutboundJournalPort,
  resolvePlatformMessageFlow,
} from "../outbound";
import { recordShadowComparison, runOutboundShadow } from "../shadow";

const TELEGRAM_DELIVER_POLICY = {
  route: async () => ({ disposition: "deliver" as const }),
};

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;

function flow(index: number): FlowIdType {
  return mintFlowId(() => UUIDS[index] ?? UUIDS[0]);
}

function intent(kind: OutboundIntent["kind"] = "memory"): OutboundIntent {
  return {
    contractVersion: MESSAGE_CONTRACT_VERSION,
    kind,
    content: "[canary] outbound v1",
    correlationId: `canary-${kind}`,
  };
}

function makeJournal(): OutboundJournalPort & {
  readonly rows: JournalEventInput[];
  readonly anchors: Map<string, OutboundFlowAnchor>;
} {
  const rows: JournalEventInput[] = [];
  const anchors = new Map<string, OutboundFlowAnchor>();
  return {
    rows,
    anchors,
    async record(row): Promise<void> {
      rows.push(row);
    },
    async remember(anchor): Promise<void> {
      anchors.set(`${anchor.platform}:${anchor.flowId}`, anchor);
    },
    async resolve(flowId, platform): Promise<OutboundFlowAnchor | undefined> {
      return anchors.get(`${platform}:${flowId}`);
    },
  };
}

afterEach(() => {
  __outboundTestUtils.clearFlowAnchors();
});

describe("Chat SDK outbound v1", () => {
  test("pins one synchronized Chat SDK train and keeps Discord disabled", () => {
    const runtime = createChatSdkRuntime({
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        DISCORD_BOT_TOKEN: "",
      },
      secrets: { lease: () => undefined },
    });
    expect(CHAT_SDK_VERSION).toBe("4.34.0");
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("message_reaction");
    expect(runtime.configured).toEqual({ telegram: true, slack: true, discord: false });
  });

  test("keeps partial startup ownership stoppable after cleanup fails", async () => {
    const runtime = createChatSdkRuntime({
      env: {},
      telegramEnabled: false,
      slackEnabled: false,
      discordEnabled: false,
      secrets: { lease: () => undefined },
    });
    let shutdownAttempts = 0;
    const chat = runtime.chat as unknown as {
      initialize: () => Promise<void>;
      shutdown: () => Promise<void>;
    };
    chat.initialize = async () => {
      throw new Error("adapter initialize failed");
    };
    chat.shutdown = async () => {
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw new Error("partial cleanup failed");
    };

    await expect(runtime.start()).rejects.toThrow(
      "partial transport cleanup is unproven",
    );
    await runtime.stop();
    expect(shutdownAttempts).toBe(2);
  });

  test("refuses transport activation without legacy ownership transfer", async () => {
    await expect(startChatSdkRuntime({ legacyTransportsStopped: false as true })).rejects.toThrow(
      "requires legacy transport shutdown proof",
    );
  });

  test("routes, sends, journals the platform id, and returns a receipt", async () => {
    const journal = makeJournal();
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => ({ id: "7:42", threadId }),
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
      now: (() => {
        const times = [
          new Date("2026-07-16T20:00:00.000Z"),
          new Date("2026-07-16T20:00:01.000Z"),
        ];
        return () => times.shift() ?? times[0] ?? new Date(0);
      })(),
    });

    const receipt = await send(intent());
    expect(receipt.data.platformMessageId).toBe("7:42");
    expect(receipt.data.deliveryState).toBe("confirmed");
    expect(journal.rows.map((row) => row.eventType)).toEqual([
      "message.outbound.requested",
      "message.outbound.confirmed",
    ]);
    expect(journal.rows[1]?.messageKey).toBe("telegram:7:42");
    expect(journal.rows[1]?.telegramMessageId).toBe(42);
    expect(journal.anchors.get(`telegram:${flow(0)}`)?.platformMessageId).toBe("7:42");
  });

  test("runs Telegram policy before the adapter and returns suppression", async () => {
    const journal = makeJournal();
    let posts = 0;
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => {
            posts += 1;
            return { id: "7:42", threadId };
          },
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: { route: async () => ({ disposition: "suppress" }) },
    });
    const receipt = await send(intent());
    expect(posts).toBe(0);
    expect(receipt.data.deliveryState).toBe("suppressed");
    expect(journal.rows.map((row) => row.eventType)).toEqual([
      "message.outbound.requested",
      "message.outbound.suppress",
    ]);
  });

  test("indexes platform message ids back to flow ids", async () => {
    const flowId = flow(0);
    await gatewayOutboundJournal.remember({
      flowId,
      platform: "telegram",
      platformMessageId: "7:42",
      threadId: "telegram:7",
    });
    expect(await resolvePlatformMessageFlow("telegram", "7:42")).toBe(flowId);
    expect(await resolvePlatformMessageFlow("telegram", "42", "7")).toBe(flowId);
  });

  test("replyTo reuses the parent platform thread", async () => {
    const journal = makeJournal();
    const parentFlow = flow(0);
    await journal.remember({
      flowId: parentFlow,
      platform: "telegram",
      platformMessageId: "42",
      threadId: "telegram:7",
    });
    let opened = false;
    let usedThread = "";
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => {
            opened = true;
            return "telegram:other";
          },
          postMessage: async (threadId) => {
            usedThread = threadId;
            return { id: "43", threadId };
          },
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(1),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });

    await send({ ...intent(), replyTo: parentFlow });
    expect(opened).toBe(false);
    expect(usedThread).toBe("telegram:7");
    expect(journal.rows.at(-1)?.metadata).toMatchObject({
      replyToFlowId: parentFlow,
      replyToPlatformMessageId: "42",
    });
  });

  test("journals a terminal failure when reply anchor is missing", async () => {
    const journal = makeJournal();
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => ({ id: "7:42", threadId }),
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(1),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });
    let tag = "";
    try {
      await send({ ...intent(), replyTo: flow(0) });
    } catch (error) {
      tag = (error as { _tag?: string })._tag ?? "";
    }
    expect(tag).toBe("ReplyAnchorNotFoundError");
    expect(journal.rows.at(-1)?.errorCode).toBe("REPLY_ANCHOR_NOT_FOUND");
  });

  test("compat shim maps semantics and ignores old channel flags", () => {
    expect(mapNotifySendToIntent({
      message: "memory ready",
      correlationId: "legacy-1",
      source: "neat-memory",
      priority: "high",
      telegramOnly: true,
      channel: "telegram",
    })).toEqual({
      contractVersion: 2,
      kind: "memory",
      content: "memory ready",
      correlationId: "legacy-1",
    });
  });

  test("shadow defaults off and records a real diff only when enabled", async () => {
    let sends = 0;
    const skipped = await runOutboundShadow(intent(), {
      env: {},
      sendSdk: async () => {
        sends += 1;
        throw new Error("must not send");
      },
      previewLegacy: () => {
        throw new Error("must not preview");
      },
      resolveSdkTarget: () => {
        throw new Error("must not resolve target");
      },
    });
    expect(skipped).toEqual({ enabled: false, reason: "flag-disabled" });
    expect(sends).toBe(0);

    const compared: unknown[] = [];
    const routeTable: RoutingTable = {
      version: 2,
      routes: {
        memory: { platform: "telegram", lane: "operator", urgency: "normal", formatting: "markdown" },
        alert: { platform: "telegram", lane: "operator", urgency: "critical", formatting: "markdown" },
        digest: { platform: "telegram", lane: "digest", urgency: "low", formatting: "markdown" },
        ask: { platform: "telegram", lane: "operator", urgency: "high", formatting: "markdown" },
        receipt: { platform: "slack", lane: "automation", urgency: "normal", formatting: "markdown" },
      },
    };
    const sdkSend = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => ({ id: "7:44", threadId }),
        },
      },
      journal: makeJournal(),
      routingTable: routeTable,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });
    const report = await runOutboundShadow(intent(), {
      env: { CHAT_SDK_OUTBOUND_SHADOW_ENABLED: "1" },
      sendSdk: sdkSend,
      previewLegacy: (_message, route) => ({
        platform: "telegram",
        target: "wrong-target",
        content: "legacy changed this",
        route,
      }),
      resolveSdkTarget: () => "7",
      recordComparison: async (value) => {
        compared.push(value);
      },
    });
    expect(report.enabled).toBe(true);
    if (report.enabled) {
      expect(report.matches).toBe(false);
      expect(report.mismatches.map((item) => item.field)).toEqual(["target", "content"]);
      const rows: JournalEventInput[] = [];
      await recordShadowComparison(report, async (row) => {
        rows.push(row);
      });
      expect(rows[0]?.telegramMessageId).toBe(44);
    }
    expect(compared).toHaveLength(1);
  });
});
