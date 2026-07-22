import {
  getMessageEventLogClient,
  type MaterializeMessageEventReceipt,
  MESSAGE_EVENT_CONSUME_REQUESTED,
  type MessageEventDocument,
} from "@joelclaw/message-event-log";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export type MessageEventConsumerDependencies = {
  pending: (limit?: number) => Promise<MessageEventDocument[]>;
  materialize: (input: {
    eventId: string;
    inngestEventId: string;
  }) => Promise<MaterializeMessageEventReceipt>;
  emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
};

const defaultDependencies: MessageEventConsumerDependencies = {
  pending: (limit) => getMessageEventLogClient().pending(limit),
  materialize: (input) => getMessageEventLogClient().materialize(input),
  emit: emitOtelEvent,
};

export function createMessageEventConsumerFunction(
  dependencies: MessageEventConsumerDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "message/event-consumer",
      name: "Materialize Message Event Views",
      concurrency: { limit: 1, key: '"message-event-log"' },
    },
    [
      { event: MESSAGE_EVENT_CONSUME_REQUESTED },
      { cron: "* * * * *" },
    ],
    async ({ event, step }) => {
      const pending = await step.run("load-pending-message-events", () =>
        dependencies.pending(50));
      const results: MaterializeMessageEventReceipt[] = [];

      for (const messageEvent of pending) {
        const inngestEventId = `${event.id ?? "cron"}:${messageEvent._id}`;
        const result = await step.run(
          `materialize-message-event-${messageEvent._id}`,
          () => dependencies.materialize({
            eventId: messageEvent._id,
            inngestEventId,
          }),
        );
        results.push(result);

        await step.run(`emit-message-event-receipt-${messageEvent._id}`, () =>
          dependencies.emit({
            level: "info",
            source: "worker",
            component: "message-event-consumer",
            action: result.deduplicated
              ? "message.event.replay_deduplicated"
              : "message.event.materialized",
            success: true,
            metadata: {
              eventId: messageEvent._id,
              semanticKey: messageEvent.semanticKey,
              flowId: messageEvent.flowId ?? null,
              kind: messageEvent.kind,
              schemaVersion: messageEvent.schemaVersion,
              deduplicated: result.deduplicated,
              flowView: result.flowView,
              platformView: result.platformView,
              terminalView: result.terminalView,
              actionView: result.actionView,
            },
          }));
      }

      return {
        scanned: pending.length,
        materialized: results.filter((result) => !result.deduplicated).length,
        deduplicated: results.filter((result) => result.deduplicated).length,
        eventIds: results.map((result) => result.eventId),
      };
    },
  );
}

export const messageEventConsumer = createMessageEventConsumerFunction();
