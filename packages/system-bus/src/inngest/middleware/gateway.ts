/**
 * Gateway Middleware — injects ctx.gateway into every Inngest function.
 *
 * ADR-0035: Provides a clean SDK for functions to push progress events
 * to originating pi sessions without importing pushGatewayEvent directly.
 *
 * Usage in any function:
 *   async ({ event, step, gateway }) => {
 *     gateway.progress("Story 3/8 started: Implement auth");
 *     gateway.notify("Video download complete", { url: "..." });
 *     gateway.alert("Disk space low: 2GB remaining");
 *   }
 */

import { InngestMiddleware } from "inngest";
import { pushGatewayEvent } from "../functions/agent-loop/utils";

export type GatewayPushResult = {
  pushed: boolean;
  eventId?: string;
  type: string;
  originSession?: string;
  error?: string;
};

export interface GatewayContext {
  /**
   * Push a progress update to the originating session + central gateway.
   * Use at intelligent waypoints: story start/pass/fail, retry escalation, merge, etc.
   */
  progress: (message: string, extra?: Record<string, unknown>) => Promise<GatewayPushResult>;

  /**
   * Push a notification (non-progress event) to origin + gateway.
   * Use for task completions, downloads finished, etc.
   */
  notify: (type: string, payload?: Record<string, unknown>) => Promise<GatewayPushResult>;

  /**
   * Push an alert to the central gateway only (no origin routing).
   * Use for system-level warnings: disk space, service degradation, etc.
   */
  alert: (message: string, extra?: Record<string, unknown>) => Promise<GatewayPushResult>;

  /** The origin session ID (if set on the triggering event). */
  originSession: string | undefined;
}

export const gatewayMiddleware = new InngestMiddleware({
  name: "Gateway SDK",
  init() {
    return {
      onFunctionRun({ ctx }) {
        // Extract originSession from event data (carried through the pipeline)
        const eventData = ctx.event?.data as Record<string, unknown> | undefined;
        const originSession = (eventData?.originSession as string) ?? undefined;
        const source = `inngest/${ctx.event?.name ?? "unknown"}`;

        const gateway: GatewayContext = {
          originSession,

          async progress(message: string, extra?: Record<string, unknown>) {
            try {
              const event = await pushGatewayEvent({
                type: "progress",
                source,
                payload: { message, ...extra },
                originSession,
              });
              return { pushed: true, eventId: event.id, type: "progress", originSession };
            } catch (err) {
              console.warn(`[gateway-middleware] progress push failed: ${err}`);
              return { pushed: false, error: String(err), type: "progress" };
            }
          },

          async notify(type: string, payload?: Record<string, unknown>) {
            try {
              const event = await pushGatewayEvent({
                type,
                source,
                payload: payload ?? {},
                originSession,
              });
              return { pushed: true, eventId: event.id, type, originSession };
            } catch (err) {
              console.warn(`[gateway-middleware] notify push failed: ${err}`);
              return { pushed: false, error: String(err), type };
            }
          },

          async alert(message: string, extra?: Record<string, unknown>) {
            try {
              const event = await pushGatewayEvent({
                type: "alert",
                source,
                payload: { message, ...extra },
              });
              return { pushed: true, eventId: event.id, type: "alert" };
            } catch (err) {
              console.warn(`[gateway-middleware] alert push failed: ${err}`);
              return { pushed: false, error: String(err), type: "alert" };
            }
          },
        };

        return {
          transformInput({ ctx: inputCtx }) {
            return {
              ctx: { ...inputCtx, gateway },
            };
          },
        };
      },
    };
  },
});
