import type {
  DeliveryReceiptEnvelope,
  OutboundIntent,
} from "@joelclaw/message-contract";
import { isChatSdkActingEnabled } from "../chat-sdk-inbound/acting";
import { mapNotifySendToIntent } from "./notify-compat";

export interface NotifyCompatGatewayEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly payload: Record<string, unknown>;
}

export interface NotifyCompatRouteDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTransportReady?: () => boolean;
  readonly send: (intent: OutboundIntent) => Promise<DeliveryReceiptEnvelope>;
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

export type NotifyCompatRouteResult =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly intent: OutboundIntent;
      readonly receipt: DeliveryReceiptEnvelope;
    };

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
): "low" | "normal" | "high" | "critical" | undefined {
  if (value === "urgent") return "critical";
  if (value === "low" || value === "normal" || value === "high") return value;
  return undefined;
}

/**
 * Routes the Redis envelope created by `joelclaw notify send` through the
 * contract-v2 compatibility mapper only while the acting flag is enabled.
 * Returning handled=true tells the Redis bridge not to also prompt/send via
 * the legacy path.
 */
export async function routeNotifySendCompat(
  event: NotifyCompatGatewayEvent,
  dependencies: NotifyCompatRouteDependencies,
): Promise<NotifyCompatRouteResult> {
  const ready =
    dependencies.isTransportReady?.() ?? isChatSdkActingTransportReady();
  if (
    !isChatSdkActingEnabled(dependencies.env) ||
    !ready ||
    !isNotifySendEvent(event)
  ) {
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
  const intent = mapNotifySendToIntent({
    message,
    correlationId: event.id,
    source: event.source,
    priority: priorityFrom(event.payload.priority),
    telegramOnly: event.payload.telegramOnly === true,
    channel:
      typeof contextRecord?.channel === "string"
        ? contextRecord.channel
        : undefined,
    replyTo: typeof replyTo === "string" ? (replyTo as OutboundIntent["replyTo"]) : undefined,
  });
  try {
    const receipt = await dependencies.send(intent);
    return { handled: true, intent, receipt };
  } catch (error) {
    // The adapter may have crossed the platform-send boundary before a journal
    // or index failure surfaced. Mark the event handled so the Redis bridge
    // never sends a second copy through legacy as an ambiguous fallback.
    throw new NotifyCompatDeliveryError(event.id, error);
  }
}
