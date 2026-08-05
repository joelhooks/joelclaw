import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { InboundEvent } from "@joelclaw/message-contract";

export const SHITRAT_TRIGGER_TOKEN = ":shitrat:" as const;
export const DEFAULT_SLACK_CONTEXTS_PATH = resolve(
  homedir(),
  ".joelclaw/slack-channel-contexts.json",
);

export type SlackChannelContextBinding = {
  readonly repo?: string;
  readonly cwd?: string;
  readonly brainEntry?: string;
  readonly skills?: readonly string[];
  readonly validation?: readonly string[];
};

export type SlackWorkRequest = {
  readonly trigger: "shitrat";
  readonly addressedBy: "emoji" | "mention";
  readonly channelId: string;
  readonly channelName: string;
  readonly messageTs: string;
  readonly threadTs: string;
  readonly replyThreadId: string;
  readonly binding?: SlackChannelContextBinding;
};

type SlackChannelContextsFile = {
  readonly version?: number;
  readonly channels?: Readonly<Record<string, SlackChannelContextBinding>>;
};

export function hasShitRatTrigger(text: string): boolean {
  return text.includes(SHITRAT_TRIGGER_TOKEN);
}

export function isShitRatWorkChannel(channelName: string): boolean {
  const normalized = channelName.trim().toLowerCase().replace(/^#/u, "");
  return normalized.startsWith("lc-") || normalized.startsWith("cc-");
}

export async function loadSlackChannelContextBinding(
  channelName: string,
  path = process.env.SLACK_SHITRAT_CONTEXTS_PATH?.trim()
    || DEFAULT_SLACK_CONTEXTS_PATH,
): Promise<SlackChannelContextBinding | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SlackChannelContextsFile;
    const normalized = channelName.trim().toLowerCase().replace(/^#/u, "");
    return parsed.channels?.[normalized];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function slackThreadId(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function slackThreadTimestamp(
  channelId: string,
  sourceThreadId: string | null | undefined,
): string | undefined {
  if (!sourceThreadId) return undefined;
  const prefix = `slack:${channelId}:`;
  return sourceThreadId.startsWith(prefix)
    ? sourceThreadId.slice(prefix.length)
    : sourceThreadId;
}

export async function resolveSlackWorkRequest(input: {
  readonly event: InboundEvent;
  readonly resolveChannelName: (channelId: string) => Promise<string | undefined>;
  readonly loadBinding?: (channelName: string) => Promise<SlackChannelContextBinding | undefined>;
}): Promise<SlackWorkRequest | undefined> {
  const { event } = input;
  if (event.platform !== "slack" || event.type !== "message") return undefined;
  if (event.actor.isBot === true || event.actor.isSelf) return undefined;
  const tokenTriggered = hasShitRatTrigger(event.text);
  if (!tokenTriggered && !event.isMention) return undefined;

  const channelId = event.platformIds.conversationId;
  if (!channelId || channelId.startsWith("D")) return undefined;
  const channelName = await input.resolveChannelName(channelId);
  if (!channelName || !isShitRatWorkChannel(channelName)) return undefined;

  const messageTs = event.platformIds.messageId
    ?? event.rawAnchors.sourceMessageId
    ?? undefined;
  if (!messageTs) throw new Error("Slack :shitrat: request has no message timestamp");
  const rawThreadTs = slackThreadTimestamp(
    channelId,
    event.rawAnchors.sourceThreadId,
  );
  const threadTs = rawThreadTs && rawThreadTs !== messageTs
    ? rawThreadTs
    : messageTs;
  const binding = await (input.loadBinding ?? loadSlackChannelContextBinding)(channelName);

  return {
    trigger: "shitrat",
    addressedBy: tokenTriggered ? "emoji" : "mention",
    channelId,
    channelName,
    messageTs,
    threadTs,
    replyThreadId: slackThreadId(channelId, threadTs),
    ...(binding ? { binding } : {}),
  };
}
