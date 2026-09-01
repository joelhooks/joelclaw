import { NextRequest, NextResponse } from "next/server";
import { resolveDocsApiUpstream } from "./contract";
import { fail } from "./protocol";

const API_TOKEN = process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";

type DocsProxyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizedPath(path: string[] | undefined): string {
  if (!path || path.length === 0) return "/";
  return `/${path.join("/")}`;
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

    const body = await upstreamResponse.arrayBuffer();
    const headers = new Headers({ "cache-control": "no-store" });
    const passThroughHeaders = [
      "content-type",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "retry-after",
    ];

    for (const header of passThroughHeaders) {
      const value = upstreamResponse.headers.get(header);
      if (value) headers.set(header, value);
    }

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
