import { describe, expect, test } from "bun:test";
import {
  createSlackUserWebClient,
  makeSlackDeliveryAdapterWithUserFallback,
  resolveSlackChannelNameWithUserFallback,
  type SlackWebApiClient,
} from "./slack-user-token-fallback";
import type { SdkDeliveryAdapter } from "./transport-slim";

function slackError(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), {
    data: { error: code },
  });
}

function webClient(input: {
  readonly channelName?: string;
  readonly channelError?: string;
  readonly onInfo?: () => void;
  readonly postedTs?: string;
  readonly onPost?: (value: Record<string, unknown>) => void;
}): SlackWebApiClient {
  return {
    conversations: {
      info: async () => {
        input.onInfo?.();
        if (input.channelError) throw slackError(input.channelError);
        return { ok: true, channel: { name: input.channelName } };
      },
    },
    chat: {
      postMessage: async (value) => {
        input.onPost?.(value as unknown as Record<string, unknown>);
        return { ok: true, ts: input.postedTs };
      },
    },
  };
}

describe("Slack user-token visibility fallback", () => {
  test("uses the bot channel name without calling the user client", async () => {
    let userLookups = 0;
    const user = webClient({
      channelName: "lc-wrong-fictional-channel",
      onInfo: () => {
        userLookups += 1;
      },
    });

    expect(await resolveSlackChannelNameWithUserFallback({
      channelId: "C_FICTIONAL",
      botClient: webClient({ channelName: "lc-fictional-launch" }),
      userClient: user,
    })).toBe("lc-fictional-launch");
    expect(userLookups).toBe(0);
  });

  test("builds the user-token client on the Web API without exposing it in payloads", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createSlackUserWebClient(
      "xoxp-fictional-user-token",
      async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        return new Response(JSON.stringify(url.includes("conversations.info?")
          ? { ok: true, channel: { name: "lc-fictional-launch" } }
          : { ok: true, ts: "1785950001.200" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    if (!client) throw new Error("expected fictional user-token client");

    expect(await client.conversations.info({ channel: "C_FICTIONAL" }))
      .toEqual({ channel: { name: "lc-fictional-launch" } });
    expect(await client.chat.postMessage({
      channel: "C_FICTIONAL",
      text: "fictional result",
      thread_ts: "1785950000.100",
    })).toEqual({ ts: "1785950001.200" });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://slack.com/api/conversations.info?channel=C_FICTIONAL",
      "https://slack.com/api/chat.postMessage",
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "POST"]);
    expect(requests.map(({ init }) => init?.body)).toEqual([
      undefined,
      JSON.stringify({
        channel: "C_FICTIONAL",
        text: "fictional result",
        thread_ts: "1785950000.100",
      }),
    ]);
  });

  test.each(["channel_not_found", "not_in_channel"])(
    "resolves a channel name with the user token after bot %s",
    async (code) => {
      const bot = webClient({ channelError: code });
      const user = webClient({ channelName: "lc-fictional-launch" });

      expect(await resolveSlackChannelNameWithUserFallback({
        channelId: "C_FICTIONAL",
        botClient: bot,
        userClient: user,
      })).toBe("lc-fictional-launch");
    },
  );

  test("fails closed when the user token cannot resolve the channel", async () => {
    expect(await resolveSlackChannelNameWithUserFallback({
      channelId: "C_FICTIONAL",
      botClient: webClient({ channelError: "channel_not_found" }),
      userClient: webClient({ channelError: "not_in_channel" }),
    })).toBeUndefined();
  });

  test("fails closed when no user token client exists", async () => {
    expect(await resolveSlackChannelNameWithUserFallback({
      channelId: "C_FICTIONAL",
      botClient: webClient({ channelError: "channel_not_found" }),
      userClient: undefined,
    })).toBeUndefined();
  });

  test("posts to the originating Slack thread after bot membership failure", async () => {
    const posts: Record<string, unknown>[] = [];
    const botAdapter: SdkDeliveryAdapter = {
      openDM: async () => "slack:D_FICTIONAL:",
      postMessage: async () => {
        throw slackError("not_in_channel");
      },
    };
    const adapter = makeSlackDeliveryAdapterWithUserFallback({
      botAdapter,
      userClient: webClient({
        postedTs: "1785950001.200",
        onPost: (value) => posts.push(value),
      }),
    });

    const receipt = await adapter.postMessage(
      "slack:C_FICTIONAL:1785950000.100",
      { markdown: "Threaded **fictional** result" },
    );

    expect(posts).toEqual([{
      channel: "C_FICTIONAL",
      text: "Threaded **fictional** result",
      thread_ts: "1785950000.100",
    }]);
    expect(receipt).toMatchObject({
      id: "1785950001.200",
      threadId: "slack:C_FICTIONAL:1785950000.100",
    });
  });

  test("does not use the user token for non-membership delivery failures", async () => {
    let userPosts = 0;
    const original = slackError("invalid_auth");
    const adapter = makeSlackDeliveryAdapterWithUserFallback({
      botAdapter: {
        openDM: async () => "slack:D_FICTIONAL:",
        postMessage: async () => {
          throw original;
        },
      },
      userClient: webClient({
        postedTs: "1785950001.200",
        onPost: () => {
          userPosts += 1;
        },
      }),
    });

    expect(adapter.postMessage("slack:C_FICTIONAL:1785950000.100", {
      raw: "fictional result",
    })).rejects.toBe(original);
    expect(userPosts).toBe(0);
  });
});
