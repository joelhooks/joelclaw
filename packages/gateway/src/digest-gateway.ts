import {
  buildFixtureDigestPrototype,
  createFixtureDigestInput,
  DIGEST_AGENT_TOOL,
  type DigestActionOutcome,
  type DigestResult,
  type DigestTelegramButton,
  type FixtureDigestPrototype,
  makeFetchDigestLinkVerifier,
  runDigestAgentTool,
} from "@joelclaw/digest";
import {
  ACTION_CALLBACK_PREFIX,
  makeRedisActionRegistry,
  type RedisActionRegistryClient,
} from "@joelclaw/source-actions";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";
import type { Bot } from "grammy";
import {
  acknowledgeCallbackTrace,
  completeCallbackTrace,
  failCallbackTrace,
  markCallbackTraceDispatched,
  startCallbackTrace,
} from "./callback-trace";
import {
  journalMessage,
  resolveTelegramMessageFlow,
} from "./message-journal";

export type GatewayDigestPrototype = FixtureDigestPrototype;
export type DigestPrototypeAccessor = () => GatewayDigestPrototype | undefined;

type DigestToolInput = {
  trigger?: "on-demand" | "scheduled";
};

type DigestCallbackIo = {
  answerWorking: () => Promise<void>;
  editKeyboard: (buttons: readonly (readonly DigestTelegramButton[])[]) => Promise<void>;
  reportFailure: (message: string) => Promise<void>;
};

export type DigestCallbackResult =
  | { status: DigestActionOutcome["status"]; keyboardEdited: true }
  | { status: "failed-to-handle"; keyboardEdited: false; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDigestTrigger(value: unknown): value is "on-demand" | "scheduled" {
  return value === "on-demand" || value === "scheduled";
}

export function makeLiveRedisActionRegistryClient(
  getClient: () => RedisActionRegistryClient | undefined,
): RedisActionRegistryClient {
  const client = (): RedisActionRegistryClient => {
    const current = getClient();
    if (!current) throw new Error("Redis action registry client unavailable");
    return current;
  };

  return {
    hget: (key, field) => client().hget(key, field),
    hset: (key, field, value) => client().hset(key, field, value),
    get: (key) => client().get(key),
    set: (key, value, expiryMode, leaseMs, setMode) =>
      client().set(key, value, expiryMode, leaseMs, setMode),
    eval: (script, numberOfKeys, ...args) =>
      client().eval(script, numberOfKeys, ...args),
  };
}

export async function composeFixtureDigestPrototype(
  redis: RedisActionRegistryClient,
): Promise<FixtureDigestPrototype> {
  const registry = makeRedisActionRegistry(redis);
  return Effect.runPromise(
    buildFixtureDigestPrototype(registry, {
      verifyLink: makeFetchDigestLinkVerifier(),
    }),
  );
}

export async function executeDigestAgentTool(
  prototype: FixtureDigestPrototype,
  input: DigestToolInput,
): Promise<DigestResult> {
  const fixtureInput = createFixtureDigestInput(new Date().toISOString());
  return Effect.runPromise(
    runDigestAgentTool(prototype.service, {
      ...fixtureInput,
      trigger: isDigestTrigger(input.trigger) ? input.trigger : "on-demand",
    }),
  );
}

export function makeDigestAgentExtension(
  getPrototype: DigestPrototypeAccessor,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const tool: ToolDefinition = {
      ...DIGEST_AGENT_TOOL,
      parameters: DIGEST_AGENT_TOOL.parameters as ToolDefinition["parameters"],
      executionMode: "sequential",
      execute: async (_toolCallId, rawInput) => {
        const prototype = getPrototype();
        if (!prototype) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                kind: "empty",
                reason: "digest-service-unavailable",
              }),
            }],
            details: {
              kind: "empty",
              reason: "digest-service-unavailable",
            },
          };
        }

        const input = rawInput as DigestToolInput;
        const result = await executeDigestAgentTool(prototype, input);
        return {
          content: [{
            type: "text",
            text: result.kind === "ready"
              ? result.payload.text
              : JSON.stringify(result),
          }],
          details: {
            result,
            fixtureSourceDurability: "process-local",
            actionRegistryDurability: "redis",
          },
        };
      },
    };
    pi.registerTool(tool);
  };
}

export async function handleDigestActionCallback(
  prototype: FixtureDigestPrototype,
  input: { actionId: string; telegramMessageId: number },
  io: DigestCallbackIo,
): Promise<DigestCallbackResult> {
  await io.answerWorking();

  try {
    const outcome = await Effect.runPromise(
      prototype.service.handleAction(input),
    );
    const controls = prototype.result.kind === "ready"
      ? prototype.result.controls
      : [];
    const refreshed = await Effect.runPromise(
      prototype.service.refreshControls(controls),
    );
    await io.editKeyboard(refreshed);
    return { status: outcome.status, keyboardEdited: true };
  } catch (error) {
    const message = errorText(error);
    await io.reportFailure(message);
    return {
      status: "failed-to-handle",
      keyboardEdited: false,
      error: message,
    };
  }
}

type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

function toTelegramInlineKeyboard(
  buttons: readonly (readonly DigestTelegramButton[])[],
): TelegramInlineButton[][] {
  return buttons.map((row) => row.flatMap<TelegramInlineButton>((button) => {
    if (button.url) return [{ text: button.text, url: button.url }];
    if (button.action) return [{ text: button.text, callback_data: button.action }];
    return [];
  }));
}

export function registerDigestCallbackRoute(
  bot: Bot,
  getPrototype: DigestPrototypeAccessor,
): void {
  bot.callbackQuery(new RegExp(`^${ACTION_CALLBACK_PREFIX}`, "u"), async (ctx) => {
    const actionId = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message?.chat.id;
    const telegramMessageId = ctx.callbackQuery.message?.message_id;
    const callbackQueryId = ctx.callbackQuery.id;
    const flowId = await resolveTelegramMessageFlow(chatId, telegramMessageId)
      ?? `telegram-digest-callback:${chatId ?? "unknown"}:${telegramMessageId ?? callbackQueryId}`;
    const traceId = startCallbackTrace({
      handler: "digest.callback",
      route: ACTION_CALLBACK_PREFIX,
      rawData: actionId,
      chatId,
      messageId: telegramMessageId,
    });

    await journalMessage({
      messageKey: `telegram:${chatId ?? 0}:${telegramMessageId ?? callbackQueryId}`,
      flowId,
      direction: "interaction",
      eventType: "interaction.received",
      producer: "digest-callback",
      originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
      sourceRef: "signal/digest.assembled",
      route: "telegram.digest.callback",
      classification: "interaction",
      reason: "digest.callback.received",
      telegramChatId: chatId ?? 0,
      telegramMessageId,
      callbackQueryId,
      interactionAction: "digest-action",
      interactionPayload: actionId,
      interactionOutcome: "received",
      deliveryState: "received",
    });

    if (!chatId || !telegramMessageId) {
      const error = "Digest callback is missing its Telegram message context";
      await ctx.answerCallbackQuery({ text: "Action failed", show_alert: true }).catch(() => {});
      failCallbackTrace(traceId, error, "missing Telegram callback context");
      await journalMessage({
        messageKey: `telegram:${chatId ?? 0}:${callbackQueryId}`,
        flowId,
        direction: "interaction",
        eventType: "interaction.completed",
        producer: "digest-callback",
        originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
        sourceRef: "signal/digest.assembled",
        route: "telegram.digest.callback",
        classification: "interaction",
        reason: "digest.callback.failed",
        telegramChatId: chatId ?? 0,
        callbackQueryId,
        interactionAction: "digest-action",
        interactionPayload: actionId,
        interactionOutcome: "failed",
        deliveryState: "failed",
        errorCode: "missing-message-context",
      });
      return;
    }

    const prototype = getPrototype();
    if (!prototype) {
      const error = "Digest service unavailable";
      await ctx.answerCallbackQuery({ text: error, show_alert: true }).catch(() => {});
      failCallbackTrace(traceId, error, "digest service unavailable");
      await journalMessage({
        messageKey: `telegram:${chatId}:${telegramMessageId}`,
        flowId,
        direction: "interaction",
        eventType: "interaction.completed",
        producer: "digest-callback",
        originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
        sourceRef: "signal/digest.assembled",
        route: "telegram.digest.callback",
        classification: "interaction",
        reason: "digest.callback.unavailable",
        telegramChatId: chatId,
        telegramMessageId,
        callbackQueryId,
        interactionAction: "digest-action",
        interactionPayload: actionId,
        interactionOutcome: "failed",
        deliveryState: "failed",
        errorCode: "digest-service-unavailable",
      });
      return;
    }

    const result = await handleDigestActionCallback(
      prototype,
      { actionId, telegramMessageId },
      {
        answerWorking: async () => {
          try {
            await ctx.answerCallbackQuery({ text: "Working…" });
            acknowledgeCallbackTrace(traceId, { text: "Working…" });
            markCallbackTraceDispatched(traceId, "digest action claimed for execution");
          } catch (error) {
            acknowledgeCallbackTrace(traceId, {
              text: "Working…",
              error: errorText(error),
            });
          }
        },
        editKeyboard: async (controls) => {
          await bot.api.editMessageReplyMarkup(chatId, telegramMessageId, {
            reply_markup: {
              inline_keyboard: toTelegramInlineKeyboard(controls),
            },
          });
        },
        reportFailure: async (message) => {
          console.error("[gateway:digest] callback failed; keyboard preserved", {
            actionId,
            chatId,
            telegramMessageId,
            error: message,
          });
          await bot.api.sendMessage(
            chatId,
            "Digest action failed. The button is still there so you can retry.",
            { reply_parameters: { message_id: telegramMessageId } },
          ).catch(() => {});
        },
      },
    );

    if (result.status === "failed-to-handle") {
      failCallbackTrace(traceId, result.error, "digest action failed; keyboard preserved");
    } else {
      completeCallbackTrace(traceId, `digest action ${result.status}; controls refreshed`);
    }

    await journalMessage({
      messageKey: `telegram:${chatId}:${telegramMessageId}`,
      flowId,
      direction: "interaction",
      eventType: "interaction.completed",
      producer: "digest-callback",
      originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
      sourceRef: "signal/digest.assembled",
      route: "telegram.digest.callback",
      classification: "interaction",
      reason: result.status === "failed-to-handle"
        ? "digest.callback.failed"
        : `digest.callback.${result.status}`,
      telegramChatId: chatId,
      telegramMessageId,
      callbackQueryId,
      interactionAction: "digest-action",
      interactionPayload: actionId,
      interactionOutcome: result.status === "failed-to-handle" ? "failed" : result.status,
      deliveryState: result.status === "failed-to-handle" ? "failed" : "confirmed",
      errorCode: result.status === "failed-to-handle" ? result.error : undefined,
    });
  });
}
