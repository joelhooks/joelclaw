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
  type OutboundTerminalReceipt,
  resolvePlatformMessageFlow,
} from "../outbound";
import {
  GatewayTelegramAdapter,
  isTelegramActionMessage,
} from "../telegram-adapter";

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
  readonly terminals: OutboundTerminalReceipt[];
} {
  const rows: JournalEventInput[] = [];
  const anchors = new Map<string, OutboundFlowAnchor>();
  const terminals: OutboundTerminalReceipt[] = [];
  return {
    rows,
    anchors,
    terminals,
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
    async rememberTerminal(receipt): Promise<void> {
      terminals.push(receipt);
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

  test("renders semantic actions as Telegram-native inline buttons", async () => {
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
    });

    await send({
      ...intent("alert"),
      content: "**Healthy.**\n\n[Open the Brain](https://brain.joelclaw.com)",
      actions: [
        { kind: "callback", id: "learner-flow.ack", label: "Seen" },
        { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
        { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
      ],
    });

    expect(posted).toEqual({
      telegramActionMessage: true,
      markdownV2: "*Healthy\\.*\n\n[Open the Brain](https://brain.joelclaw.com)",
      plainText: "Healthy.\n\nOpen the Brain",
      actions: [
        { kind: "callback", id: "learner-flow.ack", label: "Seen" },
        { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
        { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
      ],
    });
    expect(journal.rows[1]?.metadata).toMatchObject({
      correlationId: "canary-alert",
      declaredActions: [
        { id: "learner-flow.ack", label: "Seen" },
        { id: "learner-flow.run", label: "Run flow agent" },
        { id: "learner-flow.investigate", label: "Investigate" },
      ],
    });
    expect(journal.terminals).toEqual([
      expect.objectContaining({
        correlationId: "canary-alert",
        deliveryState: "confirmed",
        platformMessageId: "7:42",
      }),
    ]);
  });

  test("keeps buttons when MarkdownV2 delivery degrades to plain text", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let sendAttempts = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        calls.push({ method, body });
        if (method === "sendMessage" && sendAttempts++ === 0) {
          return Response.json(
            { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1,
            chat: { id: 7, type: "private" },
            text: body.text,
          },
        });
      },
    });

    try {
      const telegram = new GatewayTelegramAdapter({
        botToken: "fixture-token",
        apiUrl: `http://127.0.0.1:${server.port}`,
      });
      const journal = makeJournal();
      const send = makeOutboundSender({
        adapters: {
          telegram: {
            openDM: async () => "telegram:7",
            postMessage: (threadId, message) =>
              isTelegramActionMessage(message)
                ? telegram.postActionMessage(threadId, message)
                : telegram.postMessage(threadId, message),
          },
        },
        journal,
        resolveTarget: () => "7",
        mintFlowId: () => flow(0),
        telegramPolicy: TELEGRAM_DELIVER_POLICY,
      });

      await send({
        ...intent("alert"),
        content: "**Healthy.** A raw period. [Brain](https://brain.joelclaw.com)",
        actions: [
          { kind: "callback", id: "learner-flow.ack", label: "Seen" },
          { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
          { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
        ],
      });

      expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"]);
      expect(calls[0]?.body).toMatchObject({
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [{
              text: "Seen",
              callback_data: "chat:{\"a\":\"message_action\",\"v\":\"learner-flow.ack\"}",
            }],
            [
              {
                text: "Run flow agent",
                callback_data: "chat:{\"a\":\"message_action\",\"v\":\"learner-flow.run\"}",
              },
              {
                text: "Investigate",
                callback_data: "chat:{\"a\":\"message_action\",\"v\":\"learner-flow.investigate\"}",
              },
            ],
          ],
        },
      });
      expect(calls[1]?.body).toMatchObject({
        text: "Healthy. A raw period. Brain",
        reply_markup: calls[0]?.body.reply_markup,
      });
      expect(calls[1]?.body.parse_mode).toBeUndefined();
    } finally {
      server.stop(true);
    }
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

  test("never lets signal policy suppress a contract-v2 message", async () => {
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
    expect(posts).toBe(1);
    expect(receipt.data.deliveryState).toBe("confirmed");
    expect(journal.rows.map((row) => row.eventType)).toEqual([
      "message.outbound.requested",
      "message.outbound.confirmed",
    ]);
  });

  test("delivers a real notify-memory shape because kind-derived delivery is authoritative", async () => {
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

  test("falls back to immediate delivery when no verified contract batch assembler exists", async () => {
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
    });

    const receipt = await send(intent("digest"));
    expect(posts).toBe(1);
    expect(receipt.data).toMatchObject({
      deliveryState: "confirmed",
      platformMessageId: "7:42",
      route: { delivery: "batch" },
    });
  });

  test("returns digested after the Telegram policy durably batches a digest", async () => {
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

    const receipt = await send(intent("digest"));
    expect(receipt.data.deliveryState).toBe("digested");
    expect(receipt.data.platformMessageId).toBeNull();
    expect(journal.rows.at(-1)).toMatchObject({
      eventType: "message.outbound.digest",
      deliveryState: "digested",
    });
  });

  test("does not fall back to immediate after a digest was queued but receipt journaling failed", async () => {
    const journal = makeJournal();
    const failingJournal: OutboundJournalPort = {
      ...journal,
      async record(row) {
        const result = await journal.record(row);
        return row.eventType === "message.outbound.digest"
          ? { ...result, persisted: false, storage: "failed" as const }
          : result;
      },
    };
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
      journal: failingJournal,
      resolveTarget: () => "7",
      mintFlowId: () => flow(0),
      telegramPolicy: { route: async () => ({ disposition: "digest" }) },
    });

    await expect(send(intent("digest"))).rejects.toMatchObject({
      _tag: "MessageDeliveryError",
    });
    expect(posts).toBe(0);
    expect(journal.rows.map((row) => row.eventType)).toEqual([
      "message.outbound.requested",
      "message.outbound.digest",
      "message.outbound.failed",
    ]);
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

  test("compat shim maps legacy priority and ignores source and channel flags", () => {
    expect(mapNotifySendToIntent({
      message: "memory ready",
      correlationId: "legacy-1",
      source: "neat-memory",
      priority: "high",
      telegramOnly: true,
      channel: "telegram",
    })).toEqual({
      contractVersion: 2,
      kind: "alert",
      content: "memory ready",
      correlationId: "neat-memory:legacy-1",
    });
  });

});
