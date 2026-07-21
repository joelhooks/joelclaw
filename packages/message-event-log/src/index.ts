import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";

export const MESSAGE_EVENT_CONSUME_REQUESTED = "message/event.consume.requested" as const;
export const MESSAGE_EVENT_CONSUMER = "system-bus/message-event-consumer" as const;
export const GATEWAY_MESSAGE_EVENT_CONSUMER = "gateway/agent" as const;

export type MessageEventKind =
  | "message.requested"
  | "message.composed"
  | "delivery.requested"
  | "delivery.confirmed"
  | "delivery.failed"
  | "message.batched"
  | "message.digested"
  | "message.suppressed"
  | "action.declared"
  | "action.received"
  | "reaction.received"
  | "gateway.decision.recorded"
  | "gateway.handoff"
  | "aggregate.deadline.reached"
  | "fallback.delivered"
  | "inbound.received"
  | "inbound.interpreted";

export type MessagePlatform = "telegram" | "slack" | "discord" | "imessage";

export type MessageEventOrigin = {
  producer: string;
  machineId: string;
  paneId?: string;
  sessionId?: string;
};

export type GatewayTargetIntent =
  | { kind: "platform"; platform: MessagePlatform; conversationId?: string }
  | { kind: "phone" }
  | { kind: "live-pane"; paneId: string }
  | { kind: "revived-session"; sessionId: string }
  | { kind: "bus-consumer"; consumer: string; flowId: string };

export type GatewayDecision =
  | { verb: "deliver"; target: GatewayTargetIntent; rewrite: string }
  | {
      verb: "aggregate";
      action: "open" | "join" | "extend" | "close-deliver";
      aggregateId: string;
      memberEventIds: string[];
      holdUntil?: number;
      follows?: string;
      rewrite?: string;
      target?: GatewayTargetIntent;
    }
  | { verb: "escalate"; target: GatewayTargetIntent; rewrite: string }
  | { verb: "fanout"; taskId: string }
  | { verb: "route"; target: GatewayTargetIntent }
  | { verb: "drop" };

export type GatewayDecisionRecordedPayload = {
  inputEventIds: string[];
  reason: string;
  promptRevision: string;
  decisionSeq: number;
  decision: GatewayDecision;
};

export type GatewayHandoffPayload = {
  sessionId: string;
  promptRevision: string;
  note: string;
  lastSequence: number;
};

export type AggregateDeadlineReachedPayload = {
  aggregateId: string;
  memberEventIds: string[];
  holdUntil: number;
  follows?: string;
};

export type FallbackDeliveredPayload = {
  sourceEventId: string;
  fallback: true;
  heartbeatObservedAt: number;
  heartbeatStaleForMs: number;
  target: string;
  platformMessageId: string;
  outcome: "confirmed" | "failed";
};

export type InboundContentPacket = {
  text?: string;
  data?: unknown;
};

export type InboundReceivedPayload = {
  platformEventId: string;
  actorId: string;
  conversationId: string;
  threadId?: string;
  replyFlowId?: string;
  content: InboundContentPacket;
};

export type InboundInterpretedPayload = {
  inboundEventId: string;
  reason: string;
  promptRevision: string;
  target: Extract<
    GatewayTargetIntent,
    { kind: "live-pane" | "revived-session" | "bus-consumer" }
  >;
};

export type MessageEventPayloadByKind = {
  "gateway.decision.recorded": GatewayDecisionRecordedPayload;
  "gateway.handoff": GatewayHandoffPayload;
  "aggregate.deadline.reached": AggregateDeadlineReachedPayload;
  "fallback.delivered": FallbackDeliveredPayload;
  "inbound.received": InboundReceivedPayload;
  "inbound.interpreted": InboundInterpretedPayload;
};

export type MessageEventPayload<K extends MessageEventKind> =
  K extends keyof MessageEventPayloadByKind ? MessageEventPayloadByKind[K] : unknown;

export type AppendMessageEventInput<K extends MessageEventKind = MessageEventKind> = {
  semanticKey: string;
  kind: K;
  source: string;
  payload: MessageEventPayload<K>;
  occurredAt?: number;
  flowId?: string;
  origin?: MessageEventOrigin;
  correlationId?: string;
  rawSourceId?: string;
  deliveryId?: string;
  platform?: MessagePlatform;
  platformMessageId?: string;
};

export type AppendMessageEventReceipt = {
  eventId: string;
  semanticKey: string;
  deduplicated: boolean;
  schemaVersion: number;
};

export type MaterializeMessageEventReceipt = {
  eventId: string;
  deduplicated: boolean;
  flowView: boolean;
  platformView: boolean;
  terminalView: boolean;
  actionView: boolean;
};

export type MessageEventDocument = AppendMessageEventInput & {
  _id: string;
  _creationTime: number;
  schemaVersion: number;
  sequence: number;
  occurredAt: number;
  recordedAt: number;
};

export type MessageConsumerCursor = {
  consumer: string;
  lastEventId: string;
  lastSequence: number;
  updatedAt: number;
};

export type ReadSinceResult = {
  events: MessageEventDocument[];
  nextCursor: string | null;
  source: "message-event-log";
};

export type MessageFlowProjection = {
  flowId: string;
  eventCount: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  latestEventId: string;
  latestKind: MessageEventKind;
  terminalState?: "confirmed" | "failed" | "suppressed" | "digested";
  updatedAt: number;
};

export type MessageConsumerReceipt = {
  eventId: string;
  semanticKey: string;
  flowId?: string;
  consumer: string;
  inngestEventId: string;
  processedAt: number;
};

export type MessageEventTraceResult =
  | { kind: "not_found"; lookup: string }
  | {
      kind: "trace";
      source: "convex";
      flowId: string;
      projection: MessageFlowProjection | null;
      events: MessageEventDocument[];
      consumerReceipts: MessageConsumerReceipt[];
      truncated: boolean;
    };

export type MessageEventLogOperation =
  | "append"
  | "materialize"
  | "pending"
  | "advanceCursor"
  | "readSince"
  | "trace";

export class MessageEventLogError extends Error {
  readonly _tag = "MessageEventLogError";
  constructor(
    readonly operation: MessageEventLogOperation,
    readonly code: string,
    override readonly cause: unknown,
  ) {
    super(`Message event log ${operation} failed (${code})`);
  }
}

type ClientOptions = {
  url?: string;
  adminKey?: string;
  client?: ConvexHttpClient;
};

const cleanEnv = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim().replace(/\\n$/, "").trim();
  return cleaned || undefined;
};

const requireNonEmpty = (value: string, field: string): string => {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return cleaned;
};

export const gatewayDecisionSemanticKey = (
  payload: Pick<GatewayDecisionRecordedPayload, "inputEventIds" | "decisionSeq">,
): string => {
  const firstInputEventId = requireNonEmpty(payload.inputEventIds[0] ?? "", "inputEventIds[0]");
  if (!Number.isSafeInteger(payload.decisionSeq) || payload.decisionSeq < 1) {
    throw new Error("decisionSeq must be a positive safe integer");
  }
  return `gateway:${firstInputEventId}:${payload.decisionSeq}`;
};

export const resolveMessageEventLogUrl = (): string =>
  cleanEnv(process.env.MESSAGE_EVENT_CONVEX_URL) ??
  cleanEnv(process.env.CONVEX_SELF_HOSTED_URL) ??
  cleanEnv(process.env.CONVEX_URL) ??
  "http://127.0.0.1:3210";

export const createMessageEventLogClient = (options: ClientOptions = {}) => {
  const client = options.client ?? new ConvexHttpClient(options.url ?? resolveMessageEventLogUrl());
  const adminKey = cleanEnv(options.adminKey ?? process.env.CONVEX_DEPLOY_KEY);
  if (adminKey) {
    (client as ConvexHttpClient & { setAdminAuth: (token: string) => void }).setAdminAuth(adminKey);
  }

  const appendRef = (anyApi as any).messageEvents.append as FunctionReference<"mutation">;
  const materializeRef = (anyApi as any).messageEvents.materialize as FunctionReference<"mutation">;
  const pendingRef = (anyApi as any).messageEvents.pendingForConsumer as FunctionReference<"query">;
  const advanceCursorRef = (anyApi as any).messageEvents.advanceConsumerCursor as FunctionReference<"mutation">;
  const readSinceRef = (anyApi as any).messageEvents.readSince as FunctionReference<"query">;
  const traceRef = (anyApi as any).messageEvents.traceByFlow as FunctionReference<"query">;

  return {
    append: async <K extends MessageEventKind>(
      input: AppendMessageEventInput<K>,
    ): Promise<AppendMessageEventReceipt> => {
      try {
        return (await client.mutation(appendRef, input)) as AppendMessageEventReceipt;
      } catch (error) {
        throw new MessageEventLogError("append", "MESSAGE_EVENT_APPEND_FAILED", error);
      }
    },
    pending: async (limit = 50): Promise<MessageEventDocument[]> => {
      try {
        return (await client.query(pendingRef, {
          consumer: MESSAGE_EVENT_CONSUMER,
          limit,
        })) as MessageEventDocument[];
      } catch (error) {
        throw new MessageEventLogError("pending", "MESSAGE_EVENT_PENDING_FAILED", error);
      }
    },
    pendingForConsumer: async (consumer: string, limit = 50): Promise<MessageEventDocument[]> => {
      try {
        return (await client.query(pendingRef, {
          consumer: requireNonEmpty(consumer, "consumer"),
          limit,
        })) as MessageEventDocument[];
      } catch (error) {
        throw new MessageEventLogError("pending", "MESSAGE_EVENT_PENDING_FAILED", error);
      }
    },
    advanceCursor: async (consumer: string, eventId: string): Promise<MessageConsumerCursor> => {
      try {
        return (await client.mutation(advanceCursorRef, {
          consumer: requireNonEmpty(consumer, "consumer"),
          eventId: requireNonEmpty(eventId, "eventId"),
        })) as MessageConsumerCursor;
      } catch (error) {
        throw new MessageEventLogError("advanceCursor", "MESSAGE_EVENT_CURSOR_ADVANCE_FAILED", error);
      }
    },
    readSince: async (
      recordedAt: number,
      limit = 100,
      cursor: string | null = null,
    ): Promise<ReadSinceResult> => {
      try {
        return (await client.query(readSinceRef, { cursor, limit, recordedAt })) as ReadSinceResult;
      } catch (error) {
        throw new MessageEventLogError("readSince", "MESSAGE_EVENT_READ_SINCE_FAILED", error);
      }
    },
    materialize: async (input: {
      eventId: string;
      inngestEventId: string;
    }): Promise<MaterializeMessageEventReceipt> => {
      try {
        return (await client.mutation(materializeRef, {
          ...input,
          consumer: MESSAGE_EVENT_CONSUMER,
        })) as MaterializeMessageEventReceipt;
      } catch (error) {
        throw new MessageEventLogError("materialize", "MESSAGE_EVENT_MATERIALIZE_FAILED", error);
      }
    },
    trace: async (flowId: string, limit = 100): Promise<MessageEventTraceResult> => {
      try {
        return (await client.query(traceRef, { flowId, limit })) as MessageEventTraceResult;
      } catch (error) {
        throw new MessageEventLogError("trace", "MESSAGE_EVENT_TRACE_FAILED", error);
      }
    },
  };
};

let defaultClient: ReturnType<typeof createMessageEventLogClient> | undefined;

export const getMessageEventLogClient = () => {
  defaultClient ??= createMessageEventLogClient();
  return defaultClient;
};
