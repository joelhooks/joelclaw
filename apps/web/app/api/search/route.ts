/**
 * Typesense search API — proxies search requests with scoped access.
 * ADR-0082 + ADR-0075
 *
 * Authenticated users search all collections.
 * Public users search blog_posts + discoveries only.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

const PUBLIC_COLLECTIONS = [
  { name: "blog_posts", queryBy: "title,content" },
  { name: "discoveries", queryBy: "title,summary" },
];

const ALL_COLLECTIONS = [
  { name: "vault_notes", queryBy: "title,content" },
  { name: "memory_observations", queryBy: "observation" },
  { name: "blog_posts", queryBy: "title,content" },
  { name: "system_log", queryBy: "detail,tool,action" },
  { name: "discoveries", queryBy: "title,summary" },
  { name: "voice_transcripts", queryBy: "content" },
];

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
    const hits: any[] = [];
    let totalFound = 0;

    for (const result of data.results) {
      const collName = result.request_params?.collection_name || "unknown";
      totalFound += result.found || 0;

      for (const h of result.hits || []) {
        const doc = h.document;
        let snippet = "";
        for (const hl of h.highlights || []) {
          if (hl.snippet) {
            snippet = hl.snippet;
            break;
          }
        }

        hits.push({
          collection: collName,
          title: doc.title || doc.observation?.slice(0, 100) || doc.detail?.slice(0, 100) || "",
          snippet: snippet.slice(0, 300),
          path: doc.path || doc.slug || undefined,
          type: doc.type || collName,
        });
      }
    }

    return NextResponse.json({ hits, totalFound, authenticated: !!authed });
  } catch (error) {
    return NextResponse.json(
      { error: "Search unavailable", detail: String(error) },
      { status: 503 }
    );
  }
}
