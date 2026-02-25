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
import { getRedisClient } from "../../lib/redis";
import { pushGatewayEvent } from "../functions/agent-loop/utils";

export type GatewayPushResult = {
  pushed: boolean;
  queued?: boolean;
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
   * If you don't want to notify, don't call notify.
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

const SYSTEM_SLEEP_KEY = "system:sleep";
const SLEEP_QUEUE_KEY = "sleep:queue";
const MAX_SLEEP_SUMMARY_LENGTH = 220;

type GatewayPayload = Record<string, unknown>;

function firstStringField(payload: GatewayPayload, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function truncateSummary(text: string): string {
  if (text.length <= MAX_SLEEP_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_SLEEP_SUMMARY_LENGTH - 1)}…`;
}

function payloadSummary(payload: GatewayPayload): string {
  const direct = firstStringField(payload, ["summary", "message", "prompt", "text", "title", "subject", "detail"]);
  if (direct) return truncateSummary(direct);

  try {
    const serialized = JSON.stringify(payload);
    if (!serialized || serialized === "{}") return "";
    return truncateSummary(serialized);
  } catch {
    return "";
  }
}

function buildSleepQueueSummary(eventName: string, payload: GatewayPayload): string {
  const summary = payloadSummary(payload);
  if (!summary) return eventName;
  return truncateSummary(`${eventName}: ${summary}`);
}

function isJoelDirectMessage(eventName: string, payload: GatewayPayload): boolean {
  if (
    eventName.startsWith("telegram/") ||
    eventName.startsWith("telegram.") ||
    eventName.startsWith("discord/") ||
    eventName.startsWith("discord.")
  ) {
    return true;
  }

  const originSession = typeof payload.originSession === "string" ? payload.originSession : "";
  if (originSession.startsWith("telegram:") || originSession.startsWith("discord:")) {
    return true;
  }

  const source = typeof payload.source === "string" ? payload.source : "";
  return source.startsWith("telegram") || source.startsWith("discord");
}

function isSleepPassthroughEvent(eventName: string, payload: GatewayPayload): boolean {
  if (eventName === "alert") return true;

  if (eventName.startsWith("vip/") || eventName.startsWith("vip.")) return true;

  if (
    eventName === "deploy.failed" ||
    eventName.endsWith("deploy.failed") ||
    (eventName.includes("deploy") && (eventName.includes("failed") || eventName.includes("error")))
  ) {
    return true;
  }

  if (eventName === "system/health.alert" || eventName.startsWith("system/health.alert")) return true;

  return isJoelDirectMessage(eventName, payload);
}

async function shouldDeliverGatewayEvent(eventName: string, payload: GatewayPayload): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const sleepState = await redis.get(SYSTEM_SLEEP_KEY);
    if (!sleepState) return true;

    if (isSleepPassthroughEvent(eventName, payload)) return true;

    await redis.rpush(
      SLEEP_QUEUE_KEY,
      JSON.stringify({
        event: eventName,
        timestamp: new Date().toISOString(),
        summary: buildSleepQueueSummary(eventName, payload),
      })
    );

    return false;
  } catch (err) {
    console.warn(`[gateway-middleware] sleep gate check failed: ${err}`);
    return true;
  }
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
              const eventPayload = { message, ...extra };
              const deliver = await shouldDeliverGatewayEvent("progress", {
                ...eventPayload,
                originSession,
              });
              if (!deliver) {
                return { pushed: false, queued: true, type: "progress", originSession };
              }

              const event = await pushGatewayEvent({
                type: "progress",
                source,
                payload: eventPayload,
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
              const eventPayload = payload ?? {};
              const deliver = await shouldDeliverGatewayEvent(type, {
                ...eventPayload,
                originSession,
              });
              if (!deliver) {
                return { pushed: false, queued: true, type, originSession };
              }

              const event = await pushGatewayEvent({
                type,
                source,
                payload: eventPayload,
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
              const eventPayload = { message, ...extra };
              const deliver = await shouldDeliverGatewayEvent("alert", eventPayload);
              if (!deliver) {
                return { pushed: false, queued: true, type: "alert" };
              }

              const event = await pushGatewayEvent({
                type: "alert",
                source,
                payload: eventPayload,
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
