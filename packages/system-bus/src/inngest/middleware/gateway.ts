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

export interface GatewayContext {
  /**
   * Push a progress update to the originating session + central gateway.
   * Use at intelligent waypoints: story start/pass/fail, retry escalation, merge, etc.
   */
  progress: (message: string, extra?: Record<string, unknown>) => Promise<void>;

  /**
   * Push a notification (non-progress event) to origin + gateway.
   * Use for task completions, downloads finished, etc.
   */
  notify: (type: string, payload?: Record<string, unknown>) => Promise<void>;

  /**
   * Push an alert to the central gateway only (no origin routing).
   * Use for system-level warnings: disk space, service degradation, etc.
   */
  alert: (message: string, extra?: Record<string, unknown>) => Promise<void>;

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
              await pushGatewayEvent({
                type: "progress",
                source,
                payload: { message, ...extra },
                originSession,
              });
            } catch (err) {
              console.warn(`[gateway-middleware] progress push failed: ${err}`);
            }
          },

          async notify(type: string, payload?: Record<string, unknown>) {
            try {
              await pushGatewayEvent({
                type,
                source,
                payload: payload ?? {},
                originSession,
              });
            } catch (err) {
              console.warn(`[gateway-middleware] notify push failed: ${err}`);
            }
          },

          async alert(message: string, extra?: Record<string, unknown>) {
            try {
              // Alerts go to gateway only (no originSession)
              await pushGatewayEvent({
                type: "alert",
                source,
                payload: { message, ...extra },
              });
            } catch (err) {
              console.warn(`[gateway-middleware] alert push failed: ${err}`);
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
