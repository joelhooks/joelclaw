import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { telnyxProvider } from "./telnyx";

function withPublicKey<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.TELNYX_PUBLIC_KEY;
  if (value === undefined) delete process.env.TELNYX_PUBLIC_KEY;
  else process.env.TELNYX_PUBLIC_KEY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = previous;
  }
}

describe("telnyxProvider.verifySignature", () => {
  test("accepts a valid Ed25519 signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const body = JSON.stringify({ data: { event_type: "call.initiated", payload: {} } });
    const timestamp = "1720000000";
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
    expect(withPublicKey(rawPublicKey, () => telnyxProvider.verifySignature(body, {
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    }))).toBe(true);
  });

  test("rejects an invalid signature", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    expect(withPublicKey(rawPublicKey, () => telnyxProvider.verifySignature("{}", {
      "telnyx-signature-ed25519": Buffer.alloc(64).toString("base64"),
      "telnyx-timestamp": "1720000000",
    }))).toBe(false);
  });

  test("rejects when TELNYX_PUBLIC_KEY is missing", () => {
    expect(withPublicKey(undefined, () => telnyxProvider.verifySignature("{}", {
      "telnyx-signature-ed25519": "bad",
      "telnyx-timestamp": "1720000000",
    }))).toBe(false);
  });
});

describe("telnyxProvider.normalizePayload", () => {
  test("maps supported call events and carries payload data", () => {
    for (const eventType of ["call.initiated", "call.answered", "call.hangup"]) {
      const [event] = telnyxProvider.normalizePayload({
        data: {
          id: `event-${eventType}`,
          event_type: eventType,
          payload: { call_session_id: "session-1", direction: "incoming" },
        },
      }, {});
      expect(event?.name).toBe(eventType);
      expect(event?.data.call_session_id).toBe("session-1");
    }
  });

  test("maps inbound SMS (message.received) with message id idempotency", () => {
    const [event] = telnyxProvider.normalizePayload({
      data: {
        id: "msg-event-1",
        event_type: "message.received",
        payload: { id: "msg-1", from: { phone_number: "+15555550100" }, text: "hi shitrat" },
      },
    }, {});
    expect(event?.name).toBe("message.received");
    expect(event?.data.text).toBe("hi shitrat");
    expect(event?.idempotencyKey).toBe("telnyx-message.received-msg-event-1");
  });

  test("ignores unsupported events", () => {
    expect(telnyxProvider.normalizePayload({
      data: { event_type: "call.bridged", payload: {} },
    }, {})).toEqual([]);
  });
});
