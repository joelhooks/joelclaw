import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { vercelProvider } from "./vercel";

describe("vercelProvider.verifySignature", () => {
  test("returns false (does not throw) when VERCEL_WEBHOOK_SECRET is missing", () => {
    const previous = process.env.VERCEL_WEBHOOK_SECRET;
    delete process.env.VERCEL_WEBHOOK_SECRET;
    try {
      const ok = vercelProvider.verifySignature("{}", {
        "x-vercel-signature": "deadbeef",
      });
      expect(ok).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.VERCEL_WEBHOOK_SECRET;
      } else {
        process.env.VERCEL_WEBHOOK_SECRET = previous;
      }
    }
  });

  test("verifies valid HMAC-SHA1 signature", () => {
    const previous = process.env.VERCEL_WEBHOOK_SECRET;
    process.env.VERCEL_WEBHOOK_SECRET = "test-secret";
    try {
      const body = JSON.stringify({ type: "deployment.succeeded", payload: {} });
      const signature = createHmac("sha1", "test-secret").update(body).digest("hex");
      const ok = vercelProvider.verifySignature(body, {
        "x-vercel-signature": signature,
      });
      expect(ok).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.VERCEL_WEBHOOK_SECRET;
      } else {
        process.env.VERCEL_WEBHOOK_SECRET = previous;
      }
    }
  });
});
