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
export const CHANNEL_MESSAGES_COLLECTION = "channel_messages";
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

export const CHANNEL_MESSAGES_COLLECTION_SCHEMA = {
  name: CHANNEL_MESSAGES_COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "channel_type", type: "string", facet: true },
    { name: "channel_id", type: "string", facet: true },
    { name: "channel_name", type: "string" },
    { name: "thread_id", type: "string", optional: true },
    { name: "user_id", type: "string" },
    { name: "user_name", type: "string" },
    { name: "text", type: "string" },
    { name: "timestamp", type: "int64" },
    { name: "classification", type: "string", facet: true },
    { name: "topics", type: "string[]", facet: true },
    { name: "urgency", type: "string", facet: true },
    { name: "actionable", type: "bool" },
    { name: "summary", type: "string", optional: true },
    { name: "source_url", type: "string", optional: true },
  ],
  default_sorting_field: "timestamp",
} satisfies Record<string, unknown>;

export const SYSTEM_KNOWLEDGE_COLLECTION = "system_knowledge";

export const SYSTEM_KNOWLEDGE_COLLECTION_SCHEMA = {
  name: SYSTEM_KNOWLEDGE_COLLECTION,
  fields: [
    { name: "id", type: "string" as const },
    { name: "type", type: "string" as const, facet: true },
    { name: "title", type: "string" as const },
    { name: "content", type: "string" as const },
    { name: "source", type: "string" as const, optional: true },
    { name: "project", type: "string" as const, optional: true, facet: true },
    { name: "loop_id", type: "string" as const, optional: true },
    { name: "status", type: "string" as const, optional: true, facet: true },
    { name: "score", type: "int32" as const, optional: true },
    { name: "tags", type: "string[]" as const, optional: true, facet: true },
    { name: "created_at", type: "int64" as const },
    { name: "embedding", type: "float[]" as const, num_dim: 384, optional: true },
  ],
  default_sorting_field: "created_at",
  enable_nested_fields: false,
} satisfies Record<string, unknown>;

/**
 * Fan-out query across system_knowledge + memory_observations + system_log + discoveries.
 * Returns formatted text suitable for injection into agent prompts.
 * Uses multi_search for single round-trip. Gracefully skips collections that don't exist.
 *
 * This is the mandatory brain query — called by buildPrompt(), memory-enforcer, pitch mise brief.
 */
export async function querySystemKnowledge(
  query: string,
  options: {
    types?: string[];
    limit?: number;
    project?: string;
    collections?: string[];
  } = {},
): Promise<string> {
  const { types, limit = 5, project } = options;
  const collections = options.collections ?? [
    SYSTEM_KNOWLEDGE_COLLECTION,
    "memory_observations",
    "system_log",
    "discoveries",
  ];

  // Build per-collection search params
  const searches = collections.map((col) => {
    const params: Record<string, unknown> = {
      collection: col,
      q: query,
      per_page: Math.max(2, Math.ceil(limit / collections.length)),
      exclude_fields: "embedding",
    };

    // Collection-specific query_by fields
    switch (col) {
      case SYSTEM_KNOWLEDGE_COLLECTION:
        params.query_by = "title,content";
        if (types?.length) params.filter_by = `type:[${types.join(",")}]`;
        if (project) {
          const existing = params.filter_by ? `${params.filter_by} && ` : "";
          params.filter_by = `${existing}project:=${project}`;
        }
        break;
      case "memory_observations":
        params.query_by = "observation";
        break;
      case "system_log":
        params.query_by = "detail,tool,action";
        break;
      case "discoveries":
        params.query_by = "title,summary";
        break;
      default:
        params.query_by = "title,content";
    }
    return params;
  });

  try {
    const resp = await typesenseRequest("/multi_search", {
      method: "POST",
      body: JSON.stringify({ searches }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (text.includes("404") || text.includes("not found")) return "";
      console.warn(`[system-knowledge] multi_search failed (${resp.status}): ${text}`);
      return "";
    }

    const data = (await resp.json()) as { results?: Array<{ hits?: TypesenseHit[]; error?: string }> };
    if (!data.results) return "";

    const allHits: Array<{ source: string; hit: TypesenseHit }> = [];
    for (let i = 0; i < data.results.length; i++) {
      const result = data.results[i];
      if (result?.error || !result?.hits) continue;
      const source = collections[i] ?? "unknown";
      for (const hit of result.hits) {
        allHits.push({ source, hit });
      }
    }

    if (allHits.length === 0) return "";

    // Take top N by text_match score across all collections
    allHits.sort((a, b) => {
      const scoreA = Number(a.hit.text_match_info?.score ?? a.hit.hybrid_search_info?.rank_fusion_score ?? 0);
      const scoreB = Number(b.hit.text_match_info?.score ?? b.hit.hybrid_search_info?.rank_fusion_score ?? 0);
      return scoreB - scoreA;
    });

    return allHits.slice(0, limit).map(({ source, hit }) => {
      const doc = hit.document as Record<string, unknown>;
      switch (source) {
        case SYSTEM_KNOWLEDGE_COLLECTION:
          return `### [${doc.type}] ${doc.title}\n${String(doc.content ?? "").slice(0, 1000)}`;
        case "memory_observations":
          return `### [memory] ${String(doc.observation ?? "").slice(0, 1000)}`;
        case "system_log":
          return `### [slog] ${doc.action}: ${String(doc.detail ?? "").slice(0, 500)}`;
        case "discoveries":
          return `### [discovery] ${doc.title}\n${String(doc.summary ?? "").slice(0, 500)}`;
        default:
          return `### [${source}] ${doc.title ?? doc.id}\n${String(doc.content ?? doc.observation ?? "").slice(0, 500)}`;
      }
    }).join("\n\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("404") || msg.includes("ECONNREFUSED")) return "";
    console.warn(`[system-knowledge] query failed: ${msg}`);
    return "";
  }
}

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

/** Read a document by ID */
export async function getDoc(
  collection: string,
  id: string
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${TYPESENSE_URL}/collections/${collection}/documents/${encodeURIComponent(id)}`,
    { headers: headers() }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Typesense get failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
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

// ── Knowledge invariant: "Is this in system_knowledge? No → add. Yes → accurate? No → update." ──

export interface KnowledgeDoc {
  id: string;
  type: "adr" | "skill" | "lesson" | "pattern" | "retro" | "failed_target" | "decision" | "insight";
  title: string;
  content: string;
  source?: string;
  tags?: string[];
  score?: number;
  status?: string;
  project?: string;
}

/**
 * Ensure a piece of knowledge exists and is current.
 * - Not found → insert
 * - Found but content differs → update
 * - Found and matches → no-op
 *
 * Returns what action was taken for OTEL logging.
 */
export async function ensureKnowledge(
  doc: KnowledgeDoc,
): Promise<"inserted" | "updated" | "unchanged" | "error"> {
  try {
    await ensureCollection(SYSTEM_KNOWLEDGE_COLLECTION, SYSTEM_KNOWLEDGE_COLLECTION_SCHEMA);

    // Check if it exists
    const existing = await fetch(
      `${TYPESENSE_URL}/collections/${SYSTEM_KNOWLEDGE_COLLECTION}/documents/${doc.id}`,
      { headers: headers() },
    );

    if (!existing.ok) {
      // Not found → insert
      await upsert(SYSTEM_KNOWLEDGE_COLLECTION, {
        ...doc,
        created_at: Math.floor(Date.now() / 1000),
      });
      return "inserted";
    }

    // Found — check if content matches
    const current = (await existing.json()) as { content?: string; title?: string; status?: string };
    const contentChanged = current.content !== doc.content;
    const titleChanged = current.title !== doc.title;
    const statusChanged = doc.status !== undefined && current.status !== doc.status;

    if (contentChanged || titleChanged || statusChanged) {
      await upsert(SYSTEM_KNOWLEDGE_COLLECTION, {
        ...doc,
        created_at: Math.floor(Date.now() / 1000),
      });
      return "updated";
    }

    return "unchanged";
  } catch {
    return "error";
  }
}

/**
 * Batch version — run the invariant over many docs.
 * Returns counts by action taken.
 */
export async function ensureKnowledgeBatch(
  docs: KnowledgeDoc[],
): Promise<{ inserted: number; updated: number; unchanged: number; errors: number }> {
  const counts = { inserted: 0, updated: 0, unchanged: 0, errors: 0 };
  // For large batches, just bulk upsert (content-check not worth the N lookups)
  if (docs.length > 20) {
    try {
      await ensureCollection(SYSTEM_KNOWLEDGE_COLLECTION, SYSTEM_KNOWLEDGE_COLLECTION_SCHEMA);
      const now = Math.floor(Date.now() / 1000);
      const result = await bulkImport(
        SYSTEM_KNOWLEDGE_COLLECTION,
        docs.map((d) => ({ ...d, created_at: now })),
      );
      counts.inserted = result.success; // upsert = insert or update
      counts.errors = result.errors;
    } catch {
      counts.errors = docs.length;
    }
    return counts;
  }
  // Small batch — individual checks for accurate reporting
  for (const doc of docs) {
    const action = await ensureKnowledge(doc);
    counts[action === "error" ? "errors" : action]++;
  }
  return counts;
}

export async function ensureTranscriptsCollection(): Promise<void> {
  await ensureCollection(TRANSCRIPTS_COLLECTION, TRANSCRIPTS_COLLECTION_SCHEMA);
}

export async function ensureVoiceTranscriptsCollection(): Promise<void> {
  await ensureCollection(VOICE_TRANSCRIPTS_COLLECTION, VOICE_TRANSCRIPTS_COLLECTION_SCHEMA);
}

export async function ensureChannelMessagesCollection(): Promise<void> {
  await ensureCollection(CHANNEL_MESSAGES_COLLECTION, CHANNEL_MESSAGES_COLLECTION_SCHEMA);
}
