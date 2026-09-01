import { NextRequest, NextResponse } from "next/server";
import { resolveDocsApiUpstream } from "./contract";
import { DOCS_PROXY_VERSION, fail } from "./protocol";

const API_TOKEN = process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";

type DocsProxyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizedPath(path: string[] | undefined): string {
  if (!path || path.length === 0) return "/";
  return `/${path.join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicHealthPayload(payload: unknown) {
  const envelope = isRecord(payload) ? payload : {};
  const upstreamResult = isRecord(envelope.result) ? envelope.result : {};
  const upstreamTypesense = isRecord(upstreamResult.typesense) ? upstreamResult.typesense : {};
  const typesense: Record<string, unknown> = {
    ok: upstreamTypesense.ok === true,
  };

  if (typeof upstreamTypesense.status === "number") {
    typesense.status = upstreamTypesense.status;
  }

  return {
    ok: envelope.ok === true,
    command: "GET /health",
    protocolVersion: 1,
    result: {
      service: "docs-api",
      status: envelope.ok === true ? "ok" : "degraded",
      typesense,
    },
    meta: {
      via: "next-route",
      service: "web-docs-proxy",
      version: DOCS_PROXY_VERSION,
    },
  };
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  const passThroughHeaders = [
    "content-type",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after",
  ];

  for (const header of passThroughHeaders) {
    const value = response.headers.get(header);
    if (value) headers.set(header, value);
  }

  return headers;
}

export async function proxyToUpstream(
  request: NextRequest,
  path: string[],
  fetchImpl: DocsProxyFetch = fetch,
) {
  const command = `GET ${normalizedPath(path)}`;
  const upstream = resolveDocsApiUpstream({
    DOCS_API_UPSTREAM_URL: process.env.DOCS_API_UPSTREAM_URL,
  });
  if (!upstream.ok) {
    console.error("[web-docs-proxy] upstream configuration error", {
      code: upstream.code,
      message: upstream.message,
    });
    return NextResponse.json(
      fail(command, "DOCS_API_UPSTREAM_UNCONFIGURED", "Docs API is temporarily unavailable", {
        retryable: false,
      }),
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const suffix = path.length
    ? `/${path.map((segment) => encodeURIComponent(segment)).join("/")}`
    : "";
  const targetUrl = `${upstream.url}${suffix}${request.nextUrl.search}`;
  const inboundAuth = request.headers.get("authorization") || "";
  const upstreamAuth = inboundAuth || (API_TOKEN ? `Bearer ${API_TOKEN}` : "");

  try {
    const upstreamResponse = await fetchImpl(targetUrl, {
      method: "GET",
      headers: upstreamAuth ? { authorization: upstreamAuth } : {},
      cache: "no-store",
    });

    const headers = responseHeaders(upstreamResponse);
    if (normalizedPath(path) === "/health") {
      const payload: unknown = await upstreamResponse.json();
      return NextResponse.json(publicHealthPayload(payload), {
        status: upstreamResponse.status,
        headers,
      });
    }

    const body = await upstreamResponse.arrayBuffer();
    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers,
    });
  } catch (error) {
    console.error("[web-docs-proxy] upstream request failed", {
      path: normalizedPath(path),
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      fail(command, "DOCS_API_UPSTREAM_UNAVAILABLE", "Docs API is temporarily unavailable", {
        retryable: true,
      }),
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
