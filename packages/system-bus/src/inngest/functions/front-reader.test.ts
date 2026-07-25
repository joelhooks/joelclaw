import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NonRetriableError } from "inngest";
import { buildMessageId } from "./channel-message-ingest";
import {
  advanceWatermark,
  buildChannelMessageData,
  createFrontReaderFunction,
  fetchFrontEventsPage,
  FRONT_READER_MAX_LOOKBACK_MS,
  FRONT_READER_OVERLAP_MS,
  normalizeFrontEvent,
  requireFrontApiToken,
  resolvePollWindow,
  runFrontReader,
  stableChannelMessageIdentity,
  toTimestampMs,
  type FrontEventRecord,
  type FrontReaderDependencies,
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
    id: "evt_1",
    type: "inbound",
    emittedAtMs: 1_700_000_100_000,
    conversationId: "cnv_1",
    subject: "Hello",
    messageId: "msg_1",
    from: "ada@example.com",
    fromName: "Ada",
    text: "ping",
    isInbound: true,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
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

  test("normalizeFrontEvent uses message created_at not emitted_at for channel timestamp", () => {
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
    expect(buildChannelMessageData(normalized!).timestamp).toBe(1_700_000_000_000);
  });

  test("overlap polls produce identical document ids once timestamp is source-stable", () => {
    const event = fixtureEvent({
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_100_000,
      text: "same body",
    });
    const again = fixtureEvent({
      id: "evt_2",
      createdAtMs: 1_700_000_000_000,
      emittedAtMs: 1_700_000_200_000,
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
            id: "evt_ok",
            type: "inbound",
            emitted_at: 1_700_000_100,
            conversation: { id: "cnv_ok", subject: "Ok" },
            target: {
              data: {
                id: "msg_ok",
                created_at: 1_700_000_000,
                text: "hello",
                recipients: [{ role: "from", handle: "a@b.com", name: "A" }],
              },
            },
          },
        ],
        _pagination: {},
      });
    }) as unknown as typeof fetch;

    const page = await fetchFrontEventsPage({
      token: "test-token",
      afterMs: 1_700_000_000_000,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.messageId).toBe("msg_ok");
  });

  test("gives up after max retries on persistent 429", async () => {
    const fetchImpl = (async () =>
      new Response("nope", {
        status: 429,
        headers: { "retry-after": "0" },
      })) as unknown as typeof fetch;

    await expect(
      fetchFrontEventsPage({
        token: "test-token",
        afterMs: 1,
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/front events 429/);
  });
});

describe("runFrontReader", () => {
  test("emits channel messages, advances watermark, and reports bounded first run", async () => {
    const watermark = memoryWatermark(null);
    const sent: Array<Record<string, unknown>> = [];
    const emissions: Array<Record<string, unknown>> = [];
    const nowMs = 1_800_000_000_000;

    const eventA = fixtureEvent({
      id: "evt_a",
      messageId: "msg_a",
      conversationId: "cnv_a",
      emittedAtMs: nowMs - 1_000,
      createdAtMs: nowMs - 3_000,
    });
    const eventB = fixtureEvent({
      id: "evt_b",
      messageId: "msg_b",
      conversationId: "cnv_b",
      emittedAtMs: nowMs - 500,
      createdAtMs: nowMs - 2_000,
      from: "grace@example.com",
      fromName: "Grace",
      text: "second",
    });

    const deps: FrontReaderDependencies = {
      now: () => nowMs,
      getToken: () => "test-token",
      watermark,
      fetchEvents: async () => ({
        events: [eventA, eventB],
        truncated: false,
        pagesFetched: 1,
      }),
      send: async (events) => {
        sent.push(...events);
      },
      emit: async (input) => {
        emissions.push(input as Record<string, unknown>);
      },
      sleep: async () => {},
    };

    const result = await runFrontReader(deps);

    expect(result.status).toBe("ok");
    expect(result.lookbackBounded).toBe(true);
    expect(result.skippedBeforeMs).toBe(nowMs - FRONT_READER_MAX_LOOKBACK_MS);
    expect(result.messagesEmitted).toBe(2);
    expect(result.conversationsScanned).toBe(2);
    expect(result.watermarkBeforeMs).toBeNull();
    expect(result.watermarkAfterMs).toBe(nowMs - 500);
    expect(watermark.peek()).toBe(nowMs - 500);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      name: "channel/message.received",
      data: {
        channelType: "email",
        timestamp: eventA.createdAtMs,
        channelId: "cnv_a",
      },
    });

    // Overlap re-read of the same Front messages must collapse to one id each.
    const ids = sent.map((item) => {
      const data = (item as { data: Parameters<typeof buildMessageId>[0] }).data;
      return buildMessageId(data);
    });
    expect(new Set(ids).size).toBe(2);

    const overlapAgain = await runFrontReader({
      ...deps,
      fetchEvents: async () => ({
        events: [eventA, eventB],
        truncated: false,
        pagesFetched: 1,
      }),
    });
    expect(overlapAgain.messagesEmitted).toBe(2);
    const overlapIds = sent.slice(2).map((item) => {
      const data = (item as { data: Parameters<typeof buildMessageId>[0] }).data;
      return buildMessageId(data);
    });
    expect(overlapIds).toEqual(ids);

    expect(emissions.some((item) => item.action === "front.reader.poll" && item.success === true)).toBe(true);
  });

  test("dedupes the same Front message id inside one poll", async () => {
    const watermark = memoryWatermark(1_700_000_000_000);
    const sent: Array<Record<string, unknown>> = [];
    const base = fixtureEvent({ messageId: "msg_dup", emittedAtMs: 1_700_000_100_000 });
    const dup = fixtureEvent({
      id: "evt_dup_2",
      messageId: "msg_dup",
      emittedAtMs: 1_700_000_200_000,
      text: "ping",
    });

    await runFrontReader({
      now: () => 1_800_000_000_000,
      getToken: () => "test-token",
      watermark,
      fetchEvents: async () => ({ events: [base, dup], truncated: false, pagesFetched: 1 }),
      send: async (events) => {
        sent.push(...events);
      },
      emit: async () => ({}),
      sleep: async () => {},
    });

    expect(sent).toHaveLength(1);
    expect(watermark.peek()).toBe(1_700_000_200_000);
  });

  test("reports truncation skip bound without silent drop", async () => {
    const nowMs = 1_800_000_000_000;
    const watermark = memoryWatermark(nowMs - 10 * 60_000);
    const result = await runFrontReader({
      now: () => nowMs,
      getToken: () => "test-token",
      watermark,
      fetchEvents: async () => ({
        events: [
          fixtureEvent({ emittedAtMs: nowMs - 1_000, createdAtMs: nowMs - 2_000 }),
          fixtureEvent({
            id: "evt_older",
            messageId: "msg_older",
            emittedAtMs: nowMs - 5_000,
            createdAtMs: nowMs - 6_000,
          }),
        ],
        truncated: true,
        pagesFetched: 15,
      }),
      send: async () => ({}),
      emit: async () => ({}),
      sleep: async () => {},
    });

    expect(result.truncated).toBe(true);
    expect(result.lookbackBounded).toBe(false);
    expect(result.skippedBeforeMs).toBe(nowMs - 5_000);
    expect(result.watermarkAfterMs).toBe(nowMs - 1_000);
  });

  test("createFrontReaderFunction refuses to start without a token", async () => {
    const { InngestTestEngine } = await import("@inngest/test");
    const fn = createFrontReaderFunction({
      now: () => Date.now(),
      getToken: () => undefined,
      watermark: memoryWatermark(null),
      fetchEvents: async () => {
        throw new Error("must not fetch");
      },
      send: async () => {
        throw new Error("must not send");
      },
      emit: async () => ({}),
      sleep: async () => {},
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
