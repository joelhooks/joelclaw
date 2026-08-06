import { describe, expect, test } from "bun:test";
import {
  acknowledgeSlackWorkRequestAsUser,
  createSlackUserWebClient,
  isSlackUserChannelReady,
  makeSlackUserDeliveryAdapter,
  resolveSlackChannelNameWithUserFallback,
  type SlackWebApiClient,
  slackWorkAcknowledgementId,
} from "./slack-user-token-fallback";

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
  readonly onReaction?: (value: Record<string, unknown>) => void;
  readonly reactionError?: string;
}): SlackWebApiClient {
  return {
    conversations: {
      info: async () => {
        input.onInfo?.();
        if (input.channelError) throw slackError(input.channelError);
        return { channel: { name: input.channelName } };
      },
    },
    chat: {
      postMessage: async (value) => {
        input.onPost?.(value as unknown as Record<string, unknown>);
        return { ts: input.postedTs };
      },
    },
    reactions: {
      add: async (value) => {
        input.onReaction?.(value as unknown as Record<string, unknown>);
        if (input.reactionError) throw slackError(input.reactionError);
      },
    },
  };
}

describe("Slack personal-token ShitRat delivery", () => {
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

  test("builds the user client without exposing its token", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createSlackUserWebClient(
      "xoxp-fictional-user-token",
      async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        return new Response(JSON.stringify(
          url.includes("conversations.info?")
            ? { ok: true, channel: { name: "lc-fictional-launch" } }
            : url.endsWith("reactions.add")
              ? { ok: true }
              : { ok: true, ts: "1785950001.200" },
        ), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    if (!client) throw new Error("expected fictional user-token client");

    await client.conversations.info({ channel: "C_FICTIONAL" });
    await client.chat.postMessage({
      channel: "C_FICTIONAL",
      text: "fictional result",
      thread_ts: "1785950000.100",
    });
    await client.reactions.add({
      channel: "C_FICTIONAL",
      name: "shitrat",
      timestamp: "1785950000.100",
    });

    expect(requests.map(({ url }) => url).every((url) =>
      !url.includes("xoxp-fictional-user-token"))).toBe(true);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "POST", "POST"]);
  });

  test.each(["channel_not_found", "not_in_channel"])(
    "resolves a channel name with the user token after bot %s",
    async (code) => {
      expect(await resolveSlackChannelNameWithUserFallback({
        channelId: "C_FICTIONAL",
        botClient: webClient({ channelError: code }),
        userClient: webClient({ channelName: "lc-fictional-launch" }),
      })).toBe("lc-fictional-launch");
    },
  );

  test("requires personal-token channel visibility", async () => {
    expect(await isSlackUserChannelReady({
      channelId: "C_FICTIONAL",
      userClient: webClient({ channelName: "lc-fictional-launch" }),
    })).toBe(true);
    expect(await isSlackUserChannelReady({
      channelId: "C_FICTIONAL",
      userClient: webClient({ channelError: "channel_not_found" }),
    })).toBe(false);
  });

  test("acknowledges work with one deduplicated threaded status", async () => {
    const posts: Record<string, unknown>[] = [];
    const reactions: Record<string, unknown>[] = [];
    const client = webClient({
      reactionError: "already_reacted",
      onPost: (value) => posts.push(value),
      onReaction: (value) => reactions.push(value),
    });

    await acknowledgeSlackWorkRequestAsUser({
      channelId: "C_FICTIONAL",
      messageTs: "1785950000.100",
      reaction: "shitrat",
      text: "Working on it. 🐀",
      userClient: client,
    });

    expect(reactions).toEqual([{
      channel: "C_FICTIONAL",
      name: "shitrat",
      timestamp: "1785950000.100",
    }]);
    expect(posts).toEqual([{
      channel: "C_FICTIONAL",
      text: "Working on it. 🐀",
      thread_ts: "1785950000.100",
      client_msg_id: slackWorkAcknowledgementId(
        "C_FICTIONAL",
        "1785950000.100",
      ),
    }]);
    expect(slackWorkAcknowledgementId(
      "C_FICTIONAL",
      "1785950000.100",
    )).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test("posts a ShitRat result to the exact Slack thread as Joel", async () => {
    const posts: Record<string, unknown>[] = [];
    const adapter = makeSlackUserDeliveryAdapter({
      userClient: webClient({
        postedTs: "1785950001.200",
        onPost: (value) => posts.push(value),
      }),
    });
    if (!adapter) throw new Error("expected user delivery adapter");

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
});
