import type {
  MessageKindType,
  OutboundIntent,
} from "@joelclaw/message-contract";
import { MESSAGE_CONTRACT_VERSION } from "@joelclaw/message-contract";

export interface NotifySendCompatInput {
  readonly message: string;
  readonly correlationId: string;
  readonly source?: string;
  readonly priority?: "low" | "normal" | "high" | "urgent" | "critical";
  readonly telegramOnly?: boolean;
  readonly channel?: string;
  readonly kind?: MessageKindType;
  readonly replyTo?: OutboundIntent["replyTo"];
  readonly actions?: OutboundIntent["actions"];
}

export type LegacyNotifyPriority = NonNullable<NotifySendCompatInput["priority"]>;

export function compatibilityKindForPriority(
  priority: LegacyNotifyPriority | undefined,
): MessageKindType {
  if (priority === "low") return "digest";
  if (priority === "high" || priority === "urgent" || priority === "critical") {
    return "alert";
  }
  return "memory";
}

/**
 * Migration-only shape adapter for `joelclaw notify send` callers. Channel
 * flags are accepted but intentionally do not escape into contract v2 routing.
 */
export function mapNotifySendToIntent(input: NotifySendCompatInput): OutboundIntent {
  const intent: OutboundIntent = {
    contractVersion: MESSAGE_CONTRACT_VERSION,
    kind: input.kind ?? compatibilityKindForPriority(input.priority),
    content: input.message,
    correlationId: input.source
      ? `${input.source}:${input.correlationId}`
      : input.correlationId,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
  };
  return intent;
}
