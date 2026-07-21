import {
  getMessageEventLogClient,
  type MessageEventOrigin,
} from "@joelclaw/message-event-log";
import { journalMessage } from "../message-journal";
import {
  type FallbackChannel,
  type MessageEventAppender,
  makeRawTelegramFallbackSender,
  makeSlimNotifyIngress,
  type ProducerFacts,
  RawFallbackDeliveryError,
  SlimIngressStageError,
  type SlimNotifyIngressResult,
} from "../transport-slim";
import { getChatSdkRuntime } from "./instance";

export interface SlimNotifyGatewayEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly payload: Record<string, unknown>;
  readonly ts: number;
}

export interface SlimNotifyRouteDependencies {
  readonly heartbeatExists: () => Promise<boolean>;
  readonly eventLog?: MessageEventAppender;
  readonly fallbackChannel?: FallbackChannel;
  readonly machineId?: string;
  readonly now?: () => number;
}

export type SlimNotifyRouteResult =
  | { readonly handled: false }
  | ({ readonly handled: true } & SlimNotifyIngressResult);

export class SlimNotifyIngressError extends Error {
  readonly handled: boolean;

  constructor(
    readonly eventId: string,
    readonly cause: unknown,
  ) {
    super(`Slim notify ingress failed for ${eventId}`);
    this.handled = cause instanceof SlimIngressStageError
      && cause.stage === "fallback"
      && cause.cause instanceof RawFallbackDeliveryError
      && cause.cause.crossedPlatformBoundary;
    this.name = "SlimNotifyIngressError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function notifyFlowId(event: SlimNotifyGatewayEvent): string {
  return nonBlank(asRecord(event.payload.audit)?.flowId)
    ?? `gateway-event:${event.id}`;
}

function producerText(event: SlimNotifyGatewayEvent): string | undefined {
  const prompt = event.payload.prompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt;
  const message = event.payload.message;
  if (typeof message === "string" && message.trim()) return message;
  const telegramMessage = event.payload.telegramMessage;
  if (typeof telegramMessage === "string" && telegramMessage.trim()) {
    return telegramMessage;
  }
  return undefined;
}

function originFor(
  event: SlimNotifyGatewayEvent,
  machineId: string,
): MessageEventOrigin {
  const context = asRecord(event.payload.context);
  const audit = asRecord(event.payload.audit);
  const supplied = asRecord(context?.origin);
  return {
    producer: nonBlank(supplied?.producer) ?? event.source,
    machineId: nonBlank(supplied?.machineId)
      ?? nonBlank(context?.machineId)
      ?? nonBlank(audit?.originSystemId)
      ?? machineId,
    ...(nonBlank(supplied?.paneId) ?? nonBlank(context?.paneId)
      ? { paneId: nonBlank(supplied?.paneId) ?? nonBlank(context?.paneId) }
      : {}),
    ...(nonBlank(supplied?.sessionId) ?? nonBlank(context?.sessionId)
      ? { sessionId: nonBlank(supplied?.sessionId) ?? nonBlank(context?.sessionId) }
      : {}),
  };
}

function fallbackChannelFromEnvironment(): FallbackChannel {
  const value = process.env.FALLBACK_CHANNEL?.trim().toLowerCase() || "telegram";
  if (value !== "telegram" && value !== "sms") {
    throw new Error("FALLBACK_CHANNEL must be telegram or sms");
  }
  return value;
}

function telegramAdapter() {
  const adapter = getChatSdkRuntime().adapters.telegram;
  if (!adapter) throw new Error("Canonical Chat SDK Telegram adapter is unavailable");
  return {
    openDM: (userId: string) => adapter.openDM(userId),
    postMessage: (threadId: string, message: Parameters<typeof adapter.postMessage>[1]) =>
      adapter.postMessage(threadId, message),
  };
}

/**
 * Compatibility wire decoder only. Routing flags remain evidence in the
 * appended payload and cannot select a platform or delivery mode.
 */
export async function routeNotifySendToSlimTransport(
  event: SlimNotifyGatewayEvent,
  dependencies: SlimNotifyRouteDependencies,
): Promise<SlimNotifyRouteResult> {
  const flowId = notifyFlowId(event);
  const text = producerText(event);
  if (!text) return { handled: false };

  try {
    const eventLog = dependencies.eventLog ?? getMessageEventLogClient();
    const facts: ProducerFacts = {
      eventId: event.id,
      source: event.source,
      text,
      flowId,
      occurredAt: event.ts,
      origin: originFor(
        event,
        dependencies.machineId
          ?? process.env.JOELCLAW_MACHINE_ID?.trim()
          ?? process.env.HOSTNAME?.trim()
          ?? "flagg",
      ),
      evidence: event.payload,
    };
    const result = await makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: dependencies.heartbeatExists,
      fallbackChannel: dependencies.fallbackChannel ?? fallbackChannelFromEnvironment(),
      sendRawTelegramFallback: async (input) => {
        const recipientId = process.env.TELEGRAM_USER_ID?.trim();
        if (!recipientId) {
          throw new RawFallbackDeliveryError(
            false,
            new Error("TELEGRAM_USER_ID is required for fallback"),
          );
        }
        let adapter;
        try {
          adapter = telegramAdapter();
        } catch (error) {
          throw new RawFallbackDeliveryError(false, error);
        }
        return makeRawTelegramFallbackSender({
          adapter,
          recipientId,
          journal: { record: journalMessage },
          eventLog,
        })(input);
      },
      now: dependencies.now,
    })(facts);
    return { handled: true, ...result };
  } catch (error) {
    // The append or platform-send boundary may already have been crossed.
    // Mark this event handled so legacy policy cannot create a second send.
    throw new SlimNotifyIngressError(event.id, error);
  }
}
