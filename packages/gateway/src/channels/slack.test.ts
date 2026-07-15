import { describe, expect, test } from "bun:test";
import { __slackTestUtils } from "./slack";

const message = {
  channelId: "C123",
  channelName: "important",
  userId: "U123",
  userName: "Joel",
  text: "fresh Slack signal",
  timestamp: 1_700_000_000,
};

describe("Slack channel Inngest handoff", () => {
  test("posts the bounded channel/message.received envelope", async () => {
    let capturedBody = "";
    let capturedSignal: AbortSignal | null | undefined;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      capturedSignal = init?.signal;
      return new Response('{"ids":["event-1"]}', { status: 200 });
    }) as typeof fetch;

    const status = await __slackTestUtils.postChannelMessageEvent(
      message,
      "http://inngest.test/e/redacted",
      fetchFn,
    );

    expect(status).toBe(200);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(capturedBody)).toEqual({
      name: "channel/message.received",
      data: {
        channelType: "slack",
        channelId: "C123",
        channelName: "important",
        userId: "U123",
        userName: "Joel",
        text: "fresh Slack signal",
        timestamp: 1_700_000_000,
      },
    });
  });

  test("rejects non-2xx responses instead of swallowing them", async () => {
    const fetchFn = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;

    await expect(
      __slackTestUtils.postChannelMessageEvent(
        message,
        "http://inngest.test/e/redacted",
        fetchFn,
      ),
    ).rejects.toThrow("Inngest event API returned HTTP 503");
  });
});
