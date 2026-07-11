import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("webhook ingress", () => {
  test("reports health without contacting the origin", async () => {
    const app = createApp({
      fetch: async () => {
        throw new Error("unexpected upstream request");
      },
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "joelclaw-webhook-ingress",
    });
  });

  test("preserves raw body, signature header, path, and query", async () => {
    let forwardedRequest: Request | undefined;
    const app = createApp({
      origin: "https://central.example:10000",
      fetch: async (input, init) => {
        forwardedRequest = new Request(input, init);
        return new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const body = '{"message":"byte-for-byte"}';

    const response = await app.request("/webhooks/front?source=rule", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-front-signature": "signed-value",
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(forwardedRequest?.url).toBe(
      "https://central.example:10000/webhooks/front?source=rule",
    );
    expect(forwardedRequest?.headers.get("x-front-signature")).toBe("signed-value");
    expect(forwardedRequest?.headers.get("x-joelclaw-webhook-ingress")).toBe(
      "hooks.joelclaw.com",
    );
    expect(await forwardedRequest?.text()).toBe(body);
  });

  test("does not become an open proxy", async () => {
    const app = createApp({ origin: "https://central.example" });

    const response = await app.request("/api/runs", { method: "POST" });

    expect(response.status).toBe(404);
  });

  test("fails closed when the origin is missing", async () => {
    const app = createApp();

    const response = await app.request("/webhooks/front", { method: "POST" });

    expect(response.status).toBe(503);
  });
});
