const SLACK_MEMBERSHIP_VISIBILITY_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
]);

export interface SlackWebApiClient {
  readonly conversations: {
    readonly info: (input: {
      readonly channel: string;
    }) => Promise<{ readonly channel?: { readonly name?: string } }>;
  };
}

export type SlackWebApiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readSlackApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const value = error as Record<string, unknown>;
  const data = value.data;
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).error;
    if (typeof code === "string" && code.trim()) return code.trim().toLowerCase();
  }

  const message = typeof value.message === "string" ? value.message : String(error);
  const match = message.match(/:\s*([a-z_]+)\s*$/i);
  if (match?.[1]) return match[1].toLowerCase();

  return typeof value.code === "string" && value.code.trim()
    ? value.code.trim().toLowerCase()
    : undefined;
}

export function isSlackMembershipVisibilityError(error: unknown): boolean {
  const code = readSlackApiErrorCode(error);
  return Boolean(code && SLACK_MEMBERSHIP_VISIBILITY_ERRORS.has(code));
}

export function createSlackUserWebClient(
  token = process.env.SLACK_USER_TOKEN,
  fetchApi: SlackWebApiFetch = fetch,
): SlackWebApiClient | undefined {
  const userToken = nonBlank(token);
  if (!userToken) return undefined;

  const call = async (
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    const url = new URL("https://slack.com/api/conversations.info");
    const request: RequestInit = {
      method: "GET",
      headers: { authorization: `Bearer ${userToken}` },
    };
    for (const [key, value] of Object.entries(body)) url.searchParams.set(key, value);
    const response = await fetchApi(url, request);
    if (!response.ok) {
      throw new Error(`Slack Web API HTTP ${response.status}`);
    }
    const value = await response.json();
    if (!value || typeof value !== "object") {
      throw new Error("Slack Web API returned an invalid response");
    }
    const result = value as Record<string, unknown>;
    if (result.ok === false) {
      const code = typeof result.error === "string" ? result.error : "unknown_error";
      throw Object.assign(new Error(`Slack Web API error: ${code}`), {
        data: { error: code },
      });
    }
    return result;
  };

  return {
    conversations: {
      info: async ({ channel }) => {
        const result = await call({ channel });
        const channelResult = result.channel;
        if (!channelResult || typeof channelResult !== "object") return {};
        const name = (channelResult as Record<string, unknown>).name;
        return {
          channel: { ...(typeof name === "string" ? { name } : {}) },
        };
      },
    },
  };
}

export async function resolveSlackChannelNameWithUserFallback(input: {
  readonly channelId: string;
  readonly botClient: SlackWebApiClient | undefined;
  readonly userClient: SlackWebApiClient | undefined;
}): Promise<string | undefined> {
  if (!input.botClient) return undefined;

  try {
    const response = await input.botClient.conversations.info({
      channel: input.channelId,
    });
    return nonBlank(response.channel?.name);
  } catch (error) {
    if (!isSlackMembershipVisibilityError(error) || !input.userClient) {
      return undefined;
    }
  }

  try {
    const response = await input.userClient.conversations.info({
      channel: input.channelId,
    });
    return nonBlank(response.channel?.name);
  } catch {
    return undefined;
  }
}
