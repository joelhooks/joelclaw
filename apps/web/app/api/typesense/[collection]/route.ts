/**
 * List/search documents in a Typesense collection.
 * Owner-only. Supports ?q= search and ?page= pagination.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

const COLLECTION_CONFIG: Record<string, { queryBy: string; sortBy: string }> = {
  memory_observations: { queryBy: "observation,observation_type,source", sortBy: "timestamp:desc" },
  system_log: { queryBy: "detail,tool,action", sortBy: "timestamp:desc" },
  otel_events: { queryBy: "action,error,component,source,metadata_json,search_text", sortBy: "timestamp:desc" },
  voice_transcripts: { queryBy: "content,room", sortBy: "timestamp:desc" },
  discoveries: { queryBy: "title,summary", sortBy: "timestamp:desc" },
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ collection: string }> }
) {
  const authed = await isAuthenticated().catch(() => false);
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { collection } = await params;
  const config = COLLECTION_CONFIG[collection];
  if (!config) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const q = request.nextUrl.searchParams.get("q") || "*";
  const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
  const perPage = parseInt(request.nextUrl.searchParams.get("per_page") || "50");
  const semantic = request.nextUrl.searchParams.get("semantic") === "true";
  const semanticEnabled = semantic && collection === "memory_observations" && q !== "*";

  const searchParams = new URLSearchParams({
    q,
    query_by: semanticEnabled ? `embedding,${config.queryBy}` : config.queryBy,
    sort_by: config.sortBy,
    per_page: String(perPage),
    page: String(page),
    exclude_fields: "embedding",
  });
  if (semanticEnabled) {
    const k = Math.max(10, perPage);
    searchParams.set("vector_query", `embedding:([], k:${k}, distance_threshold: 0.5)`);
  }

  try {
    const resp = await fetch(
      `${TYPESENSE_URL}/collections/${collection}/documents/search?${searchParams}`,
      { headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY } }
    );
    if (!resp.ok) {
      return NextResponse.json({ error: "Search failed" }, { status: resp.status });
    }
    return NextResponse.json(await resp.json());
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  }
}
