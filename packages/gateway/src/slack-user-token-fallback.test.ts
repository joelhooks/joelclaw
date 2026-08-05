import { describe, expect, test } from "bun:test";
import {
  createSlackUserWebClient,
  resolveSlackChannelNameWithUserFallback,
  type SlackWebApiClient,
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
}): SlackWebApiClient {
  return {
    conversations: {
      info: async () => {
        input.onInfo?.();
        if (input.channelError) throw slackError(input.channelError);
        return { ok: true, channel: { name: input.channelName } };
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

  test("builds a read-only user-token client for channel resolution", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createSlackUserWebClient(
      "xoxp-fictional-user-token",
      async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        return new Response(JSON.stringify({
          ok: true,
          channel: { name: "lc-fictional-launch" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    if (!client) throw new Error("expected fictional user-token client");

    expect(await client.conversations.info({ channel: "C_FICTIONAL" }))
      .toEqual({ channel: { name: "lc-fictional-launch" } });
    expect("chat" in client).toBe(false);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://slack.com/api/conversations.info?channel=C_FICTIONAL",
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET"]);
    expect(requests.map(({ init }) => init?.body)).toEqual([undefined]);
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

});
