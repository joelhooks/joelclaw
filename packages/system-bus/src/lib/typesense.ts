/**
 * Typesense client utilities — ADR-0082
 *
 * Shared client for all Typesense operations in the system-bus.
 * Uses built-in auto-embedding (ts/all-MiniLM-L12-v2) — no external API calls.
 */

export const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";
const TYPESENSE_WRITE_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.TYPESENSE_WRITE_MAX_RETRIES ?? "5", 10)
);
const TYPESENSE_WRITE_BASE_BACKOFF_MS = Math.max(
  50,
  Number.parseInt(process.env.TYPESENSE_WRITE_BASE_BACKOFF_MS ?? "250", 10)
);
const TYPESENSE_WRITE_MAX_BACKOFF_MS = Math.max(
  TYPESENSE_WRITE_BASE_BACKOFF_MS,
  Number.parseInt(process.env.TYPESENSE_WRITE_MAX_BACKOFF_MS ?? "4000", 10)
);
const TYPESENSE_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTypesenseWrite(request: () => Promise<Response>): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= TYPESENSE_WRITE_MAX_RETRIES; attempt += 1) {
    try {
      const response = await request();
      if (response.ok) return response;

      const retryable = TYPESENSE_RETRYABLE_STATUSES.has(response.status);
      if (!retryable || attempt >= TYPESENSE_WRITE_MAX_RETRIES) {
        return response;
      }

      // Drain transient error body before retry to avoid leaking readers.
      await response.text().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt >= TYPESENSE_WRITE_MAX_RETRIES) {
        throw error;
      }
    }

    const backoff = Math.min(
      TYPESENSE_WRITE_MAX_BACKOFF_MS,
      TYPESENSE_WRITE_BASE_BACKOFF_MS * 2 ** attempt
    );
    const jitter = Math.floor(Math.random() * Math.max(25, Math.floor(backoff * 0.2)));
    await sleep(backoff + jitter);
  }

  if (lastError) throw lastError;
  throw new Error("Typesense write failed after retries");
}

export async function typesenseRequest(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${path}`, {
    ...(init ?? {}),
    headers: {
      ...headers(),
      ...(init?.headers ?? {}),
    },
  });
}

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

export const TRANSCRIPTS_COLLECTION = "transcripts";
export const VOICE_TRANSCRIPTS_COLLECTION = "voice_transcripts";
export const DEFAULT_VECTOR_FIELD = "embedding";

type TypesenseCollectionField = {
  name?: unknown;
  type?: unknown;
};

type TypesenseCollectionSchema = {
  fields?: unknown;
};

const vectorFieldCache = new Map<string, string>();

const MINI_LM_MODEL_CONFIG = {
  model_name: "ts/all-MiniLM-L12-v2",
  indexing_prefix: "",
  query_prefix: "",
};

/**
 * ADR-0089: unified transcript index for video + meeting sources.
 * Auto-embedding is generated from the `text` field.
 */
export const TRANSCRIPTS_COLLECTION_SCHEMA = {
  name: TRANSCRIPTS_COLLECTION,
  fields: [
    { name: "chunk_id", type: "string" },
    { name: "source_id", type: "string", facet: true },
    { name: "type", type: "string", facet: true },
    { name: "title", type: "string" },
    { name: "speaker", type: "string", facet: true, optional: true },
    { name: "text", type: "string" },
    { name: "start_seconds", type: "float", optional: true },
    { name: "end_seconds", type: "float", optional: true },
    { name: "chapter", type: "string", facet: true, optional: true },
    { name: "source_url", type: "string", optional: true },
    { name: "channel", type: "string", facet: true, optional: true },
    { name: "source_date", type: "int64" },
    {
      name: "embedding",
      type: "float[]",
      embed: {
        from: ["text"],
        model_config: MINI_LM_MODEL_CONFIG,
      },
    },
  ],
  default_sorting_field: "source_date",
} satisfies Record<string, unknown>;

export const VOICE_TRANSCRIPTS_COLLECTION_SCHEMA = {
  name: VOICE_TRANSCRIPTS_COLLECTION,
  fields: [
    { name: "content", type: "string" },
    { name: "room", type: "string", facet: true, optional: true },
    { name: "turns", type: "int32", optional: true },
    { name: "timestamp", type: "int64", optional: true },
    {
      name: "embedding",
      type: "float[]",
      embed: {
        from: ["content"],
        model_config: MINI_LM_MODEL_CONFIG,
      },
    },
  ],
} satisfies Record<string, unknown>;

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the float[] vector field from a collection schema.
 * Falls back to `preferredField` when schema lookup is unavailable.
 */
export async function resolveVectorField(
  collection: string,
  preferredField = DEFAULT_VECTOR_FIELD
): Promise<string> {
  const cacheKey = `${collection}:${preferredField}`;
  const cached = vectorFieldCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await typesenseRequest(`/collections/${collection}`, { method: "GET" });
    if (!response.ok) {
      return preferredField;
    }

    const schema = (await response.json()) as TypesenseCollectionSchema;
    const fields = Array.isArray(schema.fields) ? (schema.fields as TypesenseCollectionField[]) : [];

    const preferredVectorField = fields.find((field) => {
      const name = asTrimmedString(field.name);
      const type = asTrimmedString(field.type);
      return name === preferredField && type === "float[]";
    });
    if (preferredVectorField) {
      vectorFieldCache.set(cacheKey, preferredField);
      return preferredField;
    }

    const firstVectorField = fields.find((field) => asTrimmedString(field.type) === "float[]");
    const resolved = asTrimmedString(firstVectorField?.name) ?? preferredField;
    vectorFieldCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    return preferredField;
  }
}

/** Upsert a single document */
export async function upsert(collection: string, doc: Record<string, unknown>): Promise<void> {
  const resp = await retryTypesenseWrite(() =>
    fetch(`${TYPESENSE_URL}/collections/${collection}/documents?action=upsert`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(doc),
    })
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
  const resp = await retryTypesenseWrite(() =>
    fetch(`${TYPESENSE_URL}/collections/${collection}/documents/import?action=${action}`, {
      method: "POST",
      headers: headers(),
      body,
    })
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

/** Create a collection if it does not already exist. */
export async function ensureCollection(
  collection: string,
  schema: Record<string, unknown>
): Promise<void> {
  const exists = await typesenseRequest(`/collections/${collection}`, { method: "GET" });
  if (exists.ok) return;
  if (exists.status !== 404) {
    const text = await exists.text();
    throw new Error(`Typesense collection check failed (${exists.status}): ${text}`);
  }

  const create = await typesenseRequest("/collections", {
    method: "POST",
    body: JSON.stringify(schema),
  });
  if (!create.ok) {
    const text = await create.text();
    // Handle races where another process creates collection concurrently.
    if (create.status === 409 || text.toLowerCase().includes("already exists")) {
      return;
    }
    throw new Error(`Typesense collection create failed (${create.status}): ${text}`);
  }
}

export async function ensureTranscriptsCollection(): Promise<void> {
  await ensureCollection(TRANSCRIPTS_COLLECTION, TRANSCRIPTS_COLLECTION_SCHEMA);
}

export async function ensureVoiceTranscriptsCollection(): Promise<void> {
  await ensureCollection(VOICE_TRANSCRIPTS_COLLECTION, VOICE_TRANSCRIPTS_COLLECTION_SCHEMA);
}
