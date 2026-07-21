import type {
  AppendMessageEventInput,
  AppendMessageEventReceipt,
  MessageEventOrigin,
  MessagePlatform,
} from "@joelclaw/message-event-log";
import type { JournalEventInput } from "@joelclaw/message-journal";
import type { AdapterPostableMessage } from "chat";

export type SdkPostableMessage = AdapterPostableMessage;

export interface SdkDeliveryAdapter {
  readonly openDM: (userId: string) => Promise<string>;
  readonly postMessage: (
    threadId: string,
    message: SdkPostableMessage,
  ) => Promise<{ readonly id: string; readonly threadId: string; readonly raw?: unknown }>;
}

export const GATEWAY_AGENT_HEARTBEAT_KEY = "gateway:agent:heartbeat" as const;
export const FALLBACK_PREFIX = "⚠️ fallback:" as const;
export type FallbackChannel = "telegram" | "sms";

export interface MessageEventAppender {
  readonly append: (
    input: AppendMessageEventInput,
  ) => Promise<AppendMessageEventReceipt>;
}

export interface JournalPort {
  readonly record: (input: JournalEventInput) => Promise<{ readonly persisted: boolean }>;
}

export interface ProducerFacts {
  readonly eventId: string;
  readonly source: string;
  readonly text: string;
  readonly flowId: string;
  readonly occurredAt: number;
  readonly origin: MessageEventOrigin;
  readonly evidence: Record<string, unknown>;
}

export interface ExplicitTransportSendRequest {
  readonly target: {
    readonly platform: MessagePlatform;
    readonly recipientId: string;
  };
  readonly content: SdkPostableMessage;
  readonly text: string;
  readonly flowId: string;
  readonly origin: MessageEventOrigin;
  readonly correlationId?: string;
  readonly replyThreadId?: string;
}

export interface ExplicitTransportSendReceipt {
  readonly flowId: string;
  readonly platform: MessagePlatform;
  readonly platformMessageId: string;
  readonly threadId: string;
}

export interface RawFallbackRequest {
  readonly text: string;
  readonly flowId: string;
  readonly sourceEventId: string;
  readonly origin: MessageEventOrigin;
  readonly heartbeatObservedAt: number;
  readonly heartbeatStaleForMs: number;
}

export interface SlimNotifyIngressDependencies {
  readonly eventLog: MessageEventAppender;
  readonly heartbeatExists: () => Promise<boolean>;
  readonly fallbackChannel: FallbackChannel;
  readonly sendRawTelegramFallback: (
    input: RawFallbackRequest,
  ) => Promise<ExplicitTransportSendReceipt>;
  readonly now?: () => number;
  readonly heartbeatTtlMs?: number;
}

export class RawFallbackDeliveryError extends Error {
  constructor(
    readonly crossedPlatformBoundary: boolean,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`${crossedPlatformBoundary
      ? "Fallback delivery is ambiguous after the platform boundary"
      : "Fallback delivery failed before the platform boundary"}${detail}`);
    this.name = "RawFallbackDeliveryError";
  }
}

export class SlimIngressStageError extends Error {
  constructor(
    readonly stage: "append" | "heartbeat" | "fallback",
    override readonly cause: unknown,
  ) {
    super(`Slim transport ingress failed at ${stage}`);
    this.name = "SlimIngressStageError";
  }
}

export type SlimNotifyIngressResult =
  | {
      readonly disposition: "agent";
      readonly sourceEventId: string;
      readonly flowId: string;
    }
  | {
      readonly disposition: "fallback";
      readonly sourceEventId: string;
      readonly flowId: string;
      readonly platformMessageId: string;
    };

function numericTelegramId(value: string): number | null {
  const candidate = Number(value.split(":").at(-1));
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function originSystemId(origin: MessageEventOrigin): string {
  return origin.sessionId ?? origin.paneId ?? origin.machineId;
}

function journalInput(input: {
  readonly request: ExplicitTransportSendRequest;
  readonly eventType: "message.outbound.requested" | "message.outbound.confirmed" | "message.outbound.failed";
  readonly deliveryState: "requested" | "confirmed" | "failed";
  readonly platformMessageId?: string;
  readonly threadId?: string;
  readonly errorCode?: string;
}): JournalEventInput {
  const { request } = input;
  const telegramChatId = request.target.platform === "telegram"
    ? (numericTelegramId(request.target.recipientId) ?? 0)
    : 0;
  const telegramMessageId = request.target.platform === "telegram" && input.platformMessageId
    ? numericTelegramId(input.platformMessageId)
    : null;
  return {
    messageKey: `${request.target.platform}:${request.flowId}:${input.eventType}`,
    flowId: request.flowId,
    channel: request.target.platform,
    direction: "outbound",
    eventType: input.eventType,
    producer: request.origin.producer,
    originSystemId: originSystemId(request.origin),
    sourceEventId: request.correlationId ?? null,
    sourceRef: request.correlationId ?? "",
    route: "explicit-agent-target",
    telegramChatId,
    telegramMessageId,
    text: request.text,
    transportText: request.text,
    deliveryState: input.deliveryState,
    errorCode: input.errorCode,
    metadata: {
      target: request.target,
      threadId: input.threadId,
      origin: request.origin,
      correlationId: request.correlationId,
    },
  };
}

/**
 * The gateway agent must choose the target and author the postable content.
 * This sender performs platform mechanics only; no kind or route table exists here.
 */
export function makeExplicitTransportSender(dependencies: {
  readonly adapters: Partial<Record<MessagePlatform, SdkDeliveryAdapter>>;
  readonly journal: JournalPort;
  readonly eventLog: MessageEventAppender;
  readonly rememberFlow?: (receipt: ExplicitTransportSendReceipt) => Promise<void>;
}) {
  return async function send(
    request: ExplicitTransportSendRequest,
  ): Promise<ExplicitTransportSendReceipt> {
    const adapter = dependencies.adapters[request.target.platform];
    if (!adapter) {
      throw new Error(`Transport adapter unavailable: ${request.target.platform}`);
    }

    await dependencies.eventLog.append({
      semanticKey: `delivery-requested:${request.flowId}`,
      kind: "delivery.requested",
      source: "gateway-agent",
      flowId: request.flowId,
      origin: request.origin,
      correlationId: request.correlationId,
      platform: request.target.platform,
      payload: {
        target: request.target,
        content: request.content,
      },
    });
    await dependencies.journal.record(journalInput({
      request,
      eventType: "message.outbound.requested",
      deliveryState: "requested",
    }));

    try {
      const threadId = request.replyThreadId
        ?? await adapter.openDM(request.target.recipientId);
      const sent = await adapter.postMessage(threadId, request.content);
      const platformMessageId = sent.id.trim();
      if (!platformMessageId) {
        throw new Error(`${request.target.platform} adapter returned no platform message id`);
      }
      const resolvedThreadId = sent.threadId.trim() || threadId;
      const journalReceipt = await dependencies.journal.record(journalInput({
        request,
        eventType: "message.outbound.confirmed",
        deliveryState: "confirmed",
        platformMessageId,
        threadId: resolvedThreadId,
      }));
      if (!journalReceipt.persisted) {
        throw new Error("Platform send succeeded but its journal receipt was not persisted");
      }
      const receipt: ExplicitTransportSendReceipt = {
        flowId: request.flowId,
        platform: request.target.platform,
        platformMessageId,
        threadId: resolvedThreadId,
      };
      await dependencies.rememberFlow?.(receipt);
      await dependencies.eventLog.append({
        semanticKey: `delivery-confirmed:${request.flowId}:${platformMessageId}`,
        kind: "delivery.confirmed",
        source: "gateway-transport",
        flowId: request.flowId,
        origin: request.origin,
        correlationId: request.correlationId,
        platform: request.target.platform,
        platformMessageId,
        payload: { threadId: resolvedThreadId },
      });
      return receipt;
    } catch (cause) {
      await dependencies.journal.record(journalInput({
        request,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_DELIVERY_FAILED",
      }));
      throw cause;
    }
  };
}

/**
 * Fallback is deliberately separate from the ordinary sender. It reaches the
 * owned Telegram adapter directly and cannot inherit routing or formatting policy.
 */
export function makeRawTelegramFallbackSender(dependencies: {
  readonly adapter: SdkDeliveryAdapter;
  readonly recipientId: string;
  readonly journal: JournalPort;
  readonly eventLog: MessageEventAppender;
}) {
  return async function sendRawTelegramFallback(
    input: RawFallbackRequest,
  ): Promise<ExplicitTransportSendReceipt> {
    const transportText = `${FALLBACK_PREFIX} ${input.text}`;
    const request: ExplicitTransportSendRequest = {
      target: { platform: "telegram", recipientId: dependencies.recipientId },
      content: { raw: transportText },
      text: transportText,
      flowId: input.flowId,
      origin: input.origin,
      correlationId: input.sourceEventId,
    };
    const threadId = await dependencies.adapter.openDM(dependencies.recipientId).catch((error) => {
      throw new RawFallbackDeliveryError(false, error);
    });
    const sent = await dependencies.adapter.postMessage(threadId, request.content).catch((error) => {
      // The adapter can fail after Telegram accepted the request. Never retry
      // this ambiguous send automatically.
      throw new RawFallbackDeliveryError(true, error);
    });
    const platformMessageId = sent.id.trim();
    if (!platformMessageId) {
      throw new RawFallbackDeliveryError(
        true,
        new Error("Telegram fallback adapter returned no platform message id"),
      );
    }
    const resolvedThreadId = sent.threadId.trim() || threadId;

    // Send first. If this persistence boundary is ambiguous, throw and do not
    // retry here: the recovered gateway agent reconciles the stream.
    const journalReceipt = await dependencies.journal.record(journalInput({
      request,
      eventType: "message.outbound.confirmed",
      deliveryState: "confirmed",
      platformMessageId,
      threadId: resolvedThreadId,
    })).catch((error) => {
      throw new RawFallbackDeliveryError(true, error);
    });
    if (!journalReceipt.persisted) {
      throw new RawFallbackDeliveryError(
        true,
        new Error("Fallback sent but its journal receipt was not persisted; automatic retry forbidden"),
      );
    }
    await dependencies.eventLog.append({
      semanticKey: `fallback-delivered:${input.sourceEventId}:${platformMessageId}`,
      kind: "fallback.delivered",
      source: "gateway-transport",
      flowId: input.flowId,
      origin: input.origin,
      correlationId: input.sourceEventId,
      platform: "telegram",
      platformMessageId,
      payload: {
        sourceEventId: input.sourceEventId,
        fallback: true,
        heartbeatObservedAt: input.heartbeatObservedAt,
        heartbeatStaleForMs: input.heartbeatStaleForMs,
        target: dependencies.recipientId,
        platformMessageId,
        outcome: "confirmed",
      },
    }).catch((error) => {
      throw new RawFallbackDeliveryError(true, error);
    });
    return {
      flowId: input.flowId,
      platform: "telegram",
      platformMessageId,
      threadId: resolvedThreadId,
    };
  };
}

/** Append first, then perform the one runtime decision: heartbeat exists or not. */
export function makeSlimNotifyIngress(
  dependencies: SlimNotifyIngressDependencies,
) {
  return async function ingest(
    facts: ProducerFacts,
  ): Promise<SlimNotifyIngressResult> {
    const appended = await dependencies.eventLog.append({
      semanticKey: `producer:${facts.eventId}`,
      kind: "message.requested",
      source: facts.source,
      flowId: facts.flowId,
      origin: facts.origin,
      rawSourceId: facts.eventId,
      occurredAt: facts.occurredAt,
      payload: {
        text: facts.text,
        evidence: facts.evidence,
      },
    }).catch((error) => {
      throw new SlimIngressStageError("append", error);
    });

    const heartbeatExists = await dependencies.heartbeatExists().catch((error) => {
      throw new SlimIngressStageError("heartbeat", error);
    });
    if (heartbeatExists) {
      return {
        disposition: "agent",
        sourceEventId: appended.eventId,
        flowId: facts.flowId,
      };
    }

    // The only other conditional is the static deploy-time channel selector.
    if (dependencies.fallbackChannel !== "telegram") {
      throw new SlimIngressStageError(
        "fallback",
        new Error("FALLBACK_CHANNEL=sms is not implemented; keep telegram until its adapter ships"),
      );
    }

    const now = (dependencies.now ?? Date.now)();
    const receipt = await dependencies.sendRawTelegramFallback({
      text: facts.text,
      flowId: facts.flowId,
      sourceEventId: appended.eventId,
      origin: facts.origin,
      heartbeatObservedAt: now,
      heartbeatStaleForMs: dependencies.heartbeatTtlMs ?? 60_000,
    }).catch((error) => {
      throw new SlimIngressStageError("fallback", error);
    });
    return {
      disposition: "fallback",
      sourceEventId: appended.eventId,
      flowId: facts.flowId,
      platformMessageId: receipt.platformMessageId,
    };
  };
}
