import { afterEach, describe, expect, test } from "bun:test";
import type {
  FlowIdType,
  OutboundIntent,
} from "@joelclaw/message-contract";
import {
  MESSAGE_CONTRACT_VERSION,
  mintFlowId,
  ROUTING_TABLE_V2,
} from "@joelclaw/message-contract";
import type { JournalEventInput } from "@joelclaw/message-journal";
import {
  CHAT_SDK_VERSION,
  createChatSdkRuntime,
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

const TELEGRAM_DELIVER_POLICY = {
  route: async () => ({ disposition: "deliver" as const }),
};

const CURATOR_DM = [
  "**The memory layer caught its own blind spot.** 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b)) - then decide!",
  "",
  "- keep the paragraphs",
  "- render the bullets",
  "- escape nasty punctuation: . ! - ( )",
].join("\n");

const CURATOR_NORMALIZED = CURATOR_DM.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

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
    async record(row) {
      rows.push(row);
      return {
        journalEventId: `fixture-${rows.length}`,
        persisted: true,
        storage: "writer" as const,
      };
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

  test("routes markdown through Telegram's native formatter, journals the platform id, and returns a receipt", async () => {
    const journal = makeJournal();
    let posted: unknown;
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId, message) => {
            posted = message;
            return { id: "7:42", threadId };
          },
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

    const receipt = await send({ ...intent(), content: CURATOR_DM });
    expect(posted).toEqual({ markdown: CURATOR_NORMALIZED });
    expect((posted as { markdown: string }).markdown).toContain("\n\nA smol move");
    expect((posted as { markdown: string }).markdown).toContain("\n\n• keep the paragraphs");
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

  test("honors a plain route with a raw Chat SDK postable", async () => {
    const journal = makeJournal();
    let posted: unknown;
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId, message) => {
            posted = message;
            return { id: "7:42", threadId };
          },
        },
      },
      journal,
      routingTable: {
        ...ROUTING_TABLE_V2,
        routes: {
          ...ROUTING_TABLE_V2.routes,
          memory: { ...ROUTING_TABLE_V2.routes.memory, formatting: "plain" },
        },
      },
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });

    await send({ ...intent(), content: CURATOR_DM });
    expect(posted).toEqual({ raw: CURATOR_NORMALIZED });
    expect((posted as { raw: string }).raw).toContain("\n\n• keep the paragraphs");
  });

  test("fails soft to a raw plain postable when Telegram markdown conversion fails", async () => {
    const journal = makeJournal();
    let posted: unknown;
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId, message) => {
            posted = message;
            return { id: "7:42", threadId };
          },
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
      prepareTelegramMarkdown: () => ({
        ok: false,
        markdownV2: null,
        plainText: "curator fallback",
        postable: { raw: "curator fallback" },
        error: new Error("fixture conversion failure"),
      }),
    });

    await send({ ...intent(), content: "**curator fallback**" });
    expect(posted).toEqual({ raw: "curator fallback" });
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

  test("delivers a real notify-memory shape because contract operator lane is authoritative", async () => {
    const journal = makeJournal();
    let posts = 0;
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7718912466",
          postMessage: async (threadId) => {
            posts += 1;
            return { id: "7718912466:14547", threadId };
          },
        },
      },
      journal,
      resolveTarget: () => "7718912466",
      mintFlowId: () => flow(0),
    });

    const receipt = await send({
      ...intent("memory"),
      content: "The hot-dog propagation demo came back flat twice.",
      correlationId: "hot-dog-neat-memory",
    });
    expect(posts).toBe(1);
    expect(receipt.data).toMatchObject({
      deliveryState: "confirmed",
      platformMessageId: "7718912466:14547",
    });
  });

  test("returns digested instead of confirmed when Telegram policy digests", async () => {
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
      telegramPolicy: { route: async () => ({ disposition: "digest" }) },
    });

    const receipt = await send(intent("memory"));
    expect(receipt.data.deliveryState).toBe("digested");
    expect(receipt.data.platformMessageId).toBeNull();
    expect(journal.rows.at(-1)).toMatchObject({
      eventType: "message.outbound.digest",
      deliveryState: "digested",
    });
  });

  test("refuses confirmation when the platform id could not be journaled", async () => {
    const journal = makeJournal();
    const failingJournal: OutboundJournalPort = {
      ...journal,
      async record(row) {
        const receipt = await journal.record(row);
        return row.eventType === "message.outbound.confirmed"
          ? { ...receipt, persisted: false, storage: "failed" as const }
          : receipt;
      },
    };
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => ({ id: "7:42", threadId }),
        },
      },
      journal: failingJournal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });

    await expect(send(intent("alert"))).rejects.toMatchObject({
      _tag: "MessageDeliveryError",
    });
    expect(journal.rows.map((row) => row.eventType)).toEqual([
      "message.outbound.requested",
      "message.outbound.confirmed",
      "message.outbound.failed",
    ]);
  });

  test("preserves a bounded Telegram Bot API receipt in journal metadata", async () => {
    const journal = makeJournal();
    const send = makeOutboundSender({
      adapters: {
        telegram: {
          openDM: async () => "telegram:7",
          postMessage: async (threadId) => ({
            id: "7:42",
            threadId,
            raw: {
              message_id: 42,
              date: 1_784_240_000,
              chat: { id: 7, type: "private", username: "must-not-leak" },
              text: "must-not-duplicate",
            },
          }),
        },
      },
      journal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: TELEGRAM_DELIVER_POLICY,
    });

    await send(intent("alert"));
    expect(journal.rows.at(-1)?.metadata).toMatchObject({
      platformReceipt: {
        messageId: 42,
        date: 1_784_240_000,
        chatId: 7,
        chatType: "private",
      },
    });
    expect(JSON.stringify(journal.rows.at(-1)?.metadata)).not.toContain("must-not");
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
      correlationId: "neat-memory:legacy-1",
    });
  });

});
