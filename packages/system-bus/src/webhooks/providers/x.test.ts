import { describe, expect, test } from "bun:test";
import { xProvider, __xProviderTestUtils } from "./x";

function withConsumerSecret<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.X_CONSUMER_SECRET;
  if (value === undefined) {
    delete process.env.X_CONSUMER_SECRET;
  } else {
    process.env.X_CONSUMER_SECRET = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.X_CONSUMER_SECRET;
    } else {
      process.env.X_CONSUMER_SECRET = previous;
    }
  }
}

describe("xProvider.buildChallengeResponse", () => {
  test("returns response_token for CRC", () => {
    withConsumerSecret("test-secret", () => {
      const result = xProvider.buildChallengeResponse?.({ crc_token: "foo" }, {});
      expect(result?.status).toBe(200);
      expect(result?.body).toEqual({
        response_token: __xProviderTestUtils.buildSha256Base64("test-secret", "foo"),
      });
    });
  });

  test("rejects missing crc_token", () => {
    withConsumerSecret("test-secret", () => {
      const result = xProvider.buildChallengeResponse?.({}, {});
      expect(result?.status).toBe(400);
    });
  });

  test("fails closed when consumer secret is missing", () => {
    withConsumerSecret(undefined, () => {
      const result = xProvider.buildChallengeResponse?.({ crc_token: "foo" }, {});
      expect(result?.status).toBe(503);
    });
  });
});

describe("xProvider.verifySignature", () => {
  test("verifies valid x-twitter-webhooks-signature", () => {
    withConsumerSecret("test-secret", () => {
      const body = JSON.stringify({ for_user_id: "123", favorite_events: [{ id: "f1" }] });
      const signature = __xProviderTestUtils.buildSha256Base64("test-secret", body);
      expect(xProvider.verifySignature(body, { "x-twitter-webhooks-signature": signature })).toBe(true);
    });
  });

  test("rejects missing or invalid signatures", () => {
    withConsumerSecret("test-secret", () => {
      expect(xProvider.verifySignature("{}", {})).toBe(false);
      expect(xProvider.verifySignature("{}", { "x-twitter-webhooks-signature": "sha256=nope" })).toBe(false);
    });
  });
});

describe("xProvider.normalizePayload", () => {
  test("normalizes account activity payloads into one internal event", () => {
    const [event] = xProvider.normalizePayload(
      {
        for_user_id: "123",
        favorite_events: [{ id: "fav-1" }],
        users: { "123": { screen_name: "joelclaw" } },
      },
      {},
    );

    expect(event?.name).toBe("account_activity.received");
    expect(event?.data.forUserId).toBe("123");
    expect(event?.data.eventTypes).toEqual(["favorite_events"]);
    expect(event?.data.source).toBe("x-webhook");
    expect(String(event?.idempotencyKey)).toContain("favorite_events");
  });
});
