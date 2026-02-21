/**
 * Typesense client utilities — ADR-0082
 *
 * Shared client for all Typesense operations in the system-bus.
 * Uses built-in auto-embedding (ts/all-MiniLM-L12-v2) — no external API calls.
 */

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

function getApiKey(): string {
  if (TYPESENSE_API_KEY) return TYPESENSE_API_KEY;
  // Fallback: lease from agent-secrets
  try {
    const { execSync } = require("node:child_process");
    return execSync("secrets lease typesense_api_key --ttl 15m", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("No TYPESENSE_API_KEY and secrets lease failed");
  }
}

const headers = () => ({
  "X-TYPESENSE-API-KEY": getApiKey(),
  "Content-Type": "application/json",
});

export interface TypesenseSearchParams {
  collection: string;
  q: string;
  query_by: string;
  per_page?: number;
  page?: number;
  filter_by?: string;
  sort_by?: string;
  exclude_fields?: string;
  include_fields?: string;
  vector_query?: string;
  facet_by?: string;
  max_facet_values?: number;
}

export interface TypesenseHit {
  document: Record<string, unknown>;
  highlights?: Array<{ field: string; snippet?: string }>;
  text_match_info?: { score: number };
  hybrid_search_info?: { rank_fusion_score: number };
}

export interface TypesenseSearchResult {
  found: number;
  hits: TypesenseHit[];
  facet_counts?: Array<{ field_name: string; counts: Array<{ value: string; count: number }> }>;
}

/** Upsert a single document */
export async function upsert(collection: string, doc: Record<string, unknown>): Promise<void> {
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents?action=upsert`,
    { method: "POST", headers: headers(), body: JSON.stringify(doc) }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Typesense upsert failed (${resp.status}): ${text}`);
  }
}

/** Bulk import documents via JSONL */
export async function bulkImport(
  collection: string,
  docs: Record<string, unknown>[],
  action: "upsert" | "create" | "update" = "upsert"
): Promise<{ success: number; errors: number }> {
  const body = docs.map((d) => JSON.stringify(d)).join("\n");
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents/import?action=${action}`,
    { method: "POST", headers: headers(), body }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Typesense bulk import failed (${resp.status}): ${text}`);
  }
  const text = await resp.text();
  const lines = text.trim().split("\n");
  let success = 0;
  let errors = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.success) success++;
      else errors++;
    } catch {
      errors++;
    }
  }
  return { success, errors };
}

/** Search a single collection */
export async function search(params: TypesenseSearchParams): Promise<TypesenseSearchResult> {
  const searchParams = new URLSearchParams({
    q: params.q,
    query_by: params.query_by,
    per_page: String(params.per_page ?? 10),
    exclude_fields: params.exclude_fields ?? "embedding",
  });
  if (params.page != null) searchParams.set("page", String(params.page));
  if (params.filter_by) searchParams.set("filter_by", params.filter_by);
  if (params.sort_by) searchParams.set("sort_by", params.sort_by);
  if (params.include_fields) searchParams.set("include_fields", params.include_fields);
  if (params.vector_query) searchParams.set("vector_query", params.vector_query);
  if (params.facet_by) searchParams.set("facet_by", params.facet_by);
  if (params.max_facet_values != null) {
    searchParams.set("max_facet_values", String(params.max_facet_values));
  }

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${params.collection}/documents/search?${searchParams}`,
    { headers: headers() }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Typesense search failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<TypesenseSearchResult>;
}

/** Delete a document by ID */
export async function deleteDoc(collection: string, id: string): Promise<void> {
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents/${id}`,
    { method: "DELETE", headers: headers() }
  );
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(`Typesense delete failed (${resp.status}): ${text}`);
  }
}
