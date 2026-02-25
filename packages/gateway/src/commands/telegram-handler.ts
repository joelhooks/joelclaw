import { getModel, completeSimple } from "@mariozechner/pi-ai";
import type { Bot, Context } from "grammy";
import type Redis from "ioredis";
import { enrichPromptWithVaultContext } from "@joelclaw/vault-reader";
import { injectChannelContext } from "../formatting";
import { BUILTIN_COMMANDS } from "./builtins";
import {
  ALLOWED_MODELS,
  ALLOWED_THINKING_LEVELS,
  loadGatewayConfig,
  saveGatewayConfig,
} from "./config";
import {
  defineChatCommand,
  getAllCommands,
  getCommand,
  getCommands,
  registerCommands,
  type CommandArgChoice,
  type CommandArgDefinition,
  type CommandDefinition,
  type ParsedArgs,
} from "./registry";
import { createSkillsMenuCommand, loadSkillCommands } from "./skills";
import { registerMcqAdapter } from "./mcq-adapter";
import { BUILD_COMMAND, registerWorktreeCallbackHandler } from "./worktree";

type EnqueueFn = (
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
) => void | Promise<void>;

export type GatewayStatusSnapshot = {
  modelName: string;
  thinkingLevel: string;
  verbose: boolean;
  uptimeMs: number;
  queueDepth: number;
  lastHeartbeatAt?: number;
};

type CommandHandlerInit = {
  bot: Bot;
  enqueue: EnqueueFn;
  redis?: Redis;
  chatId: number;
  getStatusSnapshot: () => Promise<GatewayStatusSnapshot> | GatewayStatusSnapshot;
};

const PINNED_STATUS_KEY = "joelclaw:gateway:pinned_message_id";
const CALLBACK_PREFIX = "cmd:";
const MAX_LIGHT_RESPONSE_CHARS = 3900;

const LIGHT_MODEL_MAP: Record<string, { provider: string; id: string }> = {
  haiku: { provider: "anthropic", id: "claude-haiku-4-5" },
  sonnet: { provider: "anthropic", id: "claude-sonnet-4-5" },
};

let pinnedStatusContext: CommandHandlerInit | undefined;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function splitArgs(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter(Boolean);
}

function parseArgs(rawArgs: string, argDefs: CommandArgDefinition[] | undefined): ParsedArgs {
  const positional = splitArgs(rawArgs);
  const values: Record<string, string | number> = {};

  if (!argDefs || argDefs.length === 0) {
    return { raw: rawArgs.trim(), positional, values };
  }

  let index = 0;
  for (const arg of argDefs) {
    if (arg.captureRemaining) {
      const remaining = positional.slice(index).join(" ");
      if (remaining) {
        values[arg.name] = arg.type === "number" ? Number(remaining) : remaining;
      }
      index = positional.length;
      continue;
    }

    const token = positional[index];
    if (token === undefined) break;

    if (arg.type === "number") {
      const parsed = Number(token);
      if (!Number.isNaN(parsed)) values[arg.name] = parsed;
    } else {
      values[arg.name] = token;
    }

    index += 1;
  }

  return { raw: rawArgs.trim(), positional, values };
}

function commandTextFromMessage(text: string, commandName: string): string {
  const regex = new RegExp(`^\\/${commandName}(?:@[\\w_]+)?\\s*`, "i");
  return text.replace(regex, "");
}

function normalizeChoice(choice: CommandArgChoice): { value: string; label: string } {
  if (typeof choice === "string") {
    return { value: choice, label: choice };
  }
  return { value: choice.value, label: choice.label };
}

function pickMenuArg(command: CommandDefinition): CommandArgDefinition | undefined {
  if (!command.args || command.args.length === 0) return undefined;

  const menu = command.argsMenu;
  if (!menu) return undefined;
  if (menu === "auto") return command.args[0];

  return command.args.find((arg) => arg.name === menu.arg);
}

async function sendHtml(bot: Bot, chatId: number, html: string): Promise<void> {
  await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
}

async function renderArgsMenu(bot: Bot, chatId: number, command: CommandDefinition): Promise<boolean> {
  const menuArg = pickMenuArg(command);
  if (!menuArg?.choices || menuArg.choices.length === 0) return false;

  const title = command.argsMenu !== "auto" && command.argsMenu?.title
    ? command.argsMenu.title
    : `Choose ${menuArg.name}:`;

  const choices = menuArg.choices.map(normalizeChoice);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < choices.length; i += 2) {
    const rowChoices = choices.slice(i, i + 2);
    const row = rowChoices.map((choice) => ({
      text: choice.label,
      callback_data: `${CALLBACK_PREFIX}${command.nativeName}:${choice.value}`,
    }));
    rows.push(row);
  }

  await bot.api.sendMessage(chatId, escapeHtml(title), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });

  return true;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatLastHeartbeat(lastHeartbeatAt?: number): string {
  if (!lastHeartbeatAt) return "unknown";
  const ageMs = Date.now() - lastHeartbeatAt;
  if (ageMs < 0) return "just now";
  return `${formatDuration(ageMs)} ago`;
}

function buildPinnedStatusHtml(snapshot: GatewayStatusSnapshot): string {
  return [
    "🤖 <b>joelclaw gateway</b>",
    `├ Model: <code>${escapeHtml(snapshot.modelName)}</code> · Thinking: <code>${escapeHtml(snapshot.thinkingLevel)}</code>`,
    `├ Verbose: <code>${snapshot.verbose ? "on" : "off"}</code> · Uptime: <code>${formatDuration(snapshot.uptimeMs)}</code>`,
    `├ Queue: <code>${snapshot.queueDepth}</code>`,
    `└ Last heartbeat: <code>${escapeHtml(formatLastHeartbeat(snapshot.lastHeartbeatAt))}</code>`,
  ].join("\n");
}

function truncateForTelegram(text: string, maxChars = MAX_LIGHT_RESPONSE_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function getStringArg(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return `${value}`;
  return undefined;
}

function createConfigCommands(redis: Redis | undefined): CommandDefinition[] {
  return [
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "Set gateway model (applies next restart)",
      category: "options",
      execution: "direct",
      args: [
        {
          name: "model",
          description: "Configured model",
          type: "string",
          required: true,
          choices: [...ALLOWED_MODELS],
        },
      ],
      argsMenu: { arg: "model", title: "Choose configured model:" },
      directHandler: async (parsed) => {
        const selected = (getStringArg(parsed, "model") ?? parsed.positional[0])?.trim();
        if (!selected) {
          return "<b>Missing argument</b>\nUse <code>/model &lt;name&gt;</code>.";
        }
        if (!ALLOWED_MODELS.includes(selected as (typeof ALLOWED_MODELS)[number])) {
          return `<b>Invalid model</b>\nAllowed: <code>${ALLOWED_MODELS.join(", ")}</code>`;
        }
        if (!redis) {
          return "<b>Redis unavailable</b>\nCould not persist model setting.";
        }

        const config = await loadGatewayConfig(redis);
        const next = { ...config, model: selected as (typeof ALLOWED_MODELS)[number] };
        await saveGatewayConfig(redis, next);
        await updatePinnedStatus();

        // Send confirmation, then exit so launchd respawns with new model
        setTimeout(() => {
          console.log(`[gateway] Model changed to ${next.model}, exiting for launchd respawn...`);
          process.exit(0);
        }, 1500);

        return `<b>Model set to</b> <code>${escapeHtml(next.model)}</code>\nRestarting now…`;
      },
    }),
    defineChatCommand({
      key: "thinking",
      nativeName: "thinking",
      description: "Set gateway thinking level (applies next restart)",
      category: "options",
      execution: "direct",
      args: [
        {
          name: "level",
          description: "Thinking level",
          type: "string",
          required: true,
          choices: [...ALLOWED_THINKING_LEVELS],
        },
      ],
      argsMenu: { arg: "level", title: "Choose thinking level:" },
      directHandler: async (parsed) => {
        const selected = (getStringArg(parsed, "level") ?? parsed.positional[0])?.trim().toLowerCase();
        if (!selected) {
          return "<b>Missing argument</b>\nUse <code>/thinking &lt;level&gt;</code>.";
        }
        if (!ALLOWED_THINKING_LEVELS.includes(selected as (typeof ALLOWED_THINKING_LEVELS)[number])) {
          return `<b>Invalid thinking level</b>\nAllowed: <code>${ALLOWED_THINKING_LEVELS.join(", ")}</code>`;
        }
        if (!redis) {
          return "<b>Redis unavailable</b>\nCould not persist thinking setting.";
        }

        const config = await loadGatewayConfig(redis);
        const next = { ...config, thinkingLevel: selected as (typeof ALLOWED_THINKING_LEVELS)[number] };
        await saveGatewayConfig(redis, next);
        await updatePinnedStatus();

        return [
          `<b>Thinking configured</b>: <code>${escapeHtml(next.thinkingLevel)}</code>`,
          "Thinking level will apply on next restart.",
        ].join("\n");
      },
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: "Toggle verbose mode",
      category: "options",
      execution: "direct",
      directHandler: async () => {
        if (!redis) {
          return "<b>Redis unavailable</b>\nCould not persist verbose setting.";
        }

        const config = await loadGatewayConfig(redis);
        const next = { ...config, verbose: !config.verbose };
        await saveGatewayConfig(redis, next);
        await updatePinnedStatus();

        return `<b>Verbose mode</b>: <code>${next.verbose ? "ON" : "OFF"}</code>`;
      },
    }),
  ];
}

async function getPinnedMessageId(redis: Redis | undefined): Promise<number | undefined> {
  if (!redis) return undefined;
  const raw = await redis.get(PINNED_STATUS_KEY);
  if (!raw) return undefined;
  const id = Number.parseInt(raw, 10);
  return Number.isNaN(id) ? undefined : id;
}

async function setPinnedMessageId(redis: Redis | undefined, messageId: number): Promise<void> {
  if (!redis) return;
  await redis.set(PINNED_STATUS_KEY, String(messageId));
}

async function resolvePinnedMessageId(ctx: CommandHandlerInit): Promise<number> {
  const stored = await getPinnedMessageId(ctx.redis);
  if (stored) return stored;

  const chat = await ctx.bot.api.getChat(ctx.chatId);
  const pinnedMessageId = "pinned_message" in chat ? chat.pinned_message?.message_id : undefined;

  if (pinnedMessageId) {
    await setPinnedMessageId(ctx.redis, pinnedMessageId);
    return pinnedMessageId;
  }

  const snapshot = await ctx.getStatusSnapshot();
  const message = await ctx.bot.api.sendMessage(ctx.chatId, buildPinnedStatusHtml(snapshot), {
    parse_mode: "HTML",
  });
  await ctx.bot.api.pinChatMessage(ctx.chatId, message.message_id, {
    disable_notification: true,
  });
  await setPinnedMessageId(ctx.redis, message.message_id);
  return message.message_id;
}

export async function updatePinnedStatus(): Promise<void> {
  if (!pinnedStatusContext) return;

  const snapshot = await pinnedStatusContext.getStatusSnapshot();
  const html = buildPinnedStatusHtml(snapshot);
  const messageId = await resolvePinnedMessageId(pinnedStatusContext);

  try {
    await pinnedStatusContext.bot.api.editMessageText(
      pinnedStatusContext.chatId,
      messageId,
      html,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    const message = String(error);
    if (message.includes("message is not modified")) return;

    if (pinnedStatusContext.redis) {
      await pinnedStatusContext.redis.del(PINNED_STATUS_KEY);
    }

    const newMessageId = await resolvePinnedMessageId(pinnedStatusContext);
    await pinnedStatusContext.bot.api.editMessageText(
      pinnedStatusContext.chatId,
      newMessageId,
      html,
      { parse_mode: "HTML" },
    );
  }
}

async function executeCommand(
  ctx: Context,
  command: CommandDefinition,
  rawArgs: string,
  init: CommandHandlerInit,
  options?: { fromArgsMenu?: boolean; telegramMessageId?: number },
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (!rawArgs.trim() && command.argsMenu) {
    const rendered = await renderArgsMenu(init.bot, chatId, command);
    if (rendered) return;
  }

  const parsed = parseArgs(rawArgs, command.args);

  if (command.execution === "direct" && command.directHandler) {
    const result = await command.directHandler(parsed);
    if (typeof result === "string") {
      await sendHtml(init.bot, chatId, result);
      return;
    }

    await init.bot.api.sendMessage(chatId, result.html, {
      parse_mode: "HTML",
      reply_markup: result.replyMarkup,
    });
    return;
  }

  if (command.execution === "light") {
    const modelSpec = command.lightModel ? LIGHT_MODEL_MAP[command.lightModel] : LIGHT_MODEL_MAP.sonnet;
    if (!modelSpec) {
      await sendHtml(init.bot, chatId, "<b>Unknown light model</b>");
      return;
    }

    const commandText = `/${command.nativeName}${rawArgs.trim() ? ` ${rawArgs.trim()}` : ""}`;

    try {
      const model = getModel(
        modelSpec.provider as "anthropic",
        modelSpec.id as "claude-haiku-4-5" | "claude-sonnet-4-5",
      );
      const response = await completeSimple(model, {
        messages: [{ role: "user", content: commandText, timestamp: Date.now() }],
      }, { maxTokens: 1800 });

      const text = response.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n\n")
        .trim();

      const body = text || "(no response)";
      await sendHtml(init.bot, chatId, escapeHtml(truncateForTelegram(body)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendHtml(init.bot, chatId, `<b>Light execution failed</b>\n<code>${escapeHtml(message)}</code>`);
    }

    return;
  }

  const commandText = `/${command.nativeName}${rawArgs.trim() ? ` ${rawArgs.trim()}` : ""}`;
  const source = `telegram:${chatId}`;
  const withChannelContext = injectChannelContext(commandText, { source });
  const prompt = await enrichPromptWithVaultContext(withChannelContext);

  await init.enqueue(source, prompt, {
    source,
    originSession: source,
    telegramChatId: chatId,
    telegramMessageId: options?.telegramMessageId ?? ctx.message?.message_id,
    command: command.nativeName,
    execution: command.execution,
    fromArgsMenu: options?.fromArgsMenu ?? false,
  });
}

function registerCallbackHandler(init: CommandHandlerInit): void {
  init.bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(CALLBACK_PREFIX)) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery();

    const payload = data.slice(CALLBACK_PREFIX.length);
    const [nativeName, ...rawValueParts] = payload.split(":");
    const rawValue = rawValueParts.join(":").trim();
    if (!nativeName) return;

    const command = getCommand(nativeName);
    if (!command) return;

    await executeCommand(ctx, command, rawValue, init, {
      fromArgsMenu: true,
      telegramMessageId: ctx.callbackQuery.message?.message_id,
    });
  });
}

export async function initializeTelegramCommandHandler(init: CommandHandlerInit): Promise<void> {
  const skillCommands = await loadSkillCommands();
  const skillsMenuCommand = createSkillsMenuCommand(skillCommands.skills);

  registerMcqAdapter(init.bot, init.chatId);
  registerWorktreeCallbackHandler(init.bot, init.chatId);

  registerCommands([
    ...BUILTIN_COMMANDS,
    ...createConfigCommands(init.redis),
    BUILD_COMMAND,
    ...skillCommands.commands,
    skillsMenuCommand,
  ]);
  pinnedStatusContext = init;

  const menuCommands = getCommands().filter((command) => !command.hidden);
  // Telegram API issues (e.g. stale/invalid bot state) should not crash the gateway.
  try {
    await init.bot.api.setMyCommands(menuCommands.map((command) => ({
      command: command.nativeName,
      description: command.description,
    })));
  } catch (error) {
    console.warn("[gateway:telegram] setMyCommands failed; continuing without command registration", error);
  }

  const allCommands = getAllCommands();
  for (const command of allCommands) {
    init.bot.command(command.nativeName, async (ctx) => {
      const text = ctx.message?.text ?? "";
      const rawArgs = commandTextFromMessage(text, command.nativeName);
      await executeCommand(ctx, command, rawArgs, init);
    });
  }

  registerCallbackHandler(init);

  try {
    await updatePinnedStatus();
  } catch (error) {
    console.warn("[gateway:telegram] initial pinned status update failed; continuing", error);
  }
}
