import type {
  InboundEvent,
  MessageActionRequestedEventType,
  MessageReactionReceivedEventType,
} from "@joelclaw/message-contract";
import {
  getMessageEventLogClient,
  type MessageEventOrigin,
} from "@joelclaw/message-event-log";
import { loadGatewayInngestEventConfig } from "../lib/inngest-event";
import type { MessageEventAppender } from "../transport-slim";
import { replyTargetForInboundEvent } from "./normalize";

export type InboundBusEventName =
  | "message/inbound.message"
  | "message/inbound.command"
  | "message/inbound.interaction"
  | "message/inbound.reaction";

export interface InboundBusEnvelope {
  readonly id: string;
  readonly name: InboundBusEventName;
  readonly data: InboundEvent;
}

export type MessageActionRequestedBusEnvelope =
  MessageActionRequestedEventType & { readonly id: string };

export type MessageReactionReceivedBusEnvelope =
  MessageReactionReceivedEventType & { readonly id: string };

export interface InboundBusClient {
  readonly send: (
    event:
      | InboundBusEnvelope
      | MessageActionRequestedBusEnvelope
      | MessageReactionReceivedBusEnvelope,
  ) => Promise<unknown>;
}

export interface GatewayInboundBusClientOptions {
  readonly eventApi?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createGatewayInboundBusClient(
  options: GatewayInboundBusClientOptions = {},
): InboundBusClient {
  return {
    async send(event): Promise<void> {
      const eventApi = options.eventApi ?? loadGatewayInngestEventConfig()?.eventApi;
      if (!eventApi) {
        throw new Error("Inngest event config missing for canonical inbound publish");
      }
      const response = await (options.fetchFn ?? fetch)(eventApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        throw new Error(`Inngest event API returned HTTP ${response.status}`);
      }
    },
  };
}

export function inboundBusEventName(event: InboundEvent): InboundBusEventName {
  return `message/inbound.${event.type}`;
}

function assertObserveOnly(event: InboundEvent): void {
  if (event.shadow !== true || event.authorization.canExecute !== false) {
    throw new Error("Inbound shadow publisher refuses executable events");
  }
  if (event.authorization.canPublish !== true) {
    throw new Error("Inbound event is not authorized for observe-only publication");
  }
}

export function createObserveOnlyInboundPublisher(client: InboundBusClient) {
  return {
    publishEvent: async (event: InboundEvent): Promise<void> => {
      assertObserveOnly(event);
      await client.send({
        id: event.eventId,
        name: inboundBusEventName(event),
        data: event,
      });
    },
  };
}

export type ObserveOnlyInboundPublisher = ReturnType<
  typeof createObserveOnlyInboundPublisher
>;

export interface StreamInboundPublisherOptions {
  readonly eventLog?: MessageEventAppender;
  readonly resolveFlowId: (
    platform: InboundEvent["platform"],
    platformMessageId: string,
    conversationId?: string,
  ) => Promise<string | undefined>;
  readonly machineId?: string;
}

function inboundOrigin(event: InboundEvent, machineId: string): MessageEventOrigin {
  return {
    producer: event.audit.source,
    machineId,
    ...(process.env.HERDR_PANE_ID?.trim()
      ? { paneId: process.env.HERDR_PANE_ID.trim() }
      : {}),
    ...(process.env.PI_SESSION_ID?.trim()
      ? { sessionId: process.env.PI_SESSION_ID.trim() }
      : {}),
  };
}

function inboundContent(event: InboundEvent): { text?: string; data: unknown } {
  switch (event.type) {
    case "message":
      return { text: event.text, data: event };
    case "command":
      return { text: [event.command, event.argumentsText].filter(Boolean).join(" "), data: event };
    case "interaction":
      return { text: event.value ?? undefined, data: event };
    case "reaction":
      return { text: event.rawEmoji, data: event };
  }
}

/** Canonical inbound stream append. It publishes facts and executes no policy. */
export function createStreamInboundPublisher(options: StreamInboundPublisherOptions) {
  const eventLog = options.eventLog ?? getMessageEventLogClient();
  const machineId = options.machineId
    ?? process.env.JOELCLAW_MACHINE_ID?.trim()
    ?? process.env.HOSTNAME?.trim()
    ?? "flagg";
  return {
    publishEvent: async (event: InboundEvent): Promise<void> => {
      if (
        event.authorization.verdict !== "accepted"
        || event.authorization.reason !== "authorized_joel"
      ) {
        return;
      }
      const platformMessageId = event.platformIds.messageId
        ?? event.rawAnchors.sourceMessageId
        ?? undefined;
      const correlationMessageId = event.type === "message"
        ? replyTargetForInboundEvent(event.eventId) ?? platformMessageId
        : platformMessageId;
      const replyFlowId = correlationMessageId
        ? await options.resolveFlowId(
            event.platform,
            correlationMessageId,
            event.platformIds.conversationId,
          )
        : undefined;
      await eventLog.append({
        semanticKey: `inbound:${event.eventId}`,
        kind: "inbound.received",
        source: event.audit.source,
        flowId: replyFlowId,
        origin: inboundOrigin(event, machineId),
        rawSourceId: event.audit.rawEventId ?? event.eventId,
        platform: event.platform,
        platformMessageId: platformMessageId ?? undefined,
        occurredAt: Date.parse(event.occurredAt),
        payload: {
          platformEventId: event.eventId,
          actorId: event.actor.platformUserId,
          conversationId: event.platformIds.conversationId,
          threadId: event.platformIds.threadId ?? undefined,
          replyFlowId,
          content: inboundContent(event),
        },
      });
    },
  };
}

export type StreamInboundPublisher = ReturnType<typeof createStreamInboundPublisher>;
