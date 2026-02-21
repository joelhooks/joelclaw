import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";
const OTEL_COLLECTION = "otel_events";
const QUERY_BY = "action,error,component,source,metadata_json,search_text";
const FACET_FIELDS = "level,source,component,success";
const MAX_LIMIT = 200;

type Mode = "list" | "search" | "stats";

function parseMode(value: string | null): Mode {
  if (value === "search" || value === "stats") return value;
  return "list";
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildFilter(params: URLSearchParams): string | undefined {
  const filters: string[] = [];
  const hours = params.get("hours");
  if (hours && Number.isFinite(Number(hours)) && Number(hours) > 0) {
    const cutoff = Date.now() - Number(hours) * 60 * 60 * 1000;
    filters.push(`timestamp:>=${Math.floor(cutoff)}`);
  }

  const from = params.get("from");
  const to = params.get("to");
  if (from && Number.isFinite(Number(from))) {
    filters.push(`timestamp:>=${Math.floor(Number(from))}`);
  }
  if (to && Number.isFinite(Number(to))) {
    filters.push(`timestamp:<=${Math.floor(Number(to))}`);
  }

  const level = parseCsv(params.get("level"));
  if (level.length > 0) {
    filters.push(`level:=[${level.join(",")}]`);
  }

  const source = parseCsv(params.get("source"));
  if (source.length > 0) {
    filters.push(`source:=[${source.join(",")}]`);
  }

  const component = parseCsv(params.get("component"));
  if (component.length > 0) {
    filters.push(`component:=[${component.join(",")}]`);
  }

  const success = params.get("success");
  if (success === "true" || success === "false") {
    filters.push(`success:=${success}`);
  }

  return filters.length > 0 ? filters.join(" && ") : undefined;
}

async function queryTypesense(
  searchParams: URLSearchParams
): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> {
  try {
    const resp = await fetch(
      `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents/search?${searchParams}`,
      {
        headers: {
          "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
        },
      }
    );
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: await resp.text() };
    }
    return { ok: true, data: await resp.json() };
  } catch (error) {
    return { ok: false, status: 503, error: String(error) };
  }
}

function mapEventHit(hit: any): Record<string, unknown> {
  const doc = hit?.document ?? {};
  return {
    id: doc.id,
    timestamp: doc.timestamp,
    level: doc.level,
    source: doc.source,
    component: doc.component,
    action: doc.action,
    success: doc.success,
    duration_ms: doc.duration_ms,
    error: doc.error,
    metadata_json: doc.metadata_json,
    metadata_keys: doc.metadata_keys,
    text_match_score: hit?.text_match_info?.score,
  };
}

function readFacetCount(data: any, fieldName: string, key: string): number {
  const facetCounts = Array.isArray(data?.facet_counts) ? data.facet_counts : [];
  const facet = facetCounts.find((item: any) => item?.field_name === fieldName);
  const count = Array.isArray(facet?.counts)
    ? facet.counts.find((item: any) => item?.value === key)?.count
    : 0;
  return typeof count === "number" ? count : 0;
}

export async function GET(request: NextRequest) {
  const authed = await isAuthenticated().catch(() => false);
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mode = parseMode(request.nextUrl.searchParams.get("mode"));
  const filterBy = buildFilter(request.nextUrl.searchParams);

  if (mode === "stats") {
    const now = Date.now();
    const hours = parsePositiveInt(request.nextUrl.searchParams.get("hours"), 24, 24 * 14);
    const windowStart = now - hours * 60 * 60 * 1000;
    const statsFilter = [filterBy, `timestamp:>=${Math.floor(windowStart)}`]
      .filter(Boolean)
      .join(" && ");

    const statsParams = new URLSearchParams({
      q: "*",
      query_by: QUERY_BY,
      per_page: "0",
      facet_by: FACET_FIELDS,
      max_facet_values: "20",
      sort_by: "timestamp:desc",
    });
    if (statsFilter) statsParams.set("filter_by", statsFilter);

    const statsResult = await queryTypesense(statsParams);
    if (!statsResult.ok) {
      return NextResponse.json(
        { error: "Stats query failed", detail: statsResult.error },
        { status: statsResult.status }
      );
    }

    const total = Number(statsResult.data?.found ?? 0);
    const errors =
      readFacetCount(statsResult.data, "level", "error") +
      readFacetCount(statsResult.data, "level", "fatal");

    const recentParams = new URLSearchParams({
      q: "*",
      query_by: QUERY_BY,
      per_page: "0",
      facet_by: "level",
      sort_by: "timestamp:desc",
      filter_by: [
        filterBy,
        `timestamp:>=${Math.floor(now - 15 * 60 * 1000)}`,
      ]
        .filter(Boolean)
        .join(" && "),
    });
    const recent = await queryTypesense(recentParams);
    const recentTotal = recent.ok ? Number(recent.data?.found ?? 0) : 0;
    const recentErrors = recent.ok
      ? readFacetCount(recent.data, "level", "error") + readFacetCount(recent.data, "level", "fatal")
      : 0;

    return NextResponse.json({
      mode: "stats",
      windowHours: hours,
      total,
      errors,
      errorRate: total > 0 ? errors / total : 0,
      recent15m: {
        total: recentTotal,
        errors: recentErrors,
        errorRate: recentTotal > 0 ? recentErrors / recentTotal : 0,
      },
      facets: statsResult.data?.facet_counts ?? [],
    });
  }

  const limit = parsePositiveInt(request.nextUrl.searchParams.get("limit"), 50, MAX_LIMIT);
  const page = parsePositiveInt(request.nextUrl.searchParams.get("page"), 1, 1000);
  const query = mode === "search"
    ? request.nextUrl.searchParams.get("q")?.trim()
    : request.nextUrl.searchParams.get("q")?.trim() || "*";

  if (!query) {
    return NextResponse.json({ error: "Missing q for search mode" }, { status: 400 });
  }

  const searchParams = new URLSearchParams({
    q: query,
    query_by: QUERY_BY,
    per_page: String(limit),
    page: String(page),
    sort_by: "timestamp:desc",
    exclude_fields: "embedding",
    facet_by: FACET_FIELDS,
    max_facet_values: "12",
  });
  if (filterBy) searchParams.set("filter_by", filterBy);

  const result = await queryTypesense(searchParams);
  if (!result.ok) {
    return NextResponse.json(
      { error: "Query failed", detail: result.error },
      { status: result.status }
    );
  }

  const hits = Array.isArray(result.data?.hits) ? result.data.hits.map(mapEventHit) : [];
  return NextResponse.json({
    mode,
    query,
    page,
    limit,
    found: Number(result.data?.found ?? 0),
    hits,
    facets: result.data?.facet_counts ?? [],
  });
}
