import { createHash } from "node:crypto";

const SLACK_MEMBERSHIP_VISIBILITY_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
]);

export interface SlackWebApiClient {
  readonly conversations: {
    readonly info: (input: {
      readonly channel: string;
    }) => Promise<{
      readonly channel?: {
        readonly name?: string;
        readonly is_member?: boolean;
      };
    }>;
  };
  readonly chat: {
    readonly postMessage: (input: {
      readonly channel: string;
      readonly text: string;
      readonly thread_ts?: string;
      readonly client_msg_id?: string;
    }) => Promise<{
      readonly ts?: string;
      readonly message?: { readonly ts?: string };
    }>;
  };
  readonly reactions: {
    readonly add: (input: {
      readonly channel: string;
      readonly name: string;
      readonly timestamp: string;
    }) => Promise<unknown>;
  };
}

export type SlackWebApiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SlackUserDeliveryAdapter<TMessage> {
  readonly openDM: (userId: string) => Promise<string>;
  readonly postMessage: (
    threadId: string,
    message: TMessage,
  ) => Promise<{
    readonly id: string;
    readonly threadId: string;
    readonly raw?: unknown;
  }>;
}

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
    method: "chat.postMessage" | "conversations.info" | "reactions.add",
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    const url = new URL(`https://slack.com/api/${method}`);
    const request: RequestInit = method === "conversations.info"
      ? {
          method: "GET",
          headers: { authorization: `Bearer ${userToken}` },
        }
      : {
          method: "POST",
          headers: {
            authorization: `Bearer ${userToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        };
    if (method === "conversations.info") {
      for (const [key, value] of Object.entries(body)) url.searchParams.set(key, value);
    }
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
        const result = await call("conversations.info", { channel });
        const channelResult = result.channel;
        if (!channelResult || typeof channelResult !== "object") return {};
        const channelRecord = channelResult as Record<string, unknown>;
        return {
          channel: {
            ...(typeof channelRecord.name === "string"
              ? { name: channelRecord.name }
              : {}),
            ...(typeof channelRecord.is_member === "boolean"
              ? { is_member: channelRecord.is_member }
              : {}),
          },
        };
      },
    },
    chat: {
      postMessage: async ({ channel, text, thread_ts, client_msg_id }) => {
        const result = await call("chat.postMessage", {
          channel,
          text,
          ...(thread_ts ? { thread_ts } : {}),
          ...(client_msg_id ? { client_msg_id } : {}),
        });
        const message = result.message;
        const messageTs = message && typeof message === "object"
          ? (message as Record<string, unknown>).ts
          : undefined;
        return {
          ...(typeof result.ts === "string" ? { ts: result.ts } : {}),
          ...(typeof messageTs === "string" ? { message: { ts: messageTs } } : {}),
        };
      },
    },
    reactions: {
      add: async ({ channel, name, timestamp }) => {
        await call("reactions.add", { channel, name, timestamp });
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

export async function isSlackUserChannelReady(input: {
  readonly channelId: string;
  readonly userClient: SlackWebApiClient | undefined;
}): Promise<boolean> {
  if (!input.userClient) return false;
  return input.userClient.conversations.info({ channel: input.channelId })
    .then(() => true)
    .catch(() => false);
}

/** Stable UUID so Slack can deduplicate retries of the immediate work reply. */
export function slackWorkAcknowledgementId(channelId: string, messageTs: string): string {
  const hash = createHash("sha256")
    .update(`shitrat-work-ack:${channelId}:${messageTs}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export async function acknowledgeSlackWorkRequestAsUser(input: {
  readonly channelId: string;
  readonly messageTs: string;
  readonly reaction: string;
  readonly text: string;
  readonly userClient: SlackWebApiClient;
}): Promise<void> {
  try {
    await input.userClient.reactions.add({
      channel: input.channelId,
      name: input.reaction,
      timestamp: input.messageTs,
    });
  } catch (error) {
    if (readSlackApiErrorCode(error) !== "already_reacted") throw error;
  }

  await input.userClient.chat.postMessage({
    channel: input.channelId,
    text: input.text,
    thread_ts: input.messageTs,
    client_msg_id: slackWorkAcknowledgementId(input.channelId, input.messageTs),
  });
}

function parseSlackThreadId(
  threadId: string,
): { readonly channel: string; readonly threadTs?: string } | undefined {
  const raw = threadId.startsWith("slack:") ? threadId.slice("slack:".length) : threadId;
  const separator = raw.indexOf(":");
  const channel = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const threadTs = separator === -1 ? undefined : nonBlank(raw.slice(separator + 1));
  return channel ? { channel, ...(threadTs ? { threadTs } : {}) } : undefined;
}

function slackText(content: unknown): string | undefined {
  if (typeof content === "string") return nonBlank(content);
  if (!content || typeof content !== "object") return undefined;
  const value = content as Record<string, unknown>;
  if (typeof value.markdown === "string") return nonBlank(value.markdown);
  if (typeof value.raw === "string") return nonBlank(value.raw);
  return undefined;
}

export function makeSlackUserDeliveryAdapter<TMessage>(input: {
  readonly userClient: SlackWebApiClient | undefined;
}): SlackUserDeliveryAdapter<TMessage> | undefined {
  if (!input.userClient) return undefined;
  return {
    openDM: async (userId) => `slack:${userId}:`,
    async postMessage(threadId, content) {
      const target = parseSlackThreadId(threadId);
      const text = slackText(content);
      if (!target || !text) {
        throw new Error("Slack user-token delivery requires a valid thread and text");
      }
      const response = await input.userClient!.chat.postMessage({
        channel: target.channel,
        text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      });
      const messageId = nonBlank(response.ts ?? response.message?.ts);
      if (!messageId) {
        throw new Error("Slack user-token delivery returned no message timestamp");
      }
      return { id: messageId, threadId, raw: response };
    },
  };
}
