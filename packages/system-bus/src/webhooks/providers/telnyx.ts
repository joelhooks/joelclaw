import { createPublicKey, verify } from "node:crypto";
import type { NormalizedEvent, WebhookProvider } from "../types";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const EVENT_TYPES = new Set(["call.initiated", "call.answered", "call.hangup"]);
let warnedMissingKey = false;

export const telnyxProvider: WebhookProvider = {
  id: "telnyx",
  eventPrefix: "telnyx",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["telnyx-signature-ed25519"];
    const timestamp = headers["telnyx-timestamp"];
    const publicKey = process.env.TELNYX_PUBLIC_KEY?.trim();
    if (!publicKey) {
      if (!warnedMissingKey) {
        console.warn("[telnyx-webhook] TELNYX_PUBLIC_KEY not set — rejecting all inbound webhooks");
        warnedMissingKey = true;
      }
      return false;
    }
    if (!signature || !timestamp) return false;

    try {
      const rawKey = Buffer.from(publicKey, "base64");
      if (rawKey.length !== 32) return false;
      const key = createPublicKey({
        key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]),
        format: "der",
        type: "spki",
      });
      return verify(
        null,
        Buffer.from(`${timestamp}|${rawBody}`),
        key,
        Buffer.from(signature, "base64"),
      );
    } catch {
      return false;
    }
  },

  normalizePayload(body: Record<string, unknown>): NormalizedEvent[] {
    const data = body.data;
    if (!data || typeof data !== "object") return [];
    const envelope = data as Record<string, unknown>;
    const eventType = String(envelope.event_type ?? "");
    if (!EVENT_TYPES.has(eventType)) return [];
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as Record<string, unknown>)
        : {};
    const id = String(envelope.id ?? payload.call_control_id ?? payload.call_session_id ?? "unknown");
    return [{
      name: eventType,
      data: payload,
      idempotencyKey: `telnyx-${eventType}-${id}`,
    }];
  },
};
