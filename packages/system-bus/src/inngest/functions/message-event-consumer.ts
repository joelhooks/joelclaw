import { NonRetriableError } from "inngest";
import {
  getMessageEventLogClient,
  type MaterializeMessageEventReceipt,
  MESSAGE_EVENT_CONSUME_REQUESTED,
  type MessageEventDocument,
} from "@joelclaw/message-event-log";
import { createDependencyFailureLatch } from "../../lib/dependency-latch";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const MESSAGE_EVENT_DEPENDENCY_LATCH_MS = 5 * 60_000;
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function dependencyUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const value = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      status?: unknown;
    };
    if (typeof value.code === "string" && UNAVAILABLE_CODES.has(value.code)) return true;
    if (typeof value.status === "number" && [502, 503, 504].includes(value.status)) return true;
    if (
      typeof value.message === "string" &&
      /(?:fetch failed|connection refused|connection reset|connect timeout|network is unreachable|host is unreachable)/iu.test(
        value.message,
      )
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}
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
  const dependencyLatch = createDependencyFailureLatch({
    cooldownMs: MESSAGE_EVENT_DEPENDENCY_LATCH_MS,
  });

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
      const runDependency = async <T>(
        operation: "pending" | "materialize",
        run: () => Promise<T>,
      ): Promise<T> => {
        const active = dependencyLatch.read();
        if (active._tag === "Open") {
          throw new NonRetriableError(
            `message-event-log dependency latched until ${new Date(active.retryAtMs).toISOString()} (${active.reason})`,
          );
        }

        try {
          const result = await run();
          dependencyLatch.reset();
          return result;
        } catch (error) {
          if (!dependencyUnavailable(error)) throw error;
          const opened = dependencyLatch.trip(`Convex ${operation} unavailable`);
          try {
            await dependencies.emit({
              level: "error",
              source: "worker",
              component: "message-event-consumer",
              action: "message.event.dependency_unavailable",
              success: false,
              error: "convex_unavailable",
              metadata: {
                dependency: "convex",
                operation,
                retryAt: new Date(opened.retryAtMs).toISOString(),
              },
            });
          } catch {
            // Preserve the non-retriable dependency failure if telemetry is also unavailable.
          }
          throw new NonRetriableError(
            `message-event-log dependency unavailable during ${operation}; latched until ${new Date(opened.retryAtMs).toISOString()}`,
          );
        }
      };
      const pending = await step.run("load-pending-message-events", () =>
        runDependency("pending", () => dependencies.pending(50)));
      const results: MaterializeMessageEventReceipt[] = [];

      for (const messageEvent of pending) {
        const inngestEventId = `${event.id ?? "cron"}:${messageEvent._id}`;
        const result = await step.run(
          `materialize-message-event-${messageEvent._id}`,
          () => runDependency("materialize", () => dependencies.materialize({
            eventId: messageEvent._id,
            inngestEventId,
          })),
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
