import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { frontProvider } from "./front";

const priorRulesSecret = process.env.FRONT_RULES_WEBHOOK_SECRET;
const priorApplicationSecret = process.env.FRONT_APPLICATION_SECRET;

afterEach(() => {
  if (priorRulesSecret === undefined) delete process.env.FRONT_RULES_WEBHOOK_SECRET;
  else process.env.FRONT_RULES_WEBHOOK_SECRET = priorRulesSecret;

  if (priorApplicationSecret === undefined) delete process.env.FRONT_APPLICATION_SECRET;
  else process.env.FRONT_APPLICATION_SECRET = priorApplicationSecret;
});

describe("Front webhook signatures", () => {
  test("verifies rules webhooks with the API secret and SHA1", () => {
    process.env.FRONT_RULES_WEBHOOK_SECRET = "rules-secret";
    const rawBody = JSON.stringify({ type: "inbound", id: "evt_123" });
    const signature = createHmac("sha1", "rules-secret").update(rawBody).digest("base64");

    expect(frontProvider.verifySignature(rawBody, { "x-front-signature": signature })).toBe(true);
  });

  test("verifies application webhooks with timestamp, application secret, and SHA256", () => {
    process.env.FRONT_APPLICATION_SECRET = "application-secret";
    const rawBody = JSON.stringify({ type: "sync", authorization: { id: "cmp_123" } });
    const timestamp = "1783700793";
    const signature = createHmac("sha256", "application-secret")
      .update(`${timestamp}:${rawBody}`)
      .digest("base64");

    expect(frontProvider.verifySignature(rawBody, {
      "x-front-signature": signature,
      "x-front-request-timestamp": timestamp,
    })).toBe(true);
  });
});
