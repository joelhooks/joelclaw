import {
  type CallbackActionIdType,
  type DeliveryReceiptEnvelope,
  LEARNER_FLOW_ACTION_IDS,
  type MessageKindType,
  type OutboundIntent,
} from "@joelclaw/message-contract";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { mapNotifySendToIntent } from "./notify-compat";

export interface NotifyCompatGatewayEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly payload: Record<string, unknown>;
}

export interface NotifyCompatDeprecation {
  readonly eventId: string;
  readonly source: string;
  readonly legacyPriority: "low" | "normal" | "high" | "urgent" | "critical" | "omitted";
  readonly mappedKind: MessageKindType;
  readonly fix: string;
}

export interface NotifyCompatRouteDependencies {
  readonly isTransportReady?: () => boolean;
  readonly send: (intent: OutboundIntent) => Promise<DeliveryReceiptEnvelope>;
  readonly emitDeprecation?: (input: NotifyCompatDeprecation) => void | Promise<void>;
}

export class NotifyCompatDeliveryError extends Error {
  readonly handled = true;

  constructor(
    readonly eventId: string,
    readonly cause: unknown,
  ) {
    super(`Contract-v2 notify delivery failed for ${eventId}`);
    this.name = "NotifyCompatDeliveryError";
  }
}

export type NotifyCompatDisposition =
  | "confirmed"
  | "digested"
  | "failed";

export type NotifyCompatRouteResult =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly intent: OutboundIntent;
      readonly receipt: DeliveryReceiptEnvelope;
      readonly disposition: NotifyCompatDisposition;
    };

export function notifyCompatTelemetry(
  disposition: NotifyCompatDisposition,
): {
  readonly action: `notify.compat_v2.${NotifyCompatDisposition}`;
  readonly level: "info" | "error";
  readonly success: boolean;
  readonly error?: "NOTIFY_COMPAT_DELIVERY_FAILED";
} {
  const failed = disposition === "failed";
  return {
    action: `notify.compat_v2.${disposition}`,
    level: failed ? "error" : "info",
    success: !failed,
    ...(failed ? { error: "NOTIFY_COMPAT_DELIVERY_FAILED" as const } : {}),
  };
}

let transportReady = false;

export function setChatSdkActingTransportReady(ready: boolean): void {
  transportReady = ready;
}

export function isChatSdkActingTransportReady(): boolean {
  return transportReady;
}

function isNotifySendEvent(event: NotifyCompatGatewayEvent): boolean {
  const audit = event.payload.audit;
  if (!audit || typeof audit !== "object") return false;
  const flowId = (audit as Record<string, unknown>).flowId;
  return typeof flowId === "string" && flowId.startsWith("notify:");
}

function messageFrom(event: NotifyCompatGatewayEvent): string {
  const prompt = event.payload.prompt;
  const message = event.payload.message;
  if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  if (typeof message === "string" && message.trim()) return message.trim();
  return "";
}

function priorityFrom(
  value: unknown,
): "low" | "normal" | "high" | "urgent" | "critical" | undefined {
  if (
    value === "low"
    || value === "normal"
    || value === "high"
    || value === "urgent"
    || value === "critical"
  ) {
    return value;
  }
  return undefined;
}

const MESSAGE_KINDS: readonly MessageKindType[] = [
  "memory",
  "alert",
  "digest",
  "ask",
  "receipt",
];

function kindFrom(value: unknown): MessageKindType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MESSAGE_KINDS.includes(value as MessageKindType)) {
    throw new Error(
      `notify send payload.kind must be one of ${MESSAGE_KINDS.join(", ")}`,
    );
  }
  return value as MessageKindType;
}

function actionsFrom(value: unknown): OutboundIntent["actions"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("notify send context.actions must be an array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("notify send context.actions entries must be objects");
    }
    const action = item as Record<string, unknown>;
    if (
      action.kind !== "callback"
      || typeof action.id !== "string"
      || !LEARNER_FLOW_ACTION_IDS.includes(
        action.id as (typeof LEARNER_FLOW_ACTION_IDS)[number],
      )
      || typeof action.label !== "string"
    ) {
      throw new Error(
        "notify send context.actions entries require kind=callback, id, and label",
      );
    }
    return {
      kind: "callback" as const,
      id: action.id as CallbackActionIdType,
      label: action.label,
    };
  });
}

function terminalDisposition(
  receipt: DeliveryReceiptEnvelope,
): NotifyCompatDisposition {
  const { deliveryState, platformMessageId } = receipt.data;
  if (deliveryState === "requested") {
    throw new Error("notify compatibility send returned a non-terminal receipt");
  }
  if (deliveryState === "confirmed" && !platformMessageId?.trim()) {
    throw new Error(
      "notify compatibility send claimed confirmation without a platform message id",
    );
  }
  return deliveryState;
}

const emittedDeprecations = new Set<string>();
const MAX_DEPRECATION_KEYS = 2_000;

function emitImplicitKindDeprecation(
  input: NotifyCompatDeprecation,
): void {
  if (emittedDeprecations.has(input.eventId)) return;
  emittedDeprecations.add(input.eventId);
  if (emittedDeprecations.size > MAX_DEPRECATION_KEYS) {
    const oldest = emittedDeprecations.values().next().value;
    if (oldest) emittedDeprecations.delete(oldest);
  }
  void emitGatewayOtel({
    level: "warn",
    component: "notify-compat",
    action: "notify.compat_v2.implicit_kind",
    success: true,
    metadata: { ...input },
  });
}

/**
 * Routes the Redis envelope created by `joelclaw notify send` through the
 * contract-v2 compatibility mapper after the canonical Chat SDK transport is
 * ready. Returning handled=true tells the Redis bridge not to also prompt/send
 * through the agent lane.
 */
export const __notifyCompatTestUtils = {
  clearDeprecations(): void {
    emittedDeprecations.clear();
  },
  deprecationCount(): number {
    return emittedDeprecations.size;
  },
};

export async function routeNotifySendCompat(
  event: NotifyCompatGatewayEvent,
  dependencies: NotifyCompatRouteDependencies,
): Promise<NotifyCompatRouteResult> {
  const ready =
    dependencies.isTransportReady?.() ?? isChatSdkActingTransportReady();
  if (!ready || !isNotifySendEvent(event)) {
    return { handled: false };
  }

  const message = messageFrom(event);
  if (!message) throw new Error("notify send compatibility event has no message");
  const context = event.payload.context;
  const contextRecord =
    context && typeof context === "object"
      ? (context as Record<string, unknown>)
      : undefined;
  const replyTo = contextRecord?.replyTo;
  let intent: OutboundIntent;
  try {
    const explicitKind = kindFrom(event.payload.kind);
    const legacyPriority = priorityFrom(event.payload.priority);
    intent = mapNotifySendToIntent({
      message,
      correlationId: event.id,
      source: event.source,
      kind: explicitKind,
      priority: legacyPriority,
      telegramOnly: event.payload.telegramOnly === true,
      channel:
        typeof contextRecord?.channel === "string"
          ? contextRecord.channel
          : undefined,
      replyTo: typeof replyTo === "string" ? (replyTo as OutboundIntent["replyTo"]) : undefined,
      actions: actionsFrom(contextRecord?.actions),
    });
    if (!explicitKind) {
      const deprecation: NotifyCompatDeprecation = {
        eventId: event.id,
        source: event.source,
        legacyPriority: legacyPriority ?? "omitted",
        mappedKind: intent.kind,
        fix: `Pass --kind ${intent.kind}; --priority is deprecated and has no routing authority.`,
      };
      await Promise.resolve(
        (dependencies.emitDeprecation ?? emitImplicitKindDeprecation)(deprecation),
      ).catch(() => undefined);
    }
    const receipt = await dependencies.send(intent);
    const disposition = terminalDisposition(receipt);
    return { handled: true, intent, receipt, disposition };
  } catch (error) {
    // The adapter may have crossed the platform-send boundary before a journal
    // or index failure surfaced. Mark the event handled so the Redis bridge
    // never sends a second copy through legacy as an ambiguous fallback.
    throw new NotifyCompatDeliveryError(event.id, error);
  }
}
