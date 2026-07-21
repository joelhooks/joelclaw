import type { MessageEventDocument } from "@joelclaw/message-event-log";

/**
 * Mechanical executor for recorded gateway deliver decisions. The agent has
 * already decided whether, what, and why — the transport only executes the
 * receipt. Anything that is not a deliver decision advances past this
 * consumer untouched; the gateway agent's own cursor governs judgment.
 */

export const EXECUTOR_CONSUMER = "gateway-transport-executor" as const;

export interface DeliverExecutorEventLog {
  readonly pendingForConsumer: (
    consumer: string,
    limit: number,
  ) => Promise<MessageEventDocument[]>;
  readonly advanceCursor: (
    consumer: string,
    eventId: string,
  ) => Promise<unknown>;
}

export interface DeliverExecutorDependencies {
  readonly eventLog: DeliverExecutorEventLog;
  readonly recipientId: string;
  readonly send: (request: {
    target: { platform: "telegram"; recipientId: string };
    content: { raw: string };
    text: string;
    flowId: string;
    origin: { machineId: string; producer: string };
    correlationId?: string;
  }) => Promise<{ platformMessageId: string }>;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

interface DeliverDecisionPayload {
  readonly decision?: {
    readonly verb?: string;
    readonly action?: string;
    readonly platform?: string;
  };
  readonly rewrite?: string;
  readonly reason?: string;
}

const asDeliverText = (payload: DeliverDecisionPayload): string | null => {
  const text = typeof payload.rewrite === "string" ? payload.rewrite.trim() : "";
  return text.length > 0 ? text : null;
};

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
        (decision?.verb === "aggregate" && decision?.action === "close-deliver"));
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
    await dependencies.send({
      target: { platform: "telegram", recipientId: dependencies.recipientId },
      content: { raw: text },
      text,
      flowId: event.flowId ?? `decision:${event._id}`,
      origin: { machineId: event.origin?.machineId ?? "flagg", producer: "gateway-transport-executor" },
      correlationId: event._id,
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
