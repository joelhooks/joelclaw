/**
 * Agent-first search API — HATEOAS envelope, markdown snippets, Upstash rate limiting.
 *
 * Public: searches blog_posts, discoveries, pi_mono_artifacts, ADRs
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
  requestedCollection?: string;
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
  { name: "pi_mono_artifacts", queryBy: "title,content,author,path,decision_tags" },
];

const PRIVATE_COLLECTIONS: CollectionConfig[] = [
  { name: "vault_notes", queryBy: "title,content" },
  { name: "memory_observations", queryBy: "observation" },
  { name: "system_log", queryBy: "detail,tool,action" },
  { name: "transcripts", queryBy: "title,text,speaker,channel" },
];

const ALL_COLLECTIONS: CollectionConfig[] = [...PUBLIC_COLLECTIONS, ...PRIVATE_COLLECTIONS];
const PUBLIC_COLLECTION_NAMES = PUBLIC_COLLECTIONS.map((collection) => collection.name).concat(["adrs"]);
const PRIVATE_COLLECTION_NAMES = PRIVATE_COLLECTIONS.map((collection) => collection.name);

function findAllowedCollection(name: string, authed: boolean): CollectionConfig | undefined {
  const allowed = authed ? ALL_COLLECTIONS : PUBLIC_COLLECTIONS;
  return allowed.find((collection) => collection.name === name);
}

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
    case "pi_mono_artifacts":
      return str(doc.url) || str(doc.source_url) || "/api/pi-mono";
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

async function searchAdrs(query: string, limit: number): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  const adrs = await getAllAdrs();
  for (const adr of adrs) {
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
    envelope("GET /api/search", {
      service: SERVICE,
      description: "Agent-first search for joelclaw.com — Joel Hooks' site about building AI agent infrastructure, distributed systems, and developer education.",
      about: {
        who: "Joel Hooks — builder, educator, co-founder of egghead.io",
        what: "Articles, architecture decision records (ADRs), research, /cool discoveries, and system documentation",
        topics: [
          "AI agent infrastructure (LiveKit voice agents, gateway daemons, Inngest durable functions)",
          "Distributed systems (Kubernetes, Redis event bridges, self-hosted services)",
          "Programming language theory (Erlang/BEAM, Plan 9, type theory)",
          "Developer education and course platforms",
          "Observability, CLI design, and operational patterns",
        ],
      },
      usage: {
        search: `GET ${origin}/api/search?q={query}&limit={1-50}&collection={optional}`,
        params: {
          q: "Search query (required for search, omit for this discovery page)",
          limit: "Max results, 1-50, default 10",
          collection: `Optional collection filter. Public: ${PUBLIC_COLLECTION_NAMES.join(", ")}. Private with bearer token: ${PRIVATE_COLLECTION_NAMES.join(", ")}.`,
        },
        auth: "Optional. Set Authorization: Bearer <token> to unlock private collections (vault, memory, system log, transcripts).",
        rateLimit: `${RATE_LIMIT} requests per ${RATE_WINDOW} (Upstash sliding window)`,
        responseFormat: "HATEOAS JSON envelope with markdown snippets and nextActions",
      },
      publicCollections: PUBLIC_COLLECTION_NAMES,
      privateCollections: PRIVATE_COLLECTION_NAMES,
    }, [
      {
        command: `curl -sS "${origin}/api/search?q=voice+agent"`,
        description: "How Joel built a self-hosted voice agent with LiveKit",
      },
      {
        command: `curl -sS "${origin}/api/search?q=plan+9"`,
        description: "Research on Plan 9, Rob Pike, and the lineage to Go/Docker/K8s",
      },
      {
        command: `curl -sS "${origin}/api/search?q=erlang+armstrong"`,
        description: "Joe Armstrong, Erlang/OTP, and the BEAM virtual machine",
      },
      {
        command: `curl -sS "${origin}/api/search?q=inngest+durable+functions"`,
        description: "Architecture decisions on durable event-driven workflows",
      },
      {
        command: `curl -sS "${origin}/api/search?q=kubernetes+self-hosted"`,
        description: "Running services on a personal k8s cluster (Talos + Colima)",
      },
      {
        command: `curl -sS "${origin}/api/search?q=which+provider%2Fmodel+triggered+this&collection=pi_mono_artifacts"`,
        description: "Search the public pi-mono maintainer corpus only",
      },
      {
        command: `curl -sS "${origin}/api/pi-mono"`,
        description: "pi-mono corpus discovery + skill/extension install instructions",
      },
      {
        command: `curl -sS "${origin}/api/docs"`,
        description: "Docs API — search books, PDFs, and chunked technical documents",
      },
      {
        command: `curl -sS "${origin}/feed.xml"`,
        description: "RSS feed with full article content (all posts)",
      },
    ]),
  );
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");

  // No query = discovery
  if (!q) return discoveryResponse(request);

  const requestedCollection = request.nextUrl.searchParams.get("collection")?.trim() || undefined;
  const command = requestedCollection
    ? `GET /api/search?q=${encodeURIComponent(q)}&collection=${encodeURIComponent(requestedCollection)}`
    : `GET /api/search?q=${encodeURIComponent(q)}`;

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
  let collections = authed ? ALL_COLLECTIONS : PUBLIC_COLLECTIONS;
  let includeAdrs = true;

  if (requestedCollection) {
    if (requestedCollection === "adrs") {
      collections = [];
    } else {
      const requested = findAllowedCollection(requestedCollection, authed);
      if (!requested) {
        const allowed = authed ? [...PUBLIC_COLLECTION_NAMES, ...PRIVATE_COLLECTION_NAMES] : PUBLIC_COLLECTION_NAMES;
        return NextResponse.json(
          errorEnvelope(
            command,
            "INVALID_COLLECTION",
            `Unsupported collection '${requestedCollection}'`,
            { allowedCollections: allowed },
          ),
          { status: 400 },
        );
      }
      collections = [requested];
      includeAdrs = false;
    }
  }

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 10, 50);
  const collectionSlots = collections.length + (includeAdrs ? 1 : 0);
  const perCollection = Math.max(3, Math.ceil(limit / Math.max(collectionSlots, 1)));

  // Typesense multi-search
  const searches = collections.map((collection) => ({
    collection: collection.name,
    q,
    query_by: collection.queryBy,
    per_page: perCollection,
    highlight_full_fields: collection.queryBy,
    exclude_fields: "embedding",
  }));

  try {
    const data = searches.length > 0
      ? await (async () => {
        const resp = await fetch(`${TYPESENSE_URL}/multi_search`, {
          method: "POST",
          headers: {
            "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ searches }),
        });

        if (!resp.ok) {
          throw new Error(`Typesense search failed (${resp.status})`);
        }

        return resp.json();
      })()
      : { results: [] };

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
          type: str(doc.kind) || str(doc.type) || collName,
          score,
        });
      }
    }

    if (includeAdrs) {
      for (const hit of await searchAdrs(q, perCollection)) {
        const existing = seen.get(hit.url);
        if (!existing || existing.score < hit.score) {
          seen.set(hit.url, hit);
        }
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
      collections: [...new Set(hits.map((hit) => hit.collection))],
      authenticated: authed,
      requestedCollection,
    };

    return NextResponse.json(
      envelope(command, searchResult, [
        ...(hits.length > 0 ? [{
          command: hits[0].url.startsWith("http")
            ? `curl -sS "${hits[0].url}"`
            : `curl -sS "${origin}${hits[0].url}"`,
          description: `Read top result: ${hits[0].title}`,
        }] : []),
        {
          command: `curl -sS "${origin}/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(limit + 10, 50)}${requestedCollection ? `&collection=${encodeURIComponent(requestedCollection)}` : ""}"`,
          description: "Expand search (more results)",
        },
        {
          command: `curl -sS "${origin}/api/pi-mono"`,
          description: "pi-mono corpus discovery + install instructions",
        },
        {
          command: `curl -sS "${origin}/api/docs/search?q=${encodeURIComponent(q)}&perPage=5"`,
          description: "Search docs/books (chunked documents)",
        },
      ]),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upstream = message.match(/Typesense search failed \((\d+)\)/);
    if (upstream) {
      return NextResponse.json(
        errorEnvelope(command, "UPSTREAM_ERROR", "Typesense search failed", { status: Number(upstream[1]) }),
        { status: 502 },
      );
    }

    return NextResponse.json(
      errorEnvelope(command, "SEARCH_UNAVAILABLE", "Search service error", message),
      { status: 503 },
    );
  }
}
