import type { InboundEvent } from "@joelclaw/message-contract";
import { loadGatewayInngestEventConfig } from "../lib/inngest-event";
import type { InboundDiffReport } from "./diff";

export const INBOUND_DIFF_EVENT_NAME = "message/inbound.diff" as const;

export type InboundBusEventName =
  | "message/inbound.message"
  | "message/inbound.command"
  | "message/inbound.interaction"
  | "message/inbound.reaction";

export interface InboundBusEnvelope {
  readonly id: string;
  readonly name: InboundBusEventName;
  readonly data: InboundEvent;
}

export interface InboundDiffBusEnvelope {
  readonly id: string;
  readonly name: typeof INBOUND_DIFF_EVENT_NAME;
  readonly data: InboundDiffReport;
}

export interface InboundBusClient {
  readonly send: (
    event: InboundBusEnvelope | InboundDiffBusEnvelope,
  ) => Promise<unknown>;
}

export interface GatewayInboundBusClientOptions {
  readonly eventApi?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createGatewayInboundBusClient(
  options: GatewayInboundBusClientOptions = {},
): InboundBusClient {
  return {
    async send(event): Promise<void> {
      const eventApi = options.eventApi ?? loadGatewayInngestEventConfig()?.eventApi;
      if (!eventApi) {
        throw new Error("Inngest event config missing for inbound shadow publish");
      }
      const response = await (options.fetchFn ?? fetch)(eventApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        throw new Error(`Inngest event API returned HTTP ${response.status}`);
      }
    },
  };
}

export function inboundBusEventName(event: InboundEvent): InboundBusEventName {
  return `message/inbound.${event.type}`;
}

function assertObserveOnly(event: InboundEvent): void {
  if (event.shadow !== true || event.authorization.canExecute !== false) {
    throw new Error("Inbound shadow publisher refuses executable events");
  }
  if (event.authorization.canPublish !== true) {
    throw new Error("Inbound event is not authorized for observe-only publication");
  }
}

export function createObserveOnlyInboundPublisher(client: InboundBusClient) {
  return {
    publishEvent: async (event: InboundEvent): Promise<void> => {
      assertObserveOnly(event);
      await client.send({
        id: event.eventId,
        name: inboundBusEventName(event),
        data: event,
      });
    },
    publishDiff: async (report: InboundDiffReport): Promise<void> => {
      if (report.shadow !== true || report.sdk.actualActed !== false) {
        throw new Error("Inbound shadow publisher refuses an acting diff report");
      }
      await client.send({
        id: report.reportId,
        name: INBOUND_DIFF_EVENT_NAME,
        data: report,
      });
    },
  };
}

export type ObserveOnlyInboundPublisher = ReturnType<
  typeof createObserveOnlyInboundPublisher
>;
