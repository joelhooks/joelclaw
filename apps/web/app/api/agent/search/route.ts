/**
 * Agent-first search API — HATEOAS envelope, markdown snippets, Upstash rate limiting.
 *
 * Public: searches blog_posts, discoveries, ADRs
 * Authenticated (Bearer token): adds vault_notes, memory, system_log, transcripts
 *
 * Follows cli-design HATEOAS contract (ADR-0082, cli-design skill).
 * Rate limited via Upstash Redis (same pattern as /api/docs).
 */
import { type Duration, Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";
import { getAllAdrs } from "@/lib/adrs";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

const PROTOCOL_VERSION = 1 as const;
const SERVICE = "agent-search";
const VERSION = "0.1.0";

const RATE_LIMIT = Number.parseInt(
  process.env.AGENT_SEARCH_RL_LIMIT || "60",
  10,
);
const RATE_WINDOW: Duration =
  (process.env.AGENT_SEARCH_RL_WINDOW as Duration | undefined) || "1 m";

// --- Types ---

type NextAction = {
  command: string;
  description: string;
  params?: Record<string, { type: string; required?: boolean; description?: string }>;
};

type AgentEnvelope<T = unknown> = {
  ok: boolean;
  command: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
  nextActions?: NextAction[];
  meta?: Record<string, unknown>;
};

type SearchHit = {
  collection: string;
  title: string;
  snippet: string;
  url: string;
  type: string;
  score: number;
};

type SearchResult = {
  query: string;
  hits: SearchHit[];
  totalFound: number;
  collections: string[];
  authenticated: boolean;
};

// --- Envelope helpers ---

function envelope<T>(command: string, result: T, nextActions?: NextAction[]): AgentEnvelope<T> {
  return {
    ok: true,
    command,
    protocolVersion: PROTOCOL_VERSION,
    result,
    nextActions,
    meta: { service: SERVICE, version: VERSION },
  };
}

function errorEnvelope(
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
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    nextActions,
    meta: { service: SERVICE, version: VERSION },
  };
}

// --- Rate limiting ---

let ratelimit: Ratelimit | null | undefined;

function getRatelimit(): Ratelimit | null {
  if (ratelimit !== undefined) return ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) { ratelimit = null; return null; }
  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(RATE_LIMIT, RATE_WINDOW),
    analytics: true,
    prefix: "rl:agent-search",
  });
  return ratelimit;
}

function deriveIdentifier(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for") || "";
  const ip = xff.split(",").map(s => s.trim()).find(Boolean)
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || "unknown";
  const ua = (request.headers.get("user-agent") || "unknown").slice(0, 80);
  return `${ip}:${ua}`;
}

// --- Auth ---

function isAuthed(request: NextRequest): boolean {
  const authToken = process.env.AGENT_SEARCH_TOKEN || process.env.SITE_API_TOKEN || "";
  if (!authToken) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${authToken}`;
}

// --- Collection config ---

type CollectionConfig = { name: string; queryBy: string };

const PUBLIC_COLLECTIONS: CollectionConfig[] = [
  { name: "blog_posts", queryBy: "title,content" },
  { name: "discoveries", queryBy: "title,summary" },
];

const PRIVATE_COLLECTIONS: CollectionConfig[] = [
  { name: "vault_notes", queryBy: "title,content" },
  { name: "memory_observations", queryBy: "observation" },
  { name: "system_log", queryBy: "detail,tool,action" },
  { name: "transcripts", queryBy: "title,text,speaker,channel" },
];

// --- URL resolution ---

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveUrl(collection: string, doc: Record<string, unknown>): string | undefined {
  const path = str(doc.path);
  const slug = str(doc.slug) || (path ? path.split("/").pop()?.replace(/\.(md|mdx)$/, "") : undefined);

  switch (collection) {
    case "blog_posts":
      return `/${slug || slugify(str(doc.title) || "")}`;
    case "discoveries":
      return `/cool/${slug || slugify(str(doc.title) || "")}`;
    case "vault_notes": {
      const isAdr = str(doc.type) === "adr" || (path && (path.includes("/adrs/") || path.includes("docs/decisions/")));
      if (isAdr) return `/adrs/${slug || ""}`;
      return path ? `/vault/${encodeURI(path)}` : undefined;
    }
    case "memory_observations": return "/memory";
    case "system_log": return "/syslog";
    case "transcripts": return str(doc.source_url) || "/voice";
    default: return undefined;
  }
}

// --- Snippet extraction (markdown, not HTML) ---

function extractSnippet(
  hit: { highlights?: Array<{ snippet?: string; field?: string }> },
  doc: Record<string, unknown>,
  maxLen = 400,
): string {
  // Try highlighted snippet first, strip HTML marks to **bold**
  for (const hl of hit.highlights || []) {
    if (hl?.snippet) {
      return hl.snippet
        .replace(/<mark>/gi, "**")
        .replace(/<\/mark>/gi, "**")
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .slice(0, maxLen);
    }
  }

  const fallback = str(doc.summary) || str(doc.description) || str(doc.content)
    || str(doc.detail) || str(doc.observation) || str(doc.text) || "";
  return fallback.slice(0, maxLen);
}

// --- ADR search (local, same as /api/search) ---

function searchAdrs(query: string, limit: number): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const adr of getAllAdrs()) {
    const title = `ADR-${adr.number.padStart(4, "0")}: ${adr.title}`;
    const haystack = `${title} ${adr.description || ""} ${adr.status}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    hits.push({
      collection: "adrs",
      title,
      snippet: adr.description || `${adr.status} decision record`,
      url: `/adrs/${adr.slug}`,
      type: "adr",
      score: title.toLowerCase().includes(q) ? 100 : 10,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// --- Discovery endpoint ---

function discoveryResponse(request: NextRequest) {
  const origin = request.nextUrl.origin;
  return NextResponse.json(
    envelope("GET /api/agent/search", {
      service: SERVICE,
      description: "Agent-first search for joelclaw.com content. Returns HATEOAS JSON with markdown snippets.",
      auth: {
        mode: "public-read, bearer for private collections",
        note: "Set Authorization: Bearer <token> to search vault, memory, system log, transcripts",
      },
      rateLimit: { limit: RATE_LIMIT, window: RATE_WINDOW, provider: "upstash" },
      publicCollections: PUBLIC_COLLECTIONS.map(c => c.name).concat(["adrs"]),
      privateCollections: PRIVATE_COLLECTIONS.map(c => c.name),
    }, [
      {
        command: `curl -sS "${origin}/api/agent/search?q=livekit&limit=5"`,
        description: "Search public content",
      },
      {
        command: `curl -sS -H "Authorization: Bearer <token>" "${origin}/api/agent/search?q=livekit&limit=5"`,
        description: "Search all collections (authenticated)",
      },
      {
        command: `curl -sS "${origin}/api/docs"`,
        description: "Docs API (books, PDFs, chunked documents)",
      },
      {
        command: `curl -sS "${origin}/feed.xml"`,
        description: "RSS feed with full article content",
      },
    ]),
  );
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");

  // No query = discovery
  if (!q) return discoveryResponse(request);

  const command = `GET /api/agent/search?q=${encodeURIComponent(q)}`;

  // Rate limit
  const rl = getRatelimit();
  if (rl) {
    const rate = await rl.limit(deriveIdentifier(request));
    if (!rate.success) {
      return NextResponse.json(
        errorEnvelope(command, "RATE_LIMITED", "Too many requests", {
          limit: rate.limit,
          remaining: rate.remaining,
          resetMs: rate.reset,
        }),
        {
          status: 429,
          headers: {
            "retry-after": String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))),
          },
        },
      );
    }
  }

  const authed = isAuthed(request);
  const collections = authed
    ? [...PUBLIC_COLLECTIONS, ...PRIVATE_COLLECTIONS]
    : PUBLIC_COLLECTIONS;

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 10, 50);
  const perCollection = Math.max(3, Math.ceil(limit / collections.length));

  // Typesense multi-search
  const searches = collections.map(c => ({
    collection: c.name,
    q,
    query_by: c.queryBy,
    per_page: perCollection,
    highlight_full_fields: c.queryBy,
    exclude_fields: "embedding",
  }));

  try {
    const resp = await fetch(`${TYPESENSE_URL}/multi_search`, {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ searches }),
    });

    if (!resp.ok) {
      return NextResponse.json(
        errorEnvelope(command, "UPSTREAM_ERROR", "Typesense search failed", { status: resp.status }),
        { status: 502 },
      );
    }

    const data = await resp.json();
    const seen = new Map<string, SearchHit>();

    for (const [i, result] of (data.results || []).entries()) {
      const collName = result.request_params?.collection_name || collections[i]?.name || "unknown";

      for (const h of result.hits || []) {
        const doc = (h.document || {}) as Record<string, unknown>;
        const url = resolveUrl(collName, doc);
        if (!url) continue;

        const score = Number(h.text_match_info?.score ?? h.text_match ?? 0);
        const existing = seen.get(url);
        if (existing && existing.score >= score) continue;

        seen.set(url, {
          collection: collName,
          title: str(doc.title) || str(doc.action) || str(doc.observation) || "",
          snippet: extractSnippet(h, doc),
          url,
          type: str(doc.type) || collName,
          score,
        });
      }
    }

    // Add ADR results for public searches
    for (const hit of searchAdrs(q, perCollection)) {
      const existing = seen.get(hit.url);
      if (!existing || existing.score < hit.score) {
        seen.set(hit.url, hit);
      }
    }

    const hits = [...seen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const origin = request.nextUrl.origin;
    const searchResult: SearchResult = {
      query: q,
      hits,
      totalFound: hits.length,
      collections: [...new Set(hits.map(h => h.collection))],
      authenticated: authed,
    };

    return NextResponse.json(
      envelope(command, searchResult, [
        ...(hits.length > 0 ? [{
          command: `curl -sS "${origin}${hits[0].url}"`,
          description: `Read top result: ${hits[0].title}`,
        }] : []),
        {
          command: `curl -sS "${origin}/api/agent/search?q=${encodeURIComponent(q)}&limit=${Math.min(limit + 10, 50)}"`,
          description: "Expand search (more results)",
        },
        {
          command: `curl -sS "${origin}/api/docs/search?q=${encodeURIComponent(q)}&perPage=5"`,
          description: "Search docs/books (chunked documents)",
        },
        {
          command: `curl -sS "${origin}/feed.xml"`,
          description: "RSS feed (all articles, full content)",
        },
      ]),
    );
  } catch (error) {
    return NextResponse.json(
      errorEnvelope(command, "SEARCH_UNAVAILABLE", "Search service error", String(error)),
      { status: 503 },
    );
  }
}
