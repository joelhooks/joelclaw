import { type Duration, Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";

type NextAction = {
  command: string;
  description: string;
};

type AgentEnvelope<T = unknown> = {
  ok: boolean;
  command: string;
  protocolVersion: 1;
  result?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  nextActions?: NextAction[];
  meta?: Record<string, unknown>;
};

const PROTOCOL_VERSION = 1 as const;
const SERVICE = "web-docs-proxy";
const VERSION = "0.1.0";

const UPSTREAM_BASE =
  process.env.DOCS_API_UPSTREAM_URL || "https://panda.tail7af24.ts.net/api/docs";
const API_TOKEN =
  process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";

const UNAUTH_LIMIT = Number.parseInt(
  process.env.DOCS_API_UNAUTH_RL_LIMIT || "600",
  10,
);
const UNAUTH_WINDOW =
  (process.env.DOCS_API_UNAUTH_RL_WINDOW as Duration | undefined) || "1 m";

let ratelimit: Ratelimit | null | undefined;

function ok<T>(command: string, result: T, nextActions?: NextAction[]): AgentEnvelope<T> {
  return {
    ok: true,
    command,
    protocolVersion: PROTOCOL_VERSION,
    result,
    nextActions,
    meta: {
      via: "next-route",
      service: SERVICE,
      version: VERSION,
    },
  };
}

function fail(
  command: string,
  code: string,
  message: string,
  details?: unknown,
  nextActions?: NextAction[],
): AgentEnvelope {
  return {
    ok: false,
    command,
    protocolVersion: PROTOCOL_VERSION,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    nextActions,
    meta: {
      via: "next-route",
      service: SERVICE,
      version: VERSION,
    },
  };
}

function normalizedPath(path: string[] | undefined): string {
  if (!path || path.length === 0) return "/";
  return `/${path.join("/")}`;
}

function pathRequiresAuth(pathname: string): boolean {
  return (
    pathname === "/search" ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/") ||
    pathname.startsWith("/chunks/")
  );
}

function buildOpenApi(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Joelclaw Docs API",
      version: VERSION,
      description:
        "Proxy surface for docs-api with Upstash rate limiting at /api/docs. Authenticated requests bypass rate limits.",
    },
    servers: [{ url: `${origin}/api/docs` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
        },
      },
    },
    paths: {
      "/": { get: { summary: "HATEOAS discovery" } },
      "/openapi.json": { get: { summary: "OpenAPI schema" } },
      "/ui": { get: { summary: "Swagger UI" } },
      "/health": { get: { summary: "Health" } },
      "/search": {
        get: {
          summary: "Search chunks",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "perPage", in: "query", schema: { type: "integer", minimum: 1 } },
            {
              name: "semantic",
              in: "query",
              schema: { type: "string", description: "Boolean-like" },
            },
          ],
        },
      },
      "/docs": {
        get: {
          summary: "List docs",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "perPage", in: "query", schema: { type: "integer", minimum: 1 } },
          ],
        },
      },
      "/docs/{id}": {
        get: {
          summary: "Get doc by id",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/chunks/{id}": {
        get: {
          summary: "Get chunk by id",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "lite", in: "query", schema: { type: "string" } },
            { name: "includeEmbedding", in: "query", schema: { type: "string" } },
          ],
        },
      },
    },
  };
}

function buildUiHtml(origin: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Docs API UI</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #0b0d10; }
      #swagger-ui { max-width: 1200px; margin: 0 auto; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "${origin}/api/docs/openapi.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true,
        displayRequestDuration: true,
      });
    </script>
  </body>
</html>`;
}

function getRatelimit(): Ratelimit | null {
  if (ratelimit !== undefined) return ratelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    ratelimit = null;
    return ratelimit;
  }

  const redis = new Redis({ url, token });
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(UNAUTH_LIMIT, UNAUTH_WINDOW),
    analytics: true,
    prefix: "rl:docs-api-public",
  });
  return ratelimit;
}

function deriveIdentifier(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const firstIp = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);

  const forwarded = request.headers.get("forwarded") || "";
  const forwardedMatch = forwarded.match(/for=([^;]+)/i);
  const forwardedIp = forwardedMatch?.[1]?.replaceAll('"', "").trim();

  const ip =
    firstIp ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    forwardedIp ||
    "unknown";

  const ua = request.headers.get("user-agent") || "unknown-agent";
  return `${ip}:${ua.slice(0, 80)}`;
}

function authHeader(request: NextRequest): string {
  return request.headers.get("authorization") || "";
}

function isAuthenticated(request: NextRequest): boolean {
  if (!API_TOKEN) return false;
  return authHeader(request) === `Bearer ${API_TOKEN}`;
}

function discoveryResponse(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const command = "GET /";

  return NextResponse.json(
    ok(command, {
      service: "docs-api",
      surface: "joelclaw.com/api/docs",
      auth: {
        mode: "Bearer",
        header: "Authorization: Bearer <token>",
        protectedRoutes: ["/search", "/docs", "/docs/:id", "/chunks/:id"],
        authenticatedBypassesRateLimit: true,
      },
      rateLimit: {
        provider: "upstash",
        appliesTo: "unauthenticated requests",
        limit: UNAUTH_LIMIT,
        window: UNAUTH_WINDOW,
      },
      _links: {
        self: { href: "/api/docs", method: "GET", auth: false },
        openapi: { href: "/api/docs/openapi.json", method: "GET", auth: false },
        ui: { href: "/api/docs/ui", method: "GET", auth: false },
        health: { href: "/api/docs/health", method: "GET", auth: false },
        listDocs: {
          href: "/api/docs/docs?page=1&perPage=5",
          method: "GET",
          auth: true,
        },
        search: {
          href: "/api/docs/search?q=typesense&perPage=3&semantic=true",
          method: "GET",
          auth: true,
        },
      },
      fewShot: [
        {
          name: "health",
          curl: `curl -sS ${origin}/api/docs/health`,
        },
        {
          name: "discovery (authed)",
          curl: `curl -sS -H \"Authorization: Bearer $TOKEN\" ${origin}/api/docs`,
        },
        {
          name: "search",
          curl: `curl -sS -H \"Authorization: Bearer $TOKEN\" \"${origin}/api/docs/search?q=typesense&perPage=2&page=1&semantic=false\"`,
        },
        {
          name: "list docs",
          curl: `curl -sS -H \"Authorization: Bearer $TOKEN\" \"${origin}/api/docs/docs?page=1&perPage=3\"`,
        },
        {
          name: "chunk lite",
          curl: `curl -sS -H \"Authorization: Bearer $TOKEN\" \"${origin}/api/docs/chunks/<chunkId>?lite=true&includeEmbedding=false\"`,
        },
      ],
    }),
    { status: 200 },
  );
}

function limitExceededResponse(pathname: string, limit: number, remaining: number, reset: number) {
  return NextResponse.json(
    fail(`GET ${pathname}`, "RATE_LIMITED", "Too many unauthenticated requests", {
      limit,
      remaining,
      reset,
      tip: "Use Authorization: Bearer <token> to bypass limits",
    }),
    {
      status: 429,
      headers: {
        "x-ratelimit-limit": String(limit),
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(Math.floor(reset / 1000)),
        "retry-after": String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))),
      },
    },
  );
}

function unauthorizedResponse(pathname: string) {
  return NextResponse.json(
    fail(`GET ${pathname}`, "UNAUTHORIZED", "Bearer token required", {
      fix: "Set Authorization: Bearer <token>",
    }),
    { status: 401 },
  );
}

function misconfiguredResponse(pathname: string) {
  return NextResponse.json(
    fail(
      `GET ${pathname}`,
      "TOKEN_NOT_CONFIGURED",
      "PDF_BRAIN_API_TOKEN is not configured",
    ),
    { status: 503 },
  );
}

async function proxyToUpstream(request: NextRequest, path: string[]) {
  const upstream = UPSTREAM_BASE.replace(/\/$/, "");
  const suffix = path.length ? `/${path.map((segment) => encodeURIComponent(segment)).join("/")}` : "";
  const targetUrl = `${upstream}${suffix}${request.nextUrl.search}`;

  const upstreamResponse = await fetch(targetUrl, {
    method: "GET",
    headers: {
      ...(authHeader(request)
        ? {
            authorization: authHeader(request),
          }
        : {}),
    },
    cache: "no-store",
  });

  const body = await upstreamResponse.arrayBuffer();
  const headers = new Headers();

  const passThroughHeaders = [
    "content-type",
    "cache-control",
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
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  const pathname = normalizedPath(path);

  const tokenValidated = isAuthenticated(request);

  if (!tokenValidated) {
    const rl = getRatelimit();
    if (rl) {
      const rate = await rl.limit(deriveIdentifier(request));
      if (!rate.success) {
        return limitExceededResponse(pathname, rate.limit, rate.remaining, rate.reset);
      }
    }
  }

  if (pathname === "/" || pathname === "/index") {
    return discoveryResponse(request);
  }

  if (pathname === "/openapi.json") {
    return NextResponse.json(buildOpenApi(request.nextUrl.origin));
  }

  if (pathname === "/ui" || pathname === "/ui/") {
    return new NextResponse(buildUiHtml(request.nextUrl.origin), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  if (!API_TOKEN && pathRequiresAuth(pathname)) {
    return misconfiguredResponse(pathname);
  }

  if (pathRequiresAuth(pathname) && !tokenValidated) {
    return unauthorizedResponse(pathname);
  }

  return proxyToUpstream(request, path || []);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await context.params;
  return NextResponse.json(
    fail(`POST ${normalizedPath(path)}`, "METHOD_NOT_ALLOWED", "Only GET is supported"),
    { status: 405 },
  );
}
