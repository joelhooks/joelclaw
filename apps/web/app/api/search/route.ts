/**
 * Typesense search API — proxies search requests with scoped access.
 * ADR-0082 + ADR-0075
 *
 * Authenticated users search all collections.
 * Public users search articles + cool finds from Typesense, plus ADRs from local content.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAllAdrs } from "@/lib/adrs";
import { isAuthenticated } from "@/lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

type CollectionConfig = {
  name: string;
  queryBy: string;
};

type OutputHit = {
  collection: string;
  title: string;
  snippet: string;
  path?: string;
  type: string;
  url: string;
  rank: number;
};

const PUBLIC_COLLECTIONS: CollectionConfig[] = [
  { name: "blog_posts", queryBy: "title,content" },
  { name: "discoveries", queryBy: "title,summary" },
];

const ALL_COLLECTIONS: CollectionConfig[] = [
  { name: "vault_notes", queryBy: "title,content" },
  { name: "memory_observations", queryBy: "observation" },
  { name: "blog_posts", queryBy: "title,content" },
  { name: "system_log", queryBy: "detail,tool,action" },
  { name: "otel_events", queryBy: "action,error,component,source,metadata_json,search_text" },
  { name: "discoveries", queryBy: "title,summary" },
  { name: "transcripts", queryBy: "title,text,speaker,channel" },
  { name: "voice_transcripts", queryBy: "content" },
];

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(input: string): string {
  return decodeHtmlEntities(input).replace(/\s+/g, " ").trim();
}

function sanitizeSnippet(input: string): string {
  const marked = input
    .replace(/<mark>/gi, "__MARK_OPEN__")
    .replace(/<\/mark>/gi, "__MARK_CLOSE__");

  const escaped = escapeHtml(decodeHtmlEntities(marked));
  return escaped
    .replace(/__MARK_OPEN__/g, "<mark>")
    .replace(/__MARK_CLOSE__/g, "</mark>");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(input: string, query: string): string {
  const text = cleanText(input);
  if (!text) return "";
  const escaped = escapeHtml(text);
  const q = query.trim();
  if (!q) return escaped;
  const pattern = new RegExp(`(${escapeRegExp(q)})`, "ig");
  return escaped.replace(pattern, "<mark>$1</mark>");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugFromValue(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;

  const normalized = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

  if (!normalized) return undefined;

  const segment = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const slug = segment.replace(/\.(md|mdx)$/i, "");
  return slug || undefined;
}

function normalizeCollectionLabel(collection: string, url: string): string {
  if (url.startsWith("/adrs/")) return "adrs";
  if (url.startsWith("/cool/")) return "discoveries";
  return collection;
}

function resolveUrl(collection: string, doc: Record<string, unknown>): string | undefined {
  const path = asString(doc.path);
  const type = asString(doc.type)?.toLowerCase();

  switch (collection) {
    case "blog_posts": {
      const slug =
        slugFromValue(doc.slug) ??
        slugFromValue(path) ??
        slugFromValue(doc.id) ??
        (asString(doc.title) ? slugify(asString(doc.title) as string) : undefined);
      return slug ? `/${slug}` : undefined;
    }
    case "discoveries": {
      const slug =
        slugFromValue(doc.slug) ??
        slugFromValue(path) ??
        slugFromValue(doc.id) ??
        (asString(doc.title) ? slugify(asString(doc.title) as string) : undefined);
      return slug ? `/cool/${slug}` : "/cool";
    }
    case "vault_notes": {
      const adrLike =
        type === "adr" ||
        (typeof path === "string" &&
          (path.includes("/adrs/") || path.includes("docs/decisions/")));
      if (adrLike) {
        const slug =
          slugFromValue(path) ??
          slugFromValue(doc.slug) ??
          slugFromValue(doc.id) ??
          (asString(doc.title) ? slugify(asString(doc.title) as string) : undefined);
        return slug ? `/adrs/${slug}` : "/adrs";
      }
      return path ? `/vault/${encodeURI(path)}` : "/vault";
    }
    case "memory_observations":
      return "/memory";
    case "system_log":
      return "/syslog";
    case "otel_events":
      return "/system/events";
    case "transcripts": {
      const sourceUrl = asString(doc.source_url);
      if (sourceUrl) return sourceUrl;
      return "/voice";
    }
    case "voice_transcripts":
      return "/voice";
    default:
      return undefined;
  }
}

function resolveTitle(collection: string, doc: Record<string, unknown>): string {
  const fallback =
    asString(doc.title) ??
    asString(doc.action) ??
    asString(doc.observation) ??
    asString(doc.detail) ??
    "";

  if (collection === "vault_notes") {
    const path = asString(doc.path);
    if (!fallback && path) return cleanText(slugFromValue(path) ?? path);
  }

  return cleanText(fallback);
}

function resolveSnippet(
  hit: { highlights?: Array<{ snippet?: string }> },
  doc: Record<string, unknown>,
  query: string
): string {
  for (const hl of hit.highlights || []) {
    if (typeof hl?.snippet === "string" && hl.snippet.length > 0) {
      return sanitizeSnippet(hl.snippet.slice(0, 320));
    }
  }

  const fallback =
    asString(doc.summary) ??
    asString(doc.description) ??
    asString(doc.text) ??
    asString(doc.content) ??
    asString(doc.detail) ??
    asString(doc.observation) ??
    "";

  if (!fallback) return "";
  return highlightText(fallback.slice(0, 240), query);
}

function resolveRank(hit: {
  text_match?: number;
  text_match_info?: { score?: number };
  hybrid_search_info?: { rank_fusion_score?: number };
}): number {
  const score = Number(hit.text_match_info?.score ?? hit.text_match);
  if (Number.isFinite(score)) return score;
  const fusion = Number(hit.hybrid_search_info?.rank_fusion_score);
  return Number.isFinite(fusion) ? fusion : 0;
}

function searchAdrs(query: string, limit: number): OutputHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: OutputHit[] = [];

  for (const adr of getAllAdrs()) {
    const title = cleanText(`ADR-${adr.number.padStart(4, "0")}: ${adr.title}`);
    const snippetSource = cleanText(adr.description || `${adr.status} decision record`);
    const haystack = `${title} ${snippetSource}`.toLowerCase();
    if (!haystack.includes(q)) continue;

    const titleMatch = title.toLowerCase().includes(q) ? 100 : 0;
    const snippetMatch = snippetSource.toLowerCase().includes(q) ? 10 : 0;
    const url = `/adrs/${adr.slug}`;

    hits.push({
      collection: "adrs",
      title,
      snippet: highlightText(snippetSource, query),
      path: url,
      type: "adr",
      url,
      rank: titleMatch + snippetMatch,
    });
  }

  return hits.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  if (!q) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  const authed = await isAuthenticated().catch(() => false);
  const collections = authed ? ALL_COLLECTIONS : PUBLIC_COLLECTIONS;
  const perPage = 5;

  const searches = collections.map((c) => ({
    collection: c.name,
    q,
    query_by: c.queryBy,
    per_page: perPage,
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
        { error: "Search failed", status: resp.status },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const deduped = new Map<string, OutputHit>();
    let totalFoundRaw = 0;

    for (const [index, result] of (data.results || []).entries()) {
      const collName =
        result.request_params?.collection_name ||
        collections[index]?.name ||
        "unknown";
      totalFoundRaw += result.found || 0;

      for (const h of result.hits || []) {
        const doc = (h.document || {}) as Record<string, unknown>;
        const url = resolveUrl(collName, doc);
        if (!url) continue;

        const collection = normalizeCollectionLabel(collName, url);
        const title = resolveTitle(collName, doc);
        const snippet = resolveSnippet(h, doc, q);
        const path = asString(doc.path) ?? asString(doc.slug) ?? url;
        const type = cleanText(asString(doc.type) ?? collection);
        const rank = resolveRank(h);

        const dedupeKey = `${url}::${title.toLowerCase()}`;
        const existing = deduped.get(dedupeKey);
        if (!existing || rank > existing.rank) {
          deduped.set(dedupeKey, {
            collection,
            title,
            snippet,
            path,
            type,
            url,
            rank,
          });
        }
      }
    }

    if (!authed) {
      for (const hit of searchAdrs(q, perPage)) {
        const dedupeKey = `${hit.url}::${hit.title.toLowerCase()}`;
        const existing = deduped.get(dedupeKey);
        if (!existing || hit.rank > existing.rank) {
          deduped.set(dedupeKey, hit);
        }
      }
    }

    const hits = [...deduped.values()]
      .sort((a, b) => b.rank - a.rank)
      .map(({ rank, ...hit }) => hit);

    return NextResponse.json({
      hits,
      totalFound: hits.length,
      totalFoundRaw,
      authenticated: !!authed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Search unavailable", detail: String(error) },
      { status: 503 }
    );
  }
}
