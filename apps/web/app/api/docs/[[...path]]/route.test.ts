import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { proxyToUpstream } from "./proxy";

const originalUpstream = process.env.DOCS_API_UPSTREAM_URL;

function restoreUpstream(): void {
  if (originalUpstream === undefined) {
    delete process.env.DOCS_API_UPSTREAM_URL;
  } else {
    process.env.DOCS_API_UPSTREAM_URL = originalUpstream;
  }
}

afterEach(restoreUpstream);

describe("docs API proxy failures", () => {
  test("returns a structured 503 when the upstream is missing", async () => {
    delete process.env.DOCS_API_UPSTREAM_URL;
    let called = false;

    const response = await proxyToUpstream(
      new NextRequest("https://joelclaw.com/api/docs/health"),
      ["health"],
      async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      error?: { code?: string; details?: { retryable?: boolean } };
    };

    assert.equal(called, false);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "DOCS_API_UPSTREAM_UNCONFIGURED");
    assert.equal(body.error?.details?.retryable, false);
  });

  test("returns a structured 502 when the configured upstream cannot be reached", async () => {
    process.env.DOCS_API_UPSTREAM_URL = "https://docs.example.test/api/docs";

    const response = await proxyToUpstream(
      new NextRequest("https://joelclaw.com/api/docs/search?q=effect"),
      ["search"],
      async () => {
        throw new Error("getaddrinfo ENOTFOUND docs.example.test");
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string; details?: { retryable?: boolean } };
    };

    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "DOCS_API_UPSTREAM_UNAVAILABLE");
    assert.equal(body.error?.message, "Docs API is temporarily unavailable");
    assert.equal(body.error?.details?.retryable, true);
    assert.equal(JSON.stringify(body).includes("docs.example.test"), false);
  });

  test("forwards the query to the configured upstream", async () => {
    process.env.DOCS_API_UPSTREAM_URL = "https://docs.example.test/api/docs/";
    let target = "";

    const response = await proxyToUpstream(
      new NextRequest("https://joelclaw.com/api/docs/search?q=effect&semantic=true"),
      ["search"],
      async (input) => {
        target = String(input);
        return Response.json(
          { ok: true },
          { status: 200, headers: { "cache-control": "public, max-age=3600" } },
        );
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(target, "https://docs.example.test/api/docs/search?q=effect&semantic=true");
  });
});
