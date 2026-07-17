import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import {
  type InboundReactionEventType,
  MessageFlowReference,
  MessageReactionReceivedEvent,
} from "@joelclaw/message-contract";
import { createJournalEvent } from "@joelclaw/message-journal";
import { Schema } from "effect";
import {
  __messageReactionTestUtils,
  buildReactionReceivedEnvelope,
  gradeNeatMemoryReaction,
  isAuthorizedJoelReaction,
  mapReactionOutcome,
  resolveReactionFlow,
} from "../../lib/message-reactions";
import {
  createMessageReactionBridgeFunction,
  createNeatMemoryReactionGradeFunction,
  messageReactionBridge,
  neatMemoryReactionGrade,
} from "./message-reactions";

const LEGACY_FLOW = Schema.decodeUnknownSync(MessageFlowReference)(
  "notify:7c1924bc-b192-42da-b145-64dedfa2fe94",
);

const REAL_TELEGRAM_REACTION: InboundReactionEventType = {
  actor: {
    displayName: "joel ⛈️",
    isBot: false,
    isSelf: false,
    platformUserId: "7718912466",
    userName: "lowdown976",
  },
  added: true,
  audit: {
    lineageId: "706b263ee00a14d1e52d34696f5f644e435d7353261d10fecf12764610c2a622",
    normalizedAt: "2026-07-17T03:26:18.910Z",
    rawEventId: "777932597",
    rawEventType: "message_reaction",
    sdkName: "vercel/chat",
    sdkVersion: "4.34.0",
    source: "gateway.telegram.message_reaction",
    transport: "polling",
  },
  authorization: {
    actualActorId: "7718912466",
    canExecute: false,
    canPublish: true,
    expectedActorId: "7718912466",
    policyAction: "observe",
    reason: "authorized_joel",
    verdict: "accepted",
  },
  contractVersion: 2,
  emoji: "clap",
  eventId: "telegram:reaction:706b263ee00a14d1e52d34696f5f644e435d7353261d10fecf12764610c2a622",
  observedAt: "2026-07-17T03:26:18.905Z",
  occurredAt: "2026-07-17T03:26:18.905Z",
  platform: "telegram",
  platformIds: {
    actorId: "7718912466",
    conversationId: "7718912466",
    messageId: "14562",
    threadId: "telegram:7718912466",
    workspaceId: null,
  },
  rawAnchors: {
    callbackQueryId: null,
    sourceMessageId: "14562",
    sourceThreadId: "telegram:7718912466",
    transportEventId: "777932597",
    updateId: "777932597",
  },
  rawEmoji: "👏",
  shadow: true,
  type: "reaction",
};

afterEach(() => {
  __messageReactionTestUtils.resetJournalQuery();
});

describe("message reaction bridge", () => {
  test("correlates the real nested Telegram shape through the legacy flow index", async () => {
    const redis = {
      async get(key: string): Promise<string | null> {
        return key === "joelclaw:message-journal:telegram-flow:7718912466:14562"
          ? "notify:7c1924bc-b192-42da-b145-64dedfa2fe94"
          : null;
      },
    };

    const correlation = await resolveReactionFlow(REAL_TELEGRAM_REACTION, redis);
    expect(correlation).toEqual({
      flowId: "notify:7c1924bc-b192-42da-b145-64dedfa2fe94",
      source: "redis-legacy-telegram",
    });

    const outgoing = buildReactionReceivedEnvelope(REAL_TELEGRAM_REACTION, correlation!);
    expect(outgoing).toEqual({
      id: "telegram:reaction:706b263ee00a14d1e52d34696f5f644e435d7353261d10fecf12764610c2a622:flow:notify:7c1924bc-b192-42da-b145-64dedfa2fe94",
      name: "message/reaction.received",
      data: {
        contractVersion: 2,
        flowId: LEGACY_FLOW,
        platform: "telegram",
        actor: { id: "7718912466", displayName: "joel ⛈️" },
        emoji: "👏",
        action: "added",
        added: true,
        at: "2026-07-17T03:26:18.905Z",
        rawEventId: "777932597",
        platformMessageId: "14562",
        correlationSource: "redis-legacy-telegram",
      },
    });
    expect(() => Schema.decodeUnknownSync(MessageReactionReceivedEvent)(outgoing)).not.toThrow();
  });

  test("rejects a reaction whose actor does not match Joel's authorization", () => {
    const rejected = {
      ...REAL_TELEGRAM_REACTION,
      actor: { ...REAL_TELEGRAM_REACTION.actor, platformUserId: "999" },
    };
    expect(isAuthorizedJoelReaction(rejected)).toBe(false);
    expect(isAuthorizedJoelReaction(REAL_TELEGRAM_REACTION)).toBe(true);
  });

  test("falls back to the durable local journal spool when Redis misses", async () => {
    const outbox = await mkdtemp(join(tmpdir(), "reaction-journal-"));
    const row = createJournalEvent({
      messageKey: "telegram:7718912466:notify:fixture",
      flowId: "notify:fixture",
      channel: "telegram",
      direction: "outbound",
      eventType: "delivery.confirmed",
      occurredAt: "2026-07-17T03:21:05.615Z",
      producer: "cli/notify",
      originSystemId: "flagg",
      telegramChatId: 7_718_912_466,
      telegramMessageId: 14_562,
      deliveryState: "confirmed",
    });
    await writeFile(join(outbox, "fixture.json"), JSON.stringify(row));

    const correlation = await resolveReactionFlow(
      REAL_TELEGRAM_REACTION,
      { get: async () => null },
      { outboxDirectory: outbox },
    );
    expect(correlation).toEqual({ flowId: "notify:fixture", source: "journal" });
  });

  test("declares raw-event idempotence on both durable consumers", () => {
    const bridgeOptions = (messageReactionBridge as unknown as {
      opts?: { idempotency?: string };
    }).opts;
    const gradeOptions = (neatMemoryReactionGrade as unknown as {
      opts?: { idempotency?: string };
    }).opts;

    expect(bridgeOptions?.idempotency).toBe("event.data.audit.rawEventId");
    expect(gradeOptions?.idempotency).toBe("event.data.rawEventId");
  });

  test("executes the real event through the Inngest handler", async () => {
    const sends: unknown[][] = [];
    const fn = createMessageReactionBridgeFunction({
      redis: () => ({ get: async () => null }),
      resolveFlow: async () => ({ flowId: LEGACY_FLOW, source: "journal" }),
      emit: async () => {},
    });
    const engine = new InngestTestEngine({
      function: fn,
      events: [{ name: "message/inbound.reaction", data: REAL_TELEGRAM_REACTION }],
      transformCtx: (ctx: any) => {
        ctx.step.sendEvent = async (...args: unknown[]) => {
          sends.push(args);
          return { ids: ["fixture-reaction-event"] };
        };
        ctx.step.sendEvent.mock = { calls: sends };
        return ctx;
      },
    });

    const execution = await engine.execute();
    expect(execution.result).toMatchObject({
      status: "published",
      rawEventId: "777932597",
      flowId: LEGACY_FLOW,
    });
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.at(-1)?.[1]).toMatchObject({
      name: "message/reaction.received",
      data: { rawEventId: "777932597", action: "added" },
    });
  });

  test("handler stops rejected actors before correlation", async () => {
    let correlationCalls = 0;
    const fn = createMessageReactionBridgeFunction({
      redis: () => ({ get: async () => null }),
      resolveFlow: async () => {
        correlationCalls += 1;
        return undefined;
      },
      emit: async () => {},
    });
    const rejected = {
      ...REAL_TELEGRAM_REACTION,
      actor: { ...REAL_TELEGRAM_REACTION.actor, platformUserId: "999" },
    };
    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: "message/inbound.reaction", data: rejected }],
    }).execute();

    expect(execution.result).toMatchObject({
      status: "ignored",
      reason: "unauthorized-actor",
    });
    expect(correlationCalls).toBe(0);
  });
});

describe("neat-memory reaction grading", () => {
  test("accepts the canonical gateway-acting envelope through the handler", async () => {
    const received: unknown[] = [];
    const fn = createNeatMemoryReactionGradeFunction({
      grade: async (reaction) => {
        received.push(reaction);
        return {
          status: "ignored",
          flowId: reaction.flowId,
          reason: "emoji-unmapped",
        };
      },
      emit: async () => {},
    });
    const data = Schema.decodeUnknownSync(MessageReactionReceivedEvent)({
      name: "message/reaction.received",
      data: {
        contractVersion: 2,
        flowId: "flow_v2_11111111-1111-4111-8111-111111111111",
        platform: "telegram",
        actor: { id: "7718912466", displayName: "Joel" },
        emoji: "👏",
        action: "added",
        added: true,
        rawEventId: "777932597",
        platformMessageId: "14562",
        correlationSource: "gateway-acting",
        at: "2026-07-17T03:26:18.905Z",
      },
    }).data;
    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: "message/reaction.received", data }],
    }).execute();

    expect(execution.result).toMatchObject({ status: "ignored", reason: "emoji-unmapped" });
    expect(received).toEqual([data]);
  });

  test("maps the configured positive and negative emoji grades", () => {
    for (const emoji of ["👍", "❤️", "🔥", "💯", "thumbsup"]) {
      expect(mapReactionOutcome(emoji)).toBe("worked");
    }
    for (const emoji of ["👎", "💩", "thumbsdown"]) {
      expect(mapReactionOutcome(emoji)).toBe("did-not-work");
    }
    expect(mapReactionOutcome("👏")).toBeUndefined();
  });

  test("matches the source journal receipt, writes atomically, and stays idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neat-memory-grade-"));
    const statePath = join(directory, "observer-neat-memories.json");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sent: [{
        slug: "2026-07-16-aa0e30399804",
        sentAt: "2026-07-16T23:02:26.477Z",
        promptVersion: "observer/neat-memory-simple-v1",
        score: 9,
        flavor: "useful-resurfacing",
        judgeConfig: { model: "fixture" },
      }],
    }));
    await chmod(statePath, 0o644);

    const journalRow = createJournalEvent({
      messageKey: "telegram:7718912466:notify:fixture",
      flowId: "notify:fixture",
      channel: "telegram",
      direction: "outbound",
      eventType: "delivery.confirmed",
      occurredAt: "2026-07-16T23:02:56.980Z",
      producer: "observer/neat-memory",
      originSystemId: "flagg",
      telegramChatId: 7_718_912_466,
      telegramMessageId: 14_548,
      deliveryState: "confirmed",
    });
    const reaction = {
      contractVersion: 2 as const,
      flowId: LEGACY_FLOW,
      platform: "telegram" as const,
      actor: { id: "7718912466" },
      emoji: "👍",
      action: "added" as const,
      added: true,
      at: "2026-07-17T03:26:18.905Z",
      rawEventId: "777932597",
      platformMessageId: "14548",
      correlationSource: "journal" as const,
    };

    const first = await gradeNeatMemoryReaction(reaction, {
      statePath,
      loadJournalRows: async () => [journalRow],
    });
    expect(first).toMatchObject({
      status: "graded",
      slug: "2026-07-16-aa0e30399804",
      outcome: "worked",
    });
    expect(JSON.parse(await readFile(statePath, "utf8")).sent[0].outcome).toBe("worked");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const second = await gradeNeatMemoryReaction(reaction, {
      statePath,
      loadJournalRows: async () => [journalRow],
    });
    expect(second.status).toBe("already-graded");
  });

  test("refuses ambiguous timestamp-only state matching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neat-memory-ambiguous-"));
    const statePath = join(directory, "observer-neat-memories.json");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sent: [
        { slug: "first", sentAt: "2026-07-16T23:02:20.000Z", outcome: null },
        { slug: "second", sentAt: "2026-07-16T23:03:20.000Z", outcome: null },
      ],
    }));
    const journalRow = createJournalEvent({
      messageKey: "telegram:7:notify:ambiguous",
      flowId: "notify:ambiguous",
      direction: "outbound",
      eventType: "delivery.confirmed",
      occurredAt: "2026-07-16T23:02:56.980Z",
      producer: "observer/neat-memory",
      originSystemId: "flagg",
      telegramChatId: 7,
      telegramMessageId: 42,
      deliveryState: "confirmed",
    });

    const result = await gradeNeatMemoryReaction({
      contractVersion: 2,
      flowId: LEGACY_FLOW,
      platform: "telegram",
      actor: { id: "7718912466" },
      emoji: "👍",
      action: "added",
      added: true,
      at: "2026-07-17T03:26:18.905Z",
      rawEventId: "777932597",
      platformMessageId: "14548",
      correlationSource: "journal",
    }, {
      statePath,
      loadJournalRows: async () => [journalRow],
    });

    expect(result).toEqual({
      status: "ignored",
      flowId: LEGACY_FLOW,
      reason: "state-entry-ambiguous",
    });
  });

  test("ignores unrecognized emoji without reading or writing state", async () => {
    const result = await gradeNeatMemoryReaction({
      contractVersion: 2,
      flowId: LEGACY_FLOW,
      platform: "telegram",
      actor: { id: "7718912466" },
      emoji: "👏",
      action: "added",
      added: true,
      at: "2026-07-17T03:26:18.905Z",
      rawEventId: "777932597",
      platformMessageId: "14562",
      correlationSource: "journal",
    });
    expect(result).toEqual({
      status: "ignored",
      flowId: LEGACY_FLOW,
      reason: "emoji-unmapped",
    });
  });
});
