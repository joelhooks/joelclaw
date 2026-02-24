import { CLI_CAPABILITIES, CLI_FORMATTING_GUIDE } from "./cli";
import { DISCORD_CAPABILITIES, DISCORD_FORMATTING_GUIDE } from "./discord";
import { IMESSAGE_CAPABILITIES, IMESSAGE_FORMATTING_GUIDE } from "./imessage";
import { TELEGRAM_CAPABILITIES, TELEGRAM_FORMATTING_GUIDE } from "./telegram";

export type ChannelPlatform = "discord" | "telegram" | "imessage" | "cli";

export type InjectChannelContextOptions = {
  source: string;
  threadName?: string;
  now?: Date;
};

type PlatformContext = {
  channel: ChannelPlatform;
  capabilities: string;
  guide: string;
};

const PLATFORM_CONTEXT: Record<ChannelPlatform, PlatformContext> = {
  discord: {
    channel: "discord",
    capabilities: DISCORD_CAPABILITIES,
    guide: DISCORD_FORMATTING_GUIDE,
  },
  telegram: {
    channel: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,
    guide: TELEGRAM_FORMATTING_GUIDE,
  },
  imessage: {
    channel: "imessage",
    capabilities: IMESSAGE_CAPABILITIES,
    guide: IMESSAGE_FORMATTING_GUIDE,
  },
  cli: {
    channel: "cli",
    capabilities: CLI_CAPABILITIES,
    guide: CLI_FORMATTING_GUIDE,
  },
};

function resolvePlatform(source: string): ChannelPlatform | undefined {
  if (source.startsWith("discord:")) return "discord";
  if (source.startsWith("telegram:")) return "telegram";
  if (source.startsWith("imessage:")) return "imessage";
  if (source === "cli" || source === "tui" || source.startsWith("cli:")) return "cli";
  return undefined;
}

function formatDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  }).format(now);
}

export function injectChannelContext(message: string, options: InjectChannelContextOptions): string {
  const text = message.trim();
  if (!text) return message;

  // Guard against duplicate injection for retries/replays.
  if (text.startsWith("---\nChannel:")) {
    return message;
  }

  const platform = resolvePlatform(options.source);
  if (!platform) {
    return message;
  }

  const context = PLATFORM_CONTEXT[platform];
  const now = options.now ?? new Date();

  const channelLabel = platform === "discord" && options.threadName
    ? `discord (thread: #${options.threadName})`
    : platform;

  const header = [
    "---",
    `Channel: ${channelLabel}`,
    `Date: ${formatDate(now)}`,
    `Platform capabilities: ${context.capabilities}`,
    "Formatting guide:",
    context.guide,
    "---",
    "",
  ].join("\n");

  return `${header}${message}`;
}

export {
  CLI_CAPABILITIES,
  CLI_FORMATTING_GUIDE,
  DISCORD_CAPABILITIES,
  DISCORD_FORMATTING_GUIDE,
  IMESSAGE_CAPABILITIES,
  IMESSAGE_FORMATTING_GUIDE,
  TELEGRAM_CAPABILITIES,
  TELEGRAM_FORMATTING_GUIDE,
};
