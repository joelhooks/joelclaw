import {
  type ChannelAuditSeed,
  type ChannelDeliveryAudit,
  createChannelDeliveryAudit,
} from "@joelclaw/telemetry";

export type GatewaySendMessageData = {
  channel?: string;
  text: string;
  inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
  edit_message_id?: number;
  remove_keyboard?: boolean;
  media_url?: string;
  media_path?: string;
  mime_type?: string;
  caption?: string;
  audit?: ChannelAuditSeed;
};

export type QueuedGatewayMessage = Omit<GatewaySendMessageData, "audit"> & {
  channel: string;
  audit: ChannelDeliveryAudit;
  ts: string;
};

export function buildQueuedGatewayMessage(
  data: GatewaySendMessageData,
  eventContext: { eventId?: string; eventTimestampMs?: number },
  queuedAtMs = Date.now(),
): QueuedGatewayMessage {
  const content = data.caption ?? data.text ?? "";
  const audit = createChannelDeliveryAudit(content, {
    ...data.audit,
    flowId: data.audit?.flowId ?? (eventContext.eventId ? `inngest:${eventContext.eventId}` : undefined),
    producer: data.audit?.producer ?? "gateway/send.message",
    eventId: data.audit?.eventId ?? eventContext.eventId,
    requestedAtMs: data.audit?.requestedAtMs ?? eventContext.eventTimestampMs ?? queuedAtMs,
    queuedAtMs,
  }, queuedAtMs);

  return {
    channel: data.channel ?? "telegram",
    text: data.text,
    inline_keyboard: data.inline_keyboard,
    edit_message_id: data.edit_message_id,
    remove_keyboard: data.remove_keyboard,
    media_url: data.media_url,
    media_path: data.media_path,
    mime_type: data.mime_type,
    caption: data.caption,
    audit,
    ts: new Date(queuedAtMs).toISOString(),
  };
}
