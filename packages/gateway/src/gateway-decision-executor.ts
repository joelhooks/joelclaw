import type {
  GatewayTargetIntent,
  MessageEventDocument,
  MessagePlatform,
} from "@joelclaw/message-event-log";

/**
 * Mechanical executor for recorded gateway deliver decisions. The agent has
 * already decided whether, what, and why — the transport only executes the
 * receipt. Anything that is not a deliver decision advances past this
 * consumer untouched; the gateway agent's own cursor governs judgment.
 */

export const EXECUTOR_CONSUMER = "gateway-transport-executor" as const;

export interface DeliverExecutorEventLog {
  readonly pendingForConsumer: (consumer: string, limit: number) => Promise<MessageEventDocument[]>;
  readonly advanceCursor: (consumer: string, eventId: string) => Promise<unknown>;
}

export interface DeliverExecutorDependencies {
  readonly eventLog: DeliverExecutorEventLog;
  readonly recipientId: string;
  readonly send: (request: {
    target: { platform: MessagePlatform; recipientId: string };
    content: { raw: string };
    text: string;
    flowId: string;
    origin: { machineId: string; producer: string };
    correlationId?: string;
    replyThreadId?: string;
  }) => Promise<{ platformMessageId: string }>;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

interface DeliverDecisionPayload {
  readonly decision?: {
    readonly verb?: string;
    readonly action?: string;
    readonly delivery?: string;
    readonly platform?: string;
    readonly rewrite?: string;
    readonly target?: GatewayTargetIntent;
  };
  readonly rewrite?: string;
  readonly reason?: string;
}

// The plugin validator requires the rewrite at the top level, but four real
// close-delivers on cutover day carried their text on `decision.rewrite` only
// and were never sent. Read either place: a message Joel should have received
// is worth more than schema purity about where the agent put it.
const asDeliverText = (payload: DeliverDecisionPayload): string | null => {
  for (const candidate of [payload.rewrite, payload.decision?.rewrite]) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (text.length > 0) return text;
  }
  return null;
};

function deliveryTarget(
  decision: DeliverDecisionPayload["decision"],
  defaultRecipientId: string,
): {
  target: { platform: MessagePlatform; recipientId: string };
  replyThreadId?: string;
} {
  const target = decision?.target;
  if (target?.kind !== "platform") {
    if (!defaultRecipientId) throw new Error("Telegram deliver target requires recipientId");
    return {
      target: { platform: "telegram", recipientId: defaultRecipientId },
    };
  }
  const conversationId = target.conversationId?.trim();
  if (target.platform === "telegram" && !conversationId) {
    if (!defaultRecipientId) throw new Error("Telegram deliver target requires recipientId");
    return {
      target: { platform: "telegram", recipientId: defaultRecipientId },
    };
  }
  if (!conversationId) {
    throw new Error(`${target.platform} deliver target requires conversationId`);
  }
  const threadId = target.threadId?.trim();
  if (target.platform !== "telegram" && !threadId) {
    throw new Error(`${target.platform} deliver target requires threadId`);
  }
  return {
    target: { platform: target.platform, recipientId: conversationId },
    ...(threadId ? { replyThreadId: threadId } : {}),
  };
}

export async function drainDeliverDecisions(
  dependencies: DeliverExecutorDependencies,
): Promise<{ executed: number; skipped: number }> {
  const log = dependencies.log ?? (() => {});
  let executed = 0;
  let skipped = 0;
  const pending = await dependencies.eventLog.pendingForConsumer(EXECUTOR_CONSUMER, 50);
  for (const event of pending) {
    const payload = event.payload as DeliverDecisionPayload;
    const decision = payload?.decision;
    const isDeliver =
      event.kind === "gateway.decision.recorded" &&
      (decision?.verb === "deliver" ||
        (decision?.verb === "aggregate" &&
          (decision?.action === "close-deliver" || decision?.delivery === "immediate")));
    if (!isDeliver) {
      skipped += 1;
      await dependencies.eventLog.advanceCursor(EXECUTOR_CONSUMER, event._id);
      continue;
    }
    const text = asDeliverText(payload);
    if (!text) {
      // Unhandled-work receipt: a deliver decision without deliverable text is
      // the agent's defect to hear about, never a silent skip.
      log("[gateway:executor] deliver decision without rewrite text", {
        eventId: event._id,
        flowId: event.flowId,
      });
      skipped += 1;
      await dependencies.eventLog.advanceCursor(EXECUTOR_CONSUMER, event._id);
      continue;
    }
    // Execute, then advance. A crash between the two re-executes on the next
    // drain; the explicit sender's flowId-keyed receipts make the duplicate
    // visible, and a rare duplicate beats a silent gap (fallback doctrine).
    const resolvedTarget = deliveryTarget(decision, dependencies.recipientId);
    await dependencies.send({
      ...resolvedTarget,
      content: { raw: text },
      text,
      flowId: event.flowId ?? `decision:${event._id}`,
      origin: {
        machineId: event.origin?.machineId ?? "flagg",
        producer: "gateway-transport-executor",
      },
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    });
    executed += 1;
    log("[gateway:executor] executed deliver decision", {
      eventId: event._id,
      flowId: event.flowId,
    });
    await dependencies.eventLog.advanceCursor(EXECUTOR_CONSUMER, event._id);
  }
  return { executed, skipped };
}
