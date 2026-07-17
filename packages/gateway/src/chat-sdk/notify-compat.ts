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
}

function inferKind(input: NotifySendCompatInput): MessageKindType {
  if (input.kind) return input.kind;
  const source = input.source?.toLowerCase() ?? "";
  if (source.includes("memory")) return "memory";
  if (source.includes("ask") || source.includes("approval")) return "ask";
  if (source.includes("receipt")) return "receipt";
  if (
    source.includes("digest") ||
    input.priority === "low" ||
    input.priority === "normal" ||
    input.priority === undefined
  ) {
    return "digest";
  }
  return "alert";
}

/**
 * Migration-only shape adapter for `joelclaw notify send` callers. Channel
 * flags are accepted but intentionally do not escape into contract v2 routing.
 */
export function mapNotifySendToIntent(input: NotifySendCompatInput): OutboundIntent {
  const intent: OutboundIntent = {
    contractVersion: MESSAGE_CONTRACT_VERSION,
    kind: inferKind(input),
    content: input.message,
    correlationId: input.source
      ? `${input.source}:${input.correlationId}`
      : input.correlationId,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
  return intent;
}
