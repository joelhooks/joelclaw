import { execFileSync } from "node:child_process";
import {
  createDiscordAdapter,
  type DiscordAdapter,
} from "@chat-adapter/discord";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createTelegramAdapter,
  type TelegramAdapter,
} from "@chat-adapter/telegram";
import { type Adapter, Chat, type Logger } from "chat";

export const CHAT_SDK_VERSION = "4.34.0" as const;
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
  "message_reaction_count",
] as const;

const DISCORD_LISTENER_DURATION_MS = 150_000;

type SecretName =
  | "telegram_bot_token"
  | "slack_bot_token"
  | "slack_app_token"
  | "discord_bot_token"
  | "discord_application_id"
  | "discord_public_key";

export interface SecretResolver {
  readonly lease: (name: SecretName) => string | undefined;
}

export interface ChatSdkRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly secrets?: SecretResolver;
  readonly telegramEnabled?: boolean;
  readonly slackEnabled?: boolean;
  readonly discordEnabled?: boolean;
  readonly logger?: Logger;
}

export interface ChatSdkAdapters {
  readonly telegram?: TelegramAdapter;
  readonly slack?: SlackAdapter;
  readonly discord?: DiscordAdapter;
}

export interface ChatSdkRuntime {
  readonly chat: Chat<Record<string, Adapter>>;
  readonly adapters: ChatSdkAdapters;
  readonly configured: Readonly<Record<"telegram" | "slack" | "discord", boolean>>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

const SENSITIVE_LOG_KEY = /token|secret|key|signature|authorization|content|text|message|body|payload|raw/iu;

function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_LOG_KEY.test(key) ? "[redacted]" : redactMetadata(item, depth + 1),
  ]));
}

const logger: Logger = {
  debug: () => undefined,
  info: (message, metadata) => console.info(`[chat-sdk] ${message}`, redactMetadata(metadata)),
  warn: (message, metadata) => console.warn(`[chat-sdk] ${message}`, redactMetadata(metadata)),
  error: (message, metadata) => console.error(`[chat-sdk] ${message}`, redactMetadata(metadata)),
  child: () => logger,
};

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const daemonSecretResolver: SecretResolver = {
  lease(name): string | undefined {
    try {
      return nonBlank(execFileSync("secrets", ["lease", name, "--ttl", "4h"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }));
    } catch {
      return undefined;
    }
  },
};

function resolveCredential(
  env: NodeJS.ProcessEnv,
  envName: string,
  secretName: SecretName,
  secrets: SecretResolver,
): string | undefined {
  return nonBlank(env[envName]) ?? secrets.lease(secretName);
}

export function createChatSdkRuntime(options: ChatSdkRuntimeOptions = {}): ChatSdkRuntime {
  const env = options.env ?? process.env;
  const secrets = options.secrets ?? daemonSecretResolver;
  const runtimeLogger = options.logger ?? logger;
  const telegramEnabled = options.telegramEnabled ?? true;
  const slackEnabled = options.slackEnabled ?? true;
  const telegramToken = telegramEnabled
    ? resolveCredential(env, "TELEGRAM_BOT_TOKEN", "telegram_bot_token", secrets)
    : undefined;
  const slackBotToken = slackEnabled
    ? resolveCredential(env, "SLACK_BOT_TOKEN", "slack_bot_token", secrets)
    : undefined;
  const slackAppToken = slackEnabled
    ? resolveCredential(env, "SLACK_APP_TOKEN", "slack_app_token", secrets)
    : undefined;

  // Discord remains disabled when its channel env is blank. Steering can pass
  // discordEnabled only after the channel is deliberately enabled.
  const discordEnabled = options.discordEnabled ?? Boolean(nonBlank(env.DISCORD_BOT_TOKEN));
  const discordBotToken = discordEnabled
    ? resolveCredential(env, "DISCORD_BOT_TOKEN", "discord_bot_token", secrets)
    : undefined;
  const discordApplicationId = discordEnabled
    ? resolveCredential(env, "DISCORD_APPLICATION_ID", "discord_application_id", secrets)
    : undefined;
  const discordPublicKey = discordEnabled
    ? resolveCredential(env, "DISCORD_PUBLIC_KEY", "discord_public_key", secrets)
    : undefined;

  const adapters: ChatSdkAdapters = {
    ...(telegramToken
      ? {
          telegram: createTelegramAdapter({
            botToken: telegramToken,
            mode: "polling",
            longPolling: { allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES] },
            logger: runtimeLogger.child("telegram"),
          }),
        }
      : {}),
    ...(slackBotToken && slackAppToken
      ? {
          slack: createSlackAdapter({
            botToken: slackBotToken,
            appToken: slackAppToken,
            mode: "socket",
            logger: runtimeLogger.child("slack"),
          }),
        }
      : {}),
    ...(discordBotToken && discordApplicationId && discordPublicKey
      ? {
          discord: createDiscordAdapter({
            botToken: discordBotToken,
            applicationId: discordApplicationId,
            publicKey: discordPublicKey,
            logger: runtimeLogger.child("discord"),
          }),
        }
      : {}),
  };

  const chatAdapters: Record<string, Adapter> = {};
  if (adapters.telegram) chatAdapters.telegram = adapters.telegram;
  if (adapters.slack) chatAdapters.slack = adapters.slack;
  if (adapters.discord) chatAdapters.discord = adapters.discord;

  const chat = new Chat<Record<string, Adapter>>({
    userName: nonBlank(env.CHAT_SDK_BOT_USERNAME) ?? "joelclaw",
    adapters: chatAdapters,
    state: createMemoryState(),
    concurrency: "concurrent",
    logger: runtimeLogger,
  });

  let started = false;
  let initialized = false;
  let discordAbort: AbortController | undefined;
  let discordLoop: Promise<void> | undefined;

  const runDiscordLoop = async (adapter: DiscordAdapter, signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      let listener: Promise<unknown> | undefined;
      const response = await adapter.startGatewayListener(
        {
          waitUntil(task) {
            listener = Promise.resolve(task);
          },
        },
        DISCORD_LISTENER_DURATION_MS,
        signal,
      );
      if (!response.ok) {
        throw new Error(`Discord Gateway listener failed with HTTP ${response.status}`);
      }
      await listener;
    }
  };

  return {
    chat,
    adapters,
    configured: {
      telegram: Boolean(adapters.telegram),
      slack: Boolean(adapters.slack),
      discord: Boolean(adapters.discord),
    },
    async start(): Promise<void> {
      if (started) return;
      try {
        await chat.initialize();
        initialized = true;
        started = true;
        if (adapters.discord) {
          discordAbort = new AbortController();
          discordLoop = runDiscordLoop(adapters.discord, discordAbort.signal);
          void discordLoop.catch((error: unknown) => {
            if (!discordAbort?.signal.aborted) {
              runtimeLogger.error("Discord listener stopped unexpectedly", { error: String(error) });
            }
          });
        }
      } catch (error) {
        // initialize() can start Telegram before a later adapter fails. Cleanup
        // failure is ownership uncertainty, not a warning: keep initialized=true
        // so stop() retries and let handover refuse to restart legacy if proof
        // still cannot be obtained.
        const cleanupErrors: unknown[] = [];
        try {
          await adapters.telegram?.stopPolling();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await chat.shutdown();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        started = false;
        initialized = cleanupErrors.length > 0;
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Chat SDK startup failed and partial transport cleanup is unproven",
          );
        }
        throw error;
      }
    },
    async stop(): Promise<void> {
      if (!started && !initialized) return;
      discordAbort?.abort();
      await discordLoop?.catch(() => undefined);
      await adapters.telegram?.stopPolling();
      await chat.shutdown();
      started = false;
      initialized = false;
      discordAbort = undefined;
      discordLoop = undefined;
    },
  };
}

let singleton: ChatSdkRuntime | undefined;

export function getChatSdkRuntime(
  options?: ChatSdkRuntimeOptions,
): ChatSdkRuntime {
  singleton ??= createChatSdkRuntime(options);
  return singleton;
}

/**
 * Exported daemon wiring seam. Starting a second Telegram poller or Slack
 * socket is forbidden, so steering must prove legacy transport ownership was
 * transferred before activation.
 */
export async function startChatSdkRuntime(input: {
  readonly legacyTransportsStopped: true;
}): Promise<ChatSdkRuntime> {
  if (input.legacyTransportsStopped !== true) {
    throw new Error("Chat SDK transport activation requires legacy transport shutdown proof");
  }
  const runtime = getChatSdkRuntime();
  await runtime.start();
  return runtime;
}
