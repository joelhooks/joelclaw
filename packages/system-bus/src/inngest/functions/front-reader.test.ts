import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NonRetriableError } from "inngest";
import { buildMessageId, normalizeChannelTimestamp } from "./channel-message-ingest";
import {
  advanceWatermark,
  buildChannelMessageData,
  createFrontReaderFunction,
  FRONT_READER_MAX_LOOKBACK_MS,
  FRONT_READER_OVERLAP_MS,
  type FrontEventRecord,
  type FrontReaderDependencies,
  fetchFrontConversationMessagesPage,
  fetchFrontConversationsPage,
  fetchFrontMessagesSince,
  formatFrontHttpError,
  normalizeFrontConversation,
  normalizeFrontEvent,
  normalizeFrontMessage,
  requireFrontApiToken,
  resolvePollWindow,
  runFrontReader,
  stableChannelMessageIdentity,
  toTimestampMs,
} from "./front-reader";

function shaId(message: {
  channelType: string;
  channelId: string;
  threadId?: string;
  userId: string;
  timestamp: number;
  text: string;
}): string {
  const digest = createHash("sha1")
    .update(
      [
        message.channelType,
        message.channelId,
        message.threadId ?? "",
        message.userId,
        String(message.timestamp),
        message.text,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return `${message.channelType}:${message.channelId}:${message.timestamp}:${digest}`;
}

function fixtureEvent(overrides: Partial<FrontEventRecord> = {}): FrontEventRecord {
  return {
    id: "msg:msg_1",
    type: "inbound",
    emittedAtMs: 1_700_000_000_000,
    conversationId: "cnv_1",
    subject: "Hello",
    messageId: "msg_1",
    from: "alex@indyhall.org",
    fromName: "Alex Hillman",
    text: "ping",
    to: ["joel@example.com"],
    attachmentCount: 0,
    isInbound: true,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function memoryNotifyDedupe() {
  const claimed = new Set<string>();
  return {
    claim: async (messageIds: string[]) => {
      const won = messageIds.filter((id) => !claimed.has(id));
      for (const id of won) claimed.add(id);
      return won;
    },
    peek: () => [...claimed],
  };
}

function memoryWatermark(initial: number | null = null) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next: number) => {
      value = next;
    },
    peek: () => value,
  };
}

describe("front reader pure seam", () => {
  test("toTimestampMs accepts seconds and millis", () => {
    expect(toTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTimestampMs("1700000000")).toBe(1_700_000_000_000);
  });

  test("resolvePollWindow bounds first run and reports skipped history", () => {
    const nowMs = 1_800_000_000_000;
    const window = resolvePollWindow({ nowMs, watermarkMs: null });

    expect(window.lookbackBounded).toBe(true);
    expect(window.afterMs).toBe(nowMs - FRONT_READER_MAX_LOOKBACK_MS);
    expect(window.skippedBeforeMs).toBe(nowMs - FRONT_READER_MAX_LOOKBACK_MS);
    expect(window.watermarkBeforeMs).toBeNull();
  });

  test("resolvePollWindow applies deliberate overlap on later runs", () => {
    const nowMs = 1_800_000_000_000;
    const watermarkMs = nowMs - 60_000;
    const window = resolvePollWindow({ nowMs, watermarkMs });

    expect(window.lookbackBounded).toBe(false);
    expect(window.afterMs).toBe(watermarkMs - FRONT_READER_OVERLAP_MS);
    expect(window.skippedBeforeMs).toBeNull();
  });

  test("advanceWatermark only moves forward", () => {
    expect(advanceWatermark({ previousWatermarkMs: 100, maxEmittedAtMs: 200 })).toBe(200);
    expect(advanceWatermark({ previousWatermarkMs: 300, maxEmittedAtMs: 200 })).toBe(300);
    expect(advanceWatermark({ previousWatermarkMs: 300, maxEmittedAtMs: null })).toBe(300);
    expect(advanceWatermark({ previousWatermarkMs: null, maxEmittedAtMs: 50 })).toBe(50);
  });

  test("missing token fails loudly", () => {
    expect(() => requireFrontApiToken(undefined)).toThrow(NonRetriableError);
    expect(() => requireFrontApiToken("")).toThrow(/FRONT_API_TOKEN missing/);
    expect(() => requireFrontApiToken("   ")).toThrow(/FRONT_API_TOKEN missing/);
    expect(requireFrontApiToken("tok_abc")).toBe("tok_abc");
  });

  test("normalizeFrontMessage uses message created_at for channel timestamp", () => {
    const normalized = normalizeFrontMessage(
      {
        id: "msg_9",
        created_at: 1_700_000_000,
        text: "body",
        is_inbound: true,
        recipients: [{ role: "from", handle: "a@b.com", name: "A" }],
      },
      { id: "cnv_9", subject: "Sub" },
    );

    expect(normalized).toMatchObject({
      messageId: "msg_9",
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_000_000,
      conversationId: "cnv_9",
    });
    expect(buildChannelMessageData(normalized!).timestamp).toBe(1_700_000_000_000);
  });

  test("normalizeFrontConversation reads last_message_at", () => {
    expect(
      normalizeFrontConversation({
        id: "cnv_1",
        subject: "Hi",
        last_message_at: 1_700_000_500,
      }),
    ).toEqual({
      id: "cnv_1",
      subject: "Hi",
      lastMessageAtMs: 1_700_000_500_000,
    });
  });

  test("legacy normalizeFrontEvent still maps created_at for fixtures", () => {
    const normalized = normalizeFrontEvent({
      id: "evt_9",
      type: "inbound",
      emitted_at: 1_700_000_500,
      conversation: { id: "cnv_9", subject: "Sub" },
      target: {
        data: {
          id: "msg_9",
          created_at: 1_700_000_000,
          text: "body",
          recipients: [{ role: "from", handle: "a@b.com", name: "A" }],
        },
      },
    });

    expect(normalized).toMatchObject({
      messageId: "msg_9",
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_500_000,
    });
  });

  test("overlap polls produce identical document ids once timestamp is source-stable", () => {
    const event = fixtureEvent({
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_000_000,
      text: "same body",
    });
    const again = fixtureEvent({
      id: "msg:msg_1_again",
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_000_000,
      text: "same body",
    });

    const first = stableChannelMessageIdentity(event);
    const second = stableChannelMessageIdentity(again);
    expect(buildMessageId(first)).toBe(buildMessageId(second));
    expect(buildMessageId(first)).toBe(shaId(first));

    const receiptTimeIdentity = {
      ...first,
      timestamp: Date.now(),
    };
    expect(buildMessageId(receiptTimeIdentity)).not.toBe(buildMessageId(first));
  });

  test("normalizes Unix seconds without changing Unix milliseconds", () => {
    expect(normalizeChannelTimestamp(1_774_713_412)).toBe(1_774_713_412_000);
    expect(normalizeChannelTimestamp(1_776_652_261_181)).toBe(1_776_652_261_181);
  });

  test("formatFrontHttpError names endpoint and missing scope on 403", () => {
    const error = formatFrontHttpError({
      endpoint: "conversations",
      status: 403,
      detail: '{"_error":{"status":403,"title":"Forbidden","message":"Missing required scopes: [events:*:read]"}}',
    });
    expect(error.message).toMatch(/front conversations 403/);
    expect(error.message).toMatch(/Missing required scopes: \[events:\*:read\]/);
    expect(error.message).not.toMatch(/token|Bearer|secret/i);
  });
});

describe("front reader 429 backoff", () => {
  test("retries retryable statuses then succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({
        _results: [
          {
            id: "cnv_ok",
            subject: "Ok",
            last_message_at: 1_700_000_100,
          },
        ],
        _pagination: {},
      });
    }) as unknown as typeof fetch;

    const page = await fetchFrontConversationsPage({
      token: "test-token",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]?.id).toBe("cnv_ok");
  });

  test("gives up after max retries on persistent 429", async () => {
    const fetchImpl = (async () =>
      new Response("nope", {
        status: 429,
        headers: { "retry-after": "0" },
      })) as unknown as typeof fetch;

    await expect(
      fetchFrontConversationsPage({
        token: "test-token",
        fetchImpl,
        sleep: async () => {},
        notifyDedupe: memoryNotifyDedupe(),
      }),
    ).rejects.toThrow(/front conversations 429/);
  });

  test("403 surfaces endpoint and missing scope, not empty success", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          _error: {
            status: 403,
            title: "Forbidden",
            message: "Missing required scopes: [conversations:read]",
          },
        }),
        { status: 403 },
      )) as unknown as typeof fetch;

    await expect(
      fetchFrontConversationsPage({
        token: "test-token",
        fetchImpl,
        sleep: async () => {},
        notifyDedupe: memoryNotifyDedupe(),
      }),
    ).rejects.toThrow(/front conversations 403.*Missing required scopes: \[conversations:read\]/);
  });

  test("message page 403 names the messages endpoint", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          _error: {
            status: 403,
            title: "Forbidden",
            message: "Missing required scopes: [messages:read]",
          },
        }),
        { status: 403 },
      )) as unknown as typeof fetch;

    await expect(
      fetchFrontConversationMessagesPage({
        token: "test-token",
        conversationId: "cnv_x",
        fetchImpl,
        sleep: async () => {},
        notifyDedupe: memoryNotifyDedupe(),
      }),
    ).rejects.toThrow(/front conversations\/cnv_x\/messages 403.*\[messages:read\]/);
  });
});

describe("fetchFrontMessagesSince bounds", () => {
  test("pages conversations newest-first and stops after watermark window", async () => {
    const afterMs = 1_700_000_000_000;
    let conversationCalls = 0;
    let messageCalls = 0;

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messageCalls += 1;
        const conversationId = url.match(/conversations\/([^/?]+)/)?.[1] ?? "cnv_x";
        return Response.json({
          _results: [
            {
              id: `${conversationId}_msg`,
              created_at: afterMs / 1000 + 10,
              text: "fresh",
              is_inbound: true,
              recipients: [{ role: "from", handle: "a@b.com", name: "A" }],
            },
            {
              id: `${conversationId}_old`,
              created_at: afterMs / 1000 - 100,
              text: "old",
              is_inbound: true,
              recipients: [{ role: "from", handle: "a@b.com", name: "A" }],
            },
          ],
          _pagination: {},
        });
      }

      if (url.includes("/conversations")) {
        conversationCalls += 1;
        if (conversationCalls === 1) {
          return Response.json({
            _results: [
              {
                id: "cnv_new",
                subject: "New",
                last_message_at: afterMs / 1000 + 20,
              },
              {
                id: "cnv_old",
                subject: "Old",
                last_message_at: afterMs / 1000 - 50,
              },
            ],
            _pagination: {
              next: "https://api2.frontapp.com/conversations?limit=100&page_token=page2",
            },
          });
        }

        throw new Error("must not request page 2 after passing watermark floor");
      }

      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchFrontMessagesSince({
      token: "test-token",
      afterMs,
      fetchImpl,
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(conversationCalls).toBe(1);
    expect(messageCalls).toBe(1);
    expect(result.conversationsScanned).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.messageId).toBe("cnv_new_msg");
    expect(result.events[0]?.createdAtMs).toBe(afterMs + 10_000);
    expect(result.truncated).toBe(false);
    expect(result.pagesFetched).toBe(1);
  });

  test("marks truncated when conversation page budget is exhausted", async () => {
    const afterMs = 1_700_000_000_000;
    let conversationCalls = 0;

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return Response.json({ _results: [], _pagination: {} });
      }

      conversationCalls += 1;
      return Response.json({
        _results: [
          {
            id: `cnv_${conversationCalls}`,
            subject: "Still new",
            last_message_at: afterMs / 1000 + conversationCalls,
          },
        ],
        _pagination: {
          next: `https://api2.frontapp.com/conversations?limit=100&page_token=p${conversationCalls}`,
        },
      });
    }) as unknown as typeof fetch;

    const result = await fetchFrontMessagesSince({
      token: "test-token",
      afterMs,
      maxPages: 2,
      fetchImpl,
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.conversationsScanned).toBe(2);
  });
});

describe("runFrontReader", () => {
  test("emits channel messages, advances watermark, and reports bounded first run", async () => {
    const watermark = memoryWatermark(null);
    const sent: Array<Record<string, unknown>> = [];
    const emissions: Array<Record<string, unknown>> = [];
    const nowMs = 1_800_000_000_000;

    const eventA = fixtureEvent({
      id: "msg:msg_a",
      messageId: "msg_a",
      conversationId: "cnv_a",
      emittedAtMs: nowMs - 3_000,
      createdAtMs: nowMs - 3_000,
    });
    const eventB = fixtureEvent({
      id: "msg:msg_b",
      messageId: "msg_b",
      conversationId: "cnv_b",
      emittedAtMs: nowMs - 2_000,
      createdAtMs: nowMs - 2_000,
      from: "alex@indyhall.org",
      fromName: "Alex Hillman",
      text: "second",
    });

    const deps: FrontReaderDependencies = {
      now: () => nowMs,
      getToken: () => "test-token",
      watermark,
      fetchMessages: async () => ({
        events: [eventA, eventB],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 2,
      }),
      send: async (events) => {
        sent.push(...events);
      },
      emit: async (input) => {
        emissions.push(input as Record<string, unknown>);
      },
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    };

    const result = await runFrontReader(deps);

    expect(result.status).toBe("ok");
    expect(result.lookbackBounded).toBe(true);
    expect(result.skippedBeforeMs).toBe(nowMs - FRONT_READER_MAX_LOOKBACK_MS);
    expect(result.messagesEmitted).toBe(2);
    expect(result.conversationsScanned).toBe(2);
    expect(result.watermarkBeforeMs).toBeNull();
    expect(result.watermarkAfterMs).toBe(nowMs - 2_000);
    expect(watermark.peek()).toBe(nowMs - 2_000);

    const channelSent = sent.filter((item) => item.name === "channel/message.received");
    const notifySent = sent.filter((item) => item.name === "front/message.received");

    expect(channelSent).toHaveLength(2);
    expect(channelSent[0]).toMatchObject({
      name: "channel/message.received",
      data: {
        channelType: "email",
        timestamp: eventA.createdAtMs,
        channelId: "cnv_a",
      },
    });

    // Ingest is not notification. Front mail was indexed but never announced
    // from 2026-07-23 to 2026-07-27 because only the channel seam was emitted.
    expect(result.messagesNotified).toBe(2);
    expect(notifySent).toHaveLength(2);
    expect(notifySent[0]).toMatchObject({
      name: "front/message.received",
      data: {
        conversationId: "cnv_a",
        messageId: "msg_a",
        isInbound: true,
        createdAt: eventA.createdAtMs,
      },
    });

    // Overlap re-read of the same Front messages must collapse to one id each.
    const ids = channelSent.map((item) => {
      const data = (item as { data: Parameters<typeof buildMessageId>[0] }).data;
      return buildMessageId(data);
    });
    expect(new Set(ids).size).toBe(2);

    const overlapAgain = await runFrontReader({
      ...deps,
      fetchMessages: async () => ({
        events: [eventA, eventB],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 2,
      }),
    });
    expect(overlapAgain.messagesEmitted).toBe(2);
    // Re-indexing is fine; re-announcing is not. The second poll re-emits both
    // channel messages under identical ids and notifies nobody.
    expect(overlapAgain.messagesNotified).toBe(0);
    const overlapIds = sent
      .filter((item) => item.name === "channel/message.received")
      .slice(2)
      .map((item) => {
        const data = (item as { data: Parameters<typeof buildMessageId>[0] }).data;
        return buildMessageId(data);
      });
    expect(overlapIds).toEqual(ids);

    expect(emissions.some((item) => item.action === "front.reader.poll" && item.success === true)).toBe(true);
  });

  test("dedupes the same Front message id inside one poll", async () => {
    const watermark = memoryWatermark(1_700_000_000_000);
    const sent: Array<Record<string, unknown>> = [];
    const base = fixtureEvent({ messageId: "msg_dup", emittedAtMs: 1_700_000_100_000, createdAtMs: 1_700_000_100_000 });
    const dup = fixtureEvent({
      id: "msg:msg_dup_2",
      messageId: "msg_dup",
      emittedAtMs: 1_700_000_200_000,
      createdAtMs: 1_700_000_200_000,
      text: "ping",
    });

    await runFrontReader({
      now: () => 1_800_000_000_000,
      getToken: () => "test-token",
      watermark,
      fetchMessages: async () => ({
        events: [base, dup],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 1,
      }),
      send: async (events) => {
        sent.push(...events);
      },
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(sent.filter((item) => item.name === "channel/message.received")).toHaveLength(1);
    expect(sent.filter((item) => item.name === "front/message.received")).toHaveLength(1);
    expect(watermark.peek()).toBe(1_700_000_200_000);
  });

  test("notifies each inbound message once across overlapping polls", async () => {
    // The reader re-reads a 5-minute overlap every poll. Without a cross-poll
    // claim, a message near the boundary pings Joel twice.
    const nowMs = 1_800_000_000_000;
    const notifyDedupe = memoryNotifyDedupe();
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const event = fixtureEvent({
      messageId: "msg_overlap",
      emittedAtMs: nowMs - 1_000,
      createdAtMs: nowMs - 1_000,
    });
    const deps: FrontReaderDependencies = {
      now: () => nowMs,
      getToken: () => "test-token",
      watermark: memoryWatermark(nowMs - 60_000),
      fetchMessages: async () => ({
        events: [event],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 1,
      }),
      send: async (events) => {
        sent.push(...(events as Array<{ name: string; data: Record<string, unknown> }>));
      },
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe,
    };

    const first = await runFrontReader(deps);
    const second = await runFrontReader(deps);

    expect(first.messagesNotified).toBe(1);
    expect(second.messagesNotified).toBe(0);
    expect(sent.filter((item) => item.name === "front/message.received")).toHaveLength(1);
    // Indexing stays idempotent-by-id, so it is free to re-emit.
    expect(sent.filter((item) => item.name === "channel/message.received")).toHaveLength(2);
  });

  test("bulk mail is indexed but never announced", async () => {
    // Restoring the old webhook's announce-everything behavior put seven
    // messages, ads included, on Joel's phone inside a minute. Non-VIP mail
    // reaches him through the check/email-triage digest instead.
    const nowMs = 1_800_000_000_000;
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await runFrontReader({
      now: () => nowMs,
      getToken: () => "test-token",
      watermark: memoryWatermark(nowMs - 60_000),
      fetchMessages: async () => ({
        events: [
          fixtureEvent({
            messageId: "msg_ad",
            from: "deals@marketing.example.com",
            fromName: "Big Sale",
            emittedAtMs: nowMs - 1_000,
            createdAtMs: nowMs - 1_000,
          }),
        ],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 1,
      }),
      send: async (events) => {
        sent.push(...(events as Array<{ name: string; data: Record<string, unknown> }>));
      },
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(result.messagesNotified).toBe(0);
    expect(sent.filter((item) => item.name === "front/message.received")).toHaveLength(0);
    expect(sent.filter((item) => item.name === "channel/message.received")).toHaveLength(1);
  });

  test("does not announce our own outbound mail", async () => {
    const nowMs = 1_800_000_000_000;
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await runFrontReader({
      now: () => nowMs,
      getToken: () => "test-token",
      watermark: memoryWatermark(nowMs - 60_000),
      fetchMessages: async () => ({
        events: [
          fixtureEvent({
            messageId: "msg_out",
            type: "outbound",
            isInbound: false,
            emittedAtMs: nowMs - 1_000,
            createdAtMs: nowMs - 1_000,
          }),
        ],
        truncated: false,
        pagesFetched: 1,
        conversationsScanned: 1,
      }),
      send: async (events) => {
        sent.push(...(events as Array<{ name: string; data: Record<string, unknown> }>));
      },
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(result.messagesNotified).toBe(0);
    expect(sent.filter((item) => item.name === "front/message.received")).toHaveLength(0);
    expect(sent.filter((item) => item.name === "channel/message.received")).toHaveLength(1);
  });

  test("reports truncation skip bound without silent drop", async () => {
    const nowMs = 1_800_000_000_000;
    const watermark = memoryWatermark(nowMs - 10 * 60_000);
    const result = await runFrontReader({
      now: () => nowMs,
      getToken: () => "test-token",
      watermark,
      fetchMessages: async () => ({
        events: [
          fixtureEvent({ emittedAtMs: nowMs - 1_000, createdAtMs: nowMs - 2_000 }),
          fixtureEvent({
            id: "msg:msg_older",
            messageId: "msg_older",
            emittedAtMs: nowMs - 5_000,
            createdAtMs: nowMs - 6_000,
          }),
        ],
        truncated: true,
        pagesFetched: 15,
        conversationsScanned: 2,
      }),
      send: async () => ({}),
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    expect(result.truncated).toBe(true);
    expect(result.lookbackBounded).toBe(false);
    expect(result.skippedBeforeMs).toBe(nowMs - 5_000);
    expect(result.watermarkAfterMs).toBe(nowMs - 1_000);
  });

  test("propagates named 403 from fetch layer with telemetry", async () => {
    const emissions: Array<Record<string, unknown>> = [];
    await expect(
      runFrontReader({
        now: () => 1_800_000_000_000,
        getToken: () => "test-token",
        watermark: memoryWatermark(null),
        fetchMessages: async () => {
          throw formatFrontHttpError({
            endpoint: "conversations",
            status: 403,
            detail: 'Missing required scopes: [events:*:read]',
          });
        },
        send: async () => {
          throw new Error("must not send");
        },
        emit: async (input) => {
          emissions.push(input as Record<string, unknown>);
        },
        sleep: async () => {},
        notifyDedupe: memoryNotifyDedupe(),
      }),
    ).rejects.toThrow(/front conversations 403.*Missing required scopes/);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      success: false,
      action: "front.reader.poll",
    });
    expect(String(emissions[0]?.error)).toMatch(/front conversations 403/);
  });

  test("createFrontReaderFunction refuses to start without a token", async () => {
    const { InngestTestEngine } = await import("@inngest/test");
    const fn = createFrontReaderFunction({
      now: () => Date.now(),
      getToken: () => undefined,
      watermark: memoryWatermark(null),
      fetchMessages: async () => {
        throw new Error("must not fetch");
      },
      send: async () => {
        throw new Error("must not send");
      },
      emit: async () => ({}),
      sleep: async () => {},
      notifyDedupe: memoryNotifyDedupe(),
    });

    const execution = await new InngestTestEngine({
      function: fn as any,
      events: [{ name: "front/reader.poll", data: {}, id: "poll-1" } as any],
    }).execute();

    expect(execution.error).toBeDefined();
    expect(
      String((execution.error as { message?: string })?.message ?? execution.error),
    ).toContain("FRONT_API_TOKEN missing");
  });
});
