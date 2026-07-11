import { Hono } from "hono";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const bodylessMethods = new Set(["GET", "HEAD"]);

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

export const createApp = (options: {
  origin?: string;
  fetch?: Fetch;
} = {}) => {
  const app = new Hono();
  const fetchUpstream = options.fetch ?? globalThis.fetch;

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "joelclaw-webhook-ingress",
    }),
  );

  app.all("/webhooks/:provider", async (c) => {
    const configuredOrigin = options.origin ?? process.env.WEBHOOK_ORIGIN_URL?.trim();
    if (!configuredOrigin) {
      return c.json({ ok: false, error: "webhook origin is not configured" }, 503);
    }

    const incoming = c.req.raw;
    const upstreamUrl = new URL(
      `${normalizeOrigin(configuredOrigin)}${c.req.path}${new URL(incoming.url).search}`,
    );
    const headers = new Headers(incoming.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("x-joelclaw-webhook-ingress", "hooks.joelclaw.com");

    const body = bodylessMethods.has(incoming.method) ? undefined : await incoming.arrayBuffer();
    const provider = c.req.param("provider");

    console.info("[webhook-ingress] forwarding", {
      provider,
      method: incoming.method,
      bodyBytes: body?.byteLength ?? 0,
      hasFrontSignature: headers.has("x-front-signature"),
      hasFrontChallenge: headers.has("x-front-challenge"),
      hasFrontTimestamp: headers.has("x-front-request-timestamp"),
    });

    const response = await fetchUpstream(upstreamUrl, {
      method: incoming.method,
      headers,
      body,
      redirect: "manual",
    });

    console.info("[webhook-ingress] forwarded", {
      provider,
      upstreamStatus: response.status,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  });

  app.notFound((c) => c.json({ ok: false, error: "not found" }, 404));

  return app;
};
