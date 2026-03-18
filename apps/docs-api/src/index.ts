import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

class LRUCache<T> {
  private cache = new Map<string, {value: T, ts: number}>();
  constructor(private maxSize: number, private ttlMs: number) {}
  get(key: string): T | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, {value, ts: Date.now()});
  }
}

const docCache = new LRUCache<Record<string, unknown>>(200, 600000);
const chunkCache = new LRUCache<Record<string, unknown>>(500, 600000);
const tocCache = new LRUCache<unknown>(100, 600000);

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

type TypesenseSearchHit = {
  document?: Record<string, unknown>;
  highlights?: Array<{ field?: string; snippet?: string }>;
  text_match_info?: { score?: number };
  hybrid_search_info?: { rank_fusion_score?: number };
};

type TypesenseFacetCount = {
  field_name?: string;
  counts?: Array<{ value?: string | number; count?: number }>;
};

type TypesenseSearchResponse = {
  found?: number;
  page?: number;
  hits?: TypesenseSearchHit[];
  facet_counts?: TypesenseFacetCount[];
};

type SearchHitResult = {
  id: string;
  docId: string;
  title: string;
  chunkType: string;
  chunkIndex: number | null;
  score: number | null;
  snippet: string;
  headingPath?: string[];
  conceptIds?: string[];
  expanded?: boolean;
  parentSection?: {
    id: string;
    headingPath: string[];
    content: string;
  };
};

type SearchHitResultInternal = SearchHitResult & {
  parentChunkId?: string;
};

type SearchConceptFacet = {
  concept: string;
  count: number;
  label: string;
};

type DocSummaryResult = {
  title: string;
  summary: string;
  storageCategory: string;
  conceptIds: string[];
};

type TypesenseCollection = "docs" | "docs_chunks" | "docs_chunks_v2";

type ConceptId =
  | "jc:docs:general"
  | "jc:docs:programming"
  | "jc:docs:programming:systems"
  | "jc:docs:programming:languages"
  | "jc:docs:programming:architecture"
  | "jc:docs:business"
  | "jc:docs:business:creator"
  | "jc:docs:education"
  | "jc:docs:education:learning-science"
  | "jc:docs:education:pedagogy"
  | "jc:docs:design"
  | "jc:docs:design:game"
  | "jc:docs:design:systems"
  | "jc:docs:design:product"
  | "jc:docs:marketing"
  | "jc:docs:strategy"
  | "jc:docs:ai"
  | "jc:docs:ai:agents"
  | "jc:docs:ai:applied"
  | "jc:docs:operations"
  | "jc:docs:podcast";

type TaxonomyConcept = {
  id: ConceptId;
  prefLabel: string;
  altLabels: string[];
  broader: ConceptId[];
  narrower: ConceptId[];
  related: ConceptId[];
  scopeNote: string;
};

type ConceptCountsCache = {
  docCounts: Record<string, number>;
  chunkCounts: Record<string, number>;
};

const PROTOCOL_VERSION = 1 as const;
const SERVICE_VERSION = "0.2.0";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3838", 10);
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://typesense:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";
const API_TOKEN = process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";
const DOCS_CHUNKS_COLLECTION = (process.env.DOCS_CHUNKS_COLLECTION || "docs_chunks_v2") as
  | "docs_chunks"
  | "docs_chunks_v2";
const DOCS_ARTIFACTS_DIR = process.env.DOCS_ARTIFACTS_DIR || "/Volumes/three-body/docs-artifacts";
const EMBEDDING_MODEL = "nomic-embed-text-v1.5 (768-dim)";
const OPTIONAL_PATH_PREFIX = "/api/docs";
const DOCS_INCLUDE_FIELDS =
  "id,title,filename,summary,tags,added_at,nas_path,nas_paths,storage_category,document_type,file_type,primary_concept_id,concept_ids,taxonomy_version";
const CONCEPT_COUNTS_TTL_MS = 5 * 60 * 1000;

// Simple TTL-based cache for Typesense responses
class TTLCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  constructor(readonly ttlMs: number) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

// Cache instances (10-minute TTL for document metadata and TOC)
const docByIdCache = new TTLCache<Record<string, unknown>>(10 * 60 * 1000);
const docTocCache = new TTLCache<Record<string, unknown>[]>(10 * 60 * 1000);
const parentSectionsCache = new TTLCache<
  Map<string, { id: string; headingPath: string[]; content: string }>
>(10 * 60 * 1000);

const TAXONOMY_CONCEPTS: TaxonomyConcept[] = [
  {
    id: "jc:docs:general",
    prefLabel: "General",
    altLabels: ["misc", "uncategorized", "other"],
    broader: [],
    narrower: [],
    related: [],
    scopeNote: "Fallback concept for documents that do not map to a specific domain.",
  },
  {
    id: "jc:docs:programming",
    prefLabel: "Programming",
    altLabels: ["software", "coding", "development", "computer science"],
    broader: [],
    narrower: [
      "jc:docs:programming:systems",
      "jc:docs:programming:languages",
      "jc:docs:programming:architecture",
    ],
    related: ["jc:docs:ai"],
    scopeNote: "Software engineering, code, architecture, and technical implementation.",
  },
  {
    id: "jc:docs:programming:systems",
    prefLabel: "Systems",
    altLabels: ["distributed-systems", "databases", "networking"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: ["jc:docs:ai:applied"],
    scopeNote: "Distributed systems, databases, networking, infrastructure internals.",
  },
  {
    id: "jc:docs:programming:languages",
    prefLabel: "Languages",
    altLabels: ["rust", "typescript", "language-design", "compilers"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: [],
    scopeNote: "Programming languages, type systems, compilers, language design.",
  },
  {
    id: "jc:docs:programming:architecture",
    prefLabel: "Architecture",
    altLabels: ["patterns", "ddd", "clean-architecture", "hexagonal"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: ["jc:docs:design:systems"],
    scopeNote: "Software architecture patterns, DDD, clean arch, microservices.",
  },
  {
    id: "jc:docs:business",
    prefLabel: "Business",
    altLabels: ["company", "finance", "entrepreneurship", "sales"],
    broader: [],
    narrower: ["jc:docs:business:creator"],
    related: ["jc:docs:marketing", "jc:docs:strategy"],
    scopeNote: "Business operations, management, finance, and growth.",
  },
  {
    id: "jc:docs:business:creator",
    prefLabel: "Creator Economy",
    altLabels: ["creator-economy", "indie-business", "audience-building", "bootstrapped"],
    broader: ["jc:docs:business"],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Creator economy, indie business, audience building, solopreneurship.",
  },
  {
    id: "jc:docs:education",
    prefLabel: "Education",
    altLabels: ["learning", "teaching", "curriculum", "training"],
    broader: [],
    narrower: ["jc:docs:education:learning-science", "jc:docs:education:pedagogy"],
    related: [],
    scopeNote: "Learning resources, instructional material, and pedagogy.",
  },
  {
    id: "jc:docs:education:learning-science",
    prefLabel: "Learning Science",
    altLabels: ["cognitive-science", "learning-theory", "memory", "cognitive-load"],
    broader: ["jc:docs:education"],
    narrower: [],
    related: ["jc:docs:ai"],
    scopeNote: "Cognitive science, memory, transfer, cognitive load theory.",
  },
  {
    id: "jc:docs:education:pedagogy",
    prefLabel: "Pedagogy",
    altLabels: ["instructional-design", "ubd", "curriculum-design"],
    broader: ["jc:docs:education"],
    narrower: [],
    related: [],
    scopeNote: "Instructional design, Understanding by Design, curriculum.",
  },
  {
    id: "jc:docs:design",
    prefLabel: "Design",
    altLabels: ["ux", "ui", "product design", "visual design"],
    broader: [],
    narrower: [
      "jc:docs:design:game",
      "jc:docs:design:systems",
      "jc:docs:design:product",
    ],
    related: ["jc:docs:marketing"],
    scopeNote: "Interface, product, systems, and visual design practices.",
  },
  {
    id: "jc:docs:design:game",
    prefLabel: "Game Design",
    altLabels: ["game-design", "game-feel", "play", "interactivity"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:education"],
    scopeNote: "Game design, play, mechanics, interactivity, ludology.",
  },
  {
    id: "jc:docs:design:systems",
    prefLabel: "Systems Design",
    altLabels: ["systems-thinking", "complexity", "emergence"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:programming:architecture"],
    scopeNote: "Systems thinking, complexity theory, emergence, feedback loops.",
  },
  {
    id: "jc:docs:design:product",
    prefLabel: "Product Design",
    altLabels: ["product-design", "ux", "interaction-design"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Product and UX design, interaction patterns, usability.",
  },
  {
    id: "jc:docs:marketing",
    prefLabel: "Marketing",
    altLabels: ["growth", "positioning", "brand", "copywriting"],
    broader: [],
    narrower: [],
    related: ["jc:docs:business", "jc:docs:strategy"],
    scopeNote: "Audience growth, messaging, distribution, and brand development.",
  },
  {
    id: "jc:docs:strategy",
    prefLabel: "Strategy",
    altLabels: ["planning", "roadmap", "go-to-market", "execution strategy"],
    broader: [],
    narrower: [],
    related: ["jc:docs:business", "jc:docs:operations"],
    scopeNote: "Strategic planning, prioritization, and execution frameworks.",
  },
  {
    id: "jc:docs:ai",
    prefLabel: "AI",
    altLabels: ["machine learning", "llm", "agents", "artificial intelligence"],
    broader: [],
    narrower: ["jc:docs:ai:agents", "jc:docs:ai:applied"],
    related: ["jc:docs:programming"],
    scopeNote: "Artificial intelligence, models, tooling, and agent systems.",
  },
  {
    id: "jc:docs:ai:agents",
    prefLabel: "AI Agents",
    altLabels: ["autonomous-agents", "tool-use", "agent-planning", "multi-agent"],
    broader: ["jc:docs:ai"],
    narrower: [],
    related: ["jc:docs:programming:systems"],
    scopeNote: "Autonomous agents, tool use, planning, multi-agent orchestration.",
  },
  {
    id: "jc:docs:ai:applied",
    prefLabel: "Applied AI",
    altLabels: ["rag", "embeddings", "vector-search", "production-ai"],
    broader: ["jc:docs:ai"],
    narrower: [],
    related: ["jc:docs:programming:systems"],
    scopeNote: "RAG, embeddings, vector search, production AI systems.",
  },
  {
    id: "jc:docs:operations",
    prefLabel: "Operations",
    altLabels: ["ops", "runbook", "incident", "platform"],
    broader: [],
    narrower: [],
    related: ["jc:docs:strategy", "jc:docs:business"],
    scopeNote: "Operational reliability, deployment, infrastructure, and runbooks.",
  },
  {
    id: "jc:docs:podcast",
    prefLabel: "Podcast",
    altLabels: ["audio", "episode", "show"],
    broader: [],
    narrower: [],
    related: ["jc:docs:education"],
    scopeNote: "Podcast episode notes, transcripts, and audio-adjacent content.",
  },
];

const CONCEPTS_BY_ID = new Map<string, TaxonomyConcept>(
  TAXONOMY_CONCEPTS.map((concept) => [concept.id, concept]),
);

let cachedConceptCountsAt = 0;
let cachedConceptCounts: ConceptCountsCache | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function ok<T>(command: string, result: T, nextActions?: NextAction[]): AgentEnvelope<T> {
  return {
    ok: true,
    command,
    protocolVersion: PROTOCOL_VERSION,
    result,
    nextActions,
    meta: {
      via: "http",
      service: "docs-api",
      version: SERVICE_VERSION,
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
      via: "http",
      service: "docs-api",
      version: SERVICE_VERSION,
    },
  };
}

function parsePath(requestUrl: string): string {
  const pathname = new URL(requestUrl).pathname;
  if (pathname === OPTIONAL_PATH_PREFIX) return "/";
  if (pathname.startsWith(`${OPTIONAL_PATH_PREFIX}/`)) {
    return pathname.slice(OPTIONAL_PATH_PREFIX.length);
  }
  return pathname;
}

function isAuthorized(request: Request): boolean {
  if (!API_TOKEN) return false;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${API_TOKEN}`;
}

function requirePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function firstQueryParam(searchParams: URLSearchParams, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value !== null) return value;
  }
  return null;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildTypesenseUrl(path: string, params?: URLSearchParams): string {
  const base = TYPESENSE_URL.endsWith("/") ? TYPESENSE_URL.slice(0, -1) : TYPESENSE_URL;
  const query = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  return `${base}${path}${query}`;
}

function quoteFilterValue(value: string): string {
  const escaped = value.replace(/`/g, "\\`");
  return `\`${escaped}\``;
}

function quoteFilterValues(values: string[]): string {
  return values.map((value) => quoteFilterValue(value)).join(",");
}

function getFacetCounts(response: TypesenseSearchResponse, fieldName: string): Record<string, number> {
  const facet = response.facet_counts?.find((entry) => entry.field_name === fieldName);
  const counts: Record<string, number> = {};

  for (const entry of facet?.counts || []) {
    const rawValue = entry.value;
    const value =
      typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue) : null;
    if (!value) continue;
    counts[value] = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0;
  }

  return counts;
}

function getConceptById(conceptId: string): TaxonomyConcept | null {
  return CONCEPTS_BY_ID.get(conceptId) ?? null;
}

function buildConceptResponse(concept: TaxonomyConcept, counts: ConceptCountsCache) {
  return {
    ...concept,
    docCount: counts.docCounts[concept.id] || 0,
    chunkCount: counts.chunkCounts[concept.id] || 0,
  };
}

function dedupeNextActions(actions: NextAction[]): NextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.command)) {
      return false;
    }
    seen.add(action.command);
    return true;
  });
}

function buildSearchWithinDocCommand(docId: string, query?: string): string {
  return query
    ? `GET /search?q=${encodeURIComponent(query)}&doc_id=${docId}`
    : `GET /search?q=<query>&doc_id=${docId}`;
}

function buildDocExplorationNextActions(docId: string, searchQuery?: string): NextAction[] {
  return dedupeNextActions([
    {
      command: `GET /docs/${docId}/toc`,
      description: "Browse the document TOC",
    },
    {
      command: buildSearchWithinDocCommand(docId, searchQuery),
      description: "Search within this book",
    },
    {
      command: `GET /docs/${docId}/chunks?type=section&page=1&perPage=50`,
      description: "Read surrounding section chunks",
    },
    {
      command: `GET /docs/${docId}/markdown`,
      description: "Read the full markdown artifact",
    },
    {
      command: `GET /docs/${docId}/summary`,
      description: "View the document summary and taxonomy",
    },
  ]);
}

function buildDocArtifactPaths(docId: string): {
  markdown: string;
  meta: string;
  chunks: string;
} | null {
  const normalizedDocId = docId.trim();
  if (
    normalizedDocId.length === 0
    || normalizedDocId.includes("/")
    || normalizedDocId.includes("\\")
    || normalizedDocId.includes("..")
  ) {
    return null;
  }

  const artifactDir = join(DOCS_ARTIFACTS_DIR, normalizedDocId);
  return {
    markdown: join(artifactDir, `${normalizedDocId}.md`),
    meta: join(artifactDir, `${normalizedDocId}.meta.json`),
    chunks: join(artifactDir, `${normalizedDocId}.chunks.jsonl`),
  };
}

async function readArtifactText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readArtifactJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readArtifactText(path);
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function artifactsDirExists(): Promise<boolean> {
  try {
    await access(DOCS_ARTIFACTS_DIR);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function mapDocSummary(doc: Record<string, unknown>): DocSummaryResult | null {
  const id = asString(doc.id);
  if (!id) {
    return null;
  }

  return {
    title: asString(doc.title) || "",
    summary: asString(doc.summary) || "",
    storageCategory: asString(doc.storage_category) || "",
    conceptIds: asStringArray(doc.concept_ids),
  };
}

function buildDocsChunksSearchParams(options: {
  q: string;
  page: number;
  perPage: number;
  semantic: boolean;
  filterBy?: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    q: options.q,
    page: String(options.page),
    query_by: options.semantic
      ? "retrieval_text,content,title,embedding"
      : "retrieval_text,content,title",
    per_page: String(options.perPage),
    include_fields:
      "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,taxonomy_version,evidence_tier,parent_evidence_id,source_entity_id,content",
    exclude_fields: "retrieval_text,embedding",
    highlight_full_fields: "content,retrieval_text",
    facet_by: "primary_concept_id",
    max_facet_values: "50",
  });

  if (options.filterBy) {
    params.set("filter_by", options.filterBy);
  }

  // ADR-0234: docs_chunks_v2 uses pre-computed ollama embeddings (raw float[]),
  // not Typesense auto-embed. vector_query with empty [] only works with auto-embed.
  // TODO: embed query via ollama when k8s can reach ollama endpoint, then pass actual vector.
  // For now, text-based search via retrieval_text is still high quality.
  if (options.semantic && DOCS_CHUNKS_COLLECTION === "docs_chunks") {
    // Only auto-embed vector search for v1 collection
    params.set(
      "vector_query",
      `embedding:([], k:${Math.max(options.perPage * 3, 20)}, alpha:0.75)`,
    );
  }

  return params;
}

function buildSearchFilterBy(options: {
  concept?: string;
  concepts?: string[];
  docId?: string;
}): string | undefined {
  const filters: string[] = [];

  if (options.concept) {
    filters.push(`primary_concept_id:=${quoteFilterValue(options.concept)}`);
  }

  if (options.concepts && options.concepts.length > 0) {
    filters.push(`concept_ids:=[${quoteFilterValues(options.concepts)}]`);
  }

  if (options.docId) {
    filters.push(`doc_id:=${quoteFilterValue(options.docId)}`);
  }

  return filters.length > 0 ? filters.join(" && ") : undefined;
}

function mergeCountRecords(...records: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      merged[key] = (merged[key] || 0) + value;
    }
  }

  return merged;
}

function buildConceptFacetsFromCounts(counts: Record<string, number>): SearchConceptFacet[] {
  return Object.entries(counts)
    .map(([concept, count]) => ({
      concept,
      count,
      label: getConceptById(concept)?.prefLabel || concept,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function mapSearchHit(hit: TypesenseSearchHit, expanded = false): SearchHitResultInternal {
  const doc = hit.document || {};
  const snippet = hit.highlights?.find((entry) => entry.field === "content")?.snippet;
  const headingPath = asStringArray(doc.heading_path);
  const conceptIds = asStringArray(doc.concept_ids);
  const parentChunkId = asString(doc.parent_chunk_id);

  return {
    id: asString(doc.id) || "",
    docId: asString(doc.doc_id) || "",
    title: asString(doc.title) || "",
    chunkType: asString(doc.chunk_type) || "",
    chunkIndex: asNumber(doc.chunk_index),
    score: hit.hybrid_search_info?.rank_fusion_score ?? hit.text_match_info?.score ?? null,
    snippet: snippet || asString(doc.content)?.slice(0, 320) || "",
    ...(headingPath.length > 0 ? { headingPath } : {}),
    ...(conceptIds.length > 0 ? { conceptIds } : {}),
    ...(expanded ? { expanded: true } : {}),
    ...(parentChunkId ? { parentChunkId } : {}),
  };
}

async function fetchParentSections(parentChunkIds: string[]): Promise<
  Map<string, { id: string; headingPath: string[]; content: string }>
> {
  const uniqueParentIds = [...new Set(parentChunkIds.filter((id) => id.length > 0))];
  if (uniqueParentIds.length === 0) {
    return new Map();
  }

  // Create a cache key from sorted unique IDs
  const cacheKey = uniqueParentIds.sort().join("|");

  // Check cache first
  const cachedParents = parentSectionsCache.get(cacheKey);
  if (cachedParents) {
    return cachedParents;
  }

  const response = await typesenseSearch(
    DOCS_CHUNKS_COLLECTION,
    new URLSearchParams({
      q: "*",
      query_by: "content",
      filter_by: `id:=[${quoteFilterValues(uniqueParentIds)}]`,
      per_page: String(uniqueParentIds.length),
      include_fields: "id,heading_path,content",
      exclude_fields: "retrieval_text,embedding",
    }),
  );

  const parents = new Map<string, { id: string; headingPath: string[]; content: string }>();

  for (const hit of response.hits || []) {
    const doc = hit.document || {};
    const id = asString(doc.id);
    if (!id) continue;

    parents.set(id, {
      id,
      headingPath: asStringArray(doc.heading_path),
      content: asString(doc.content) || "",
    });
  }

  // Cache the result
  parentSectionsCache.set(cacheKey, parents);

  return parents;
}

function buildSearchCommand(options: {
  q: string;
  perPage: number;
  semantic: boolean;
  concept?: string;
  docId?: string;
  expand: boolean;
  assemble: boolean;
}): string {
  const params = new URLSearchParams({
    q: options.q,
    perPage: String(options.perPage),
    semantic: String(options.semantic),
  });

  if (options.concept) {
    params.set("concept", options.concept);
  }

  if (options.docId) {
    params.set("doc_id", options.docId);
  }

  if (options.expand) {
    params.set("expand", "true");
  }

  if (options.assemble) {
    params.set("assemble", "true");
  }

  return `GET /search?${params.toString()}`;
}

async function typesenseRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!TYPESENSE_API_KEY) {
    throw new Error("TYPESENSE_API_KEY is not configured");
  }

  const headers = new Headers(init.headers || {});
  headers.set("X-TYPESENSE-API-KEY", TYPESENSE_API_KEY);

  return fetch(buildTypesenseUrl(path), {
    ...init,
    headers,
  });
}

async function typesenseSearch(
  collection: TypesenseCollection,
  params: URLSearchParams,
): Promise<TypesenseSearchResponse> {
  const response = await typesenseRequest(`/collections/${collection}/documents/search?${params.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Typesense search failed (${response.status}): ${text}`);
  }
  return (await response.json()) as TypesenseSearchResponse;
}

async function typesenseGetById(collection: TypesenseCollection, id: string): Promise<{
  status: number;
  body: Record<string, unknown> | null;
}> {
  const response = await typesenseRequest(
    `/collections/${collection}/documents/${encodeURIComponent(id)}`,
  );

  if (response.status === 404) {
    return { status: 404, body: null };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Typesense get failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  return { status: 200, body };
}

async function getCollectionDocumentCount(collection: TypesenseCollection): Promise<number> {
  const response = await typesenseRequest(`/collections/${collection}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Typesense collection lookup failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as { num_documents?: number };
  return typeof payload.num_documents === "number" && Number.isFinite(payload.num_documents)
    ? payload.num_documents
    : 0;
}

async function fetchDocSummaries(docIds: string[]): Promise<Record<string, DocSummaryResult>> {
  const summaries: Record<string, DocSummaryResult> = {};
  const uniqueDocIds = [...new Set(docIds.filter((docId) => docId.length > 0))];
  const missingDocIds: string[] = [];

  for (const docId of uniqueDocIds) {
    const cached = docByIdCache.get(docId);
    if (!cached) {
      missingDocIds.push(docId);
      continue;
    }

    const summary = mapDocSummary(cached);
    if (summary) {
      summaries[docId] = summary;
    }
  }

  if (missingDocIds.length === 0) {
    return summaries;
  }

  const response = await typesenseSearch(
    "docs",
    new URLSearchParams({
      q: "*",
      query_by: "title,filename",
      filter_by: `id:=[${quoteFilterValues(missingDocIds)}]`,
      per_page: String(missingDocIds.length),
      include_fields: "id,title,summary,storage_category,concept_ids",
    }),
  );

  for (const hit of response.hits || []) {
    const doc = (hit.document || {}) as Record<string, unknown>;
    const docId = asString(doc.id);
    if (!docId) {
      continue;
    }

    docByIdCache.set(docId, doc);
    const summary = mapDocSummary(doc);
    if (summary) {
      summaries[docId] = summary;
    }
  }

  return summaries;
}

async function getConceptCounts(): Promise<ConceptCountsCache> {
  const now = Date.now();
  if (cachedConceptCounts && now - cachedConceptCountsAt < CONCEPT_COUNTS_TTL_MS) {
    return cachedConceptCounts;
  }

  const [docsFacetResponse, chunksFacetResponse] = await Promise.all([
    typesenseSearch(
      "docs",
      new URLSearchParams({
        q: "*",
        query_by: "title,filename",
        facet_by: "primary_concept_id",
        max_facet_values: "50",
        per_page: "0",
      }),
    ),
    typesenseSearch(
      DOCS_CHUNKS_COLLECTION,
      new URLSearchParams({
        q: "*",
        query_by: "content",
        facet_by: "concept_ids",
        max_facet_values: "50",
        per_page: "0",
      }),
    ),
  ]);

  cachedConceptCounts = {
    docCounts: getFacetCounts(docsFacetResponse, "primary_concept_id"),
    chunkCounts: getFacetCounts(chunksFacetResponse, "concept_ids"),
  };
  cachedConceptCountsAt = now;

  return cachedConceptCounts;
}

async function listTopDocsForConcept(conceptId: string) {
  const response = await typesenseSearch(
    DOCS_CHUNKS_COLLECTION,
    new URLSearchParams({
      q: "*",
      query_by: "content",
      filter_by: `primary_concept_id:=${quoteFilterValue(conceptId)}`,
      facet_by: "doc_id",
      max_facet_values: "5",
      per_page: "0",
    }),
  );

  const topCounts = (response.facet_counts?.find((entry) => entry.field_name === "doc_id")?.counts || [])
    .map((entry) => {
      const docId =
        typeof entry.value === "string" || typeof entry.value === "number"
          ? String(entry.value)
          : null;
      const chunkCount = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0;
      if (!docId) return null;
      return { docId, chunkCount };
    })
    .filter((entry): entry is { docId: string; chunkCount: number } => entry !== null)
    .slice(0, 5);

  const docs = await Promise.all(
    topCounts.map(async ({ docId, chunkCount }) => {
      const docResponse = await typesenseGetById("docs", docId);
      if (docResponse.status === 404) {
        return null;
      }

      return {
        ...(docResponse.body || {}),
        chunkCount,
      };
    }),
  );

  return docs.filter((doc): doc is Record<string, unknown> => doc !== null);
}

async function handleHealth(path: string): Promise<Response> {
  const command = `GET ${path}`;

  const healthResult: Record<string, unknown> = {
    service: "docs-api",
    status: "ok",
    host: HOST,
    port: PORT,
    authRequired: true,
    typesenseUrl: TYPESENSE_URL,
  };

  if (TYPESENSE_API_KEY) {
    try {
      const response = await typesenseRequest("/health");
      healthResult.typesense = {
        status: response.status,
        ok: response.ok,
      };
    } catch (error) {
      healthResult.typesense = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    healthResult.typesense = {
      ok: false,
      error: "TYPESENSE_API_KEY missing",
    };
  }

  return jsonResponse(
    ok(command, healthResult, [
      {
        command: "GET /status",
        description: "Inspect docs-api version and collection status",
      },
      {
        command: "GET /",
        description: "Read the API guide and agent instructions",
      },
    ]),
  );
}

async function handleStatus(path: string): Promise<Response> {
  const command = `GET ${path}`;
  const [artifactsAvailable, docsCount, chunksCount] = await Promise.all([
    artifactsDirExists(),
    getCollectionDocumentCount("docs"),
    getCollectionDocumentCount(DOCS_CHUNKS_COLLECTION),
  ]);

  return jsonResponse(
    ok(
      command,
      {
        service: "docs-api",
        version: SERVICE_VERSION,
        activeCollection: DOCS_CHUNKS_COLLECTION,
        embeddingModel: EMBEDDING_MODEL,
        artifactsDir: DOCS_ARTIFACTS_DIR,
        artifactsAvailable,
        docsCount,
        chunksCount,
      },
      [
        {
          command: "GET /",
          description: "Read the API guide and agent instructions",
        },
        {
          command: "GET /search?q=<query>",
          description: "Search the active chunks collection",
        },
        {
          command: "GET /docs",
          description: "List indexed documents",
        },
      ],
    ),
  );
}

async function handleDocMarkdown(docId: string, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const artifactPaths = buildDocArtifactPaths(docId);
  if (!artifactPaths) {
    return jsonResponse(
      fail(command, "INVALID_DOC_ID", `Invalid document id: ${docId}`),
      400,
    );
  }

  const content = await readArtifactText(artifactPaths.markdown);
  if (content === null) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Markdown artifact not found for ${docId}`),
      404,
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      },
      [
        {
          command: `GET /docs/${docId}/toc`,
          description: "Browse the heading hierarchy before reading sections",
        },
        {
          command: `GET /docs/${docId}/chunks`,
          description: "List chunks derived from this markdown artifact",
        },
        {
          command: `GET /docs/${docId}/summary`,
          description: "View the document summary and taxonomy",
        },
        {
          command: buildSearchWithinDocCommand(docId),
          description: "Search within this book for a specific concept",
        },
      ],
    ),
  );
}

async function handleDocSummary(docId: string, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const artifactPaths = buildDocArtifactPaths(docId);
  if (!artifactPaths) {
    return jsonResponse(
      fail(command, "INVALID_DOC_ID", `Invalid document id: ${docId}`),
      400,
    );
  }

  const metadata = await readArtifactJson(artifactPaths.meta);
  if (metadata === null) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Metadata artifact not found for ${docId}`),
      404,
    );
  }

  const summaryTitle = asString(metadata.title) || undefined;
  return jsonResponse(
    ok(
      command,
      metadata,
      [
        {
          command: `GET /docs/${docId}/markdown`,
          description: "Read the full markdown artifact",
        },
        {
          command: `GET /docs/${docId}/toc`,
          description: "Browse the document TOC",
        },
        {
          command: buildSearchWithinDocCommand(docId, summaryTitle),
          description: "Search within this book using the summary context",
        },
      ],
    ),
  );
}

async function handleSearch(url: URL, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const q = url.searchParams.get("q")?.trim() || "";
  if (!q) {
    return jsonResponse(
      fail(command, "INVALID_QUERY", "Missing q query parameter"),
      400,
    );
  }

  const page = requirePositiveInt(firstQueryParam(url.searchParams, "page"), 1);
  const perPage = Math.min(
    requirePositiveInt(firstQueryParam(url.searchParams, "perPage", "per_page", "limit"), 10),
    50,
  );
  const semantic = parseBoolean(firstQueryParam(url.searchParams, "semantic"), true);
  const concept = firstQueryParam(url.searchParams, "concept")?.trim() || undefined;
  const conceptsRaw = firstQueryParam(url.searchParams, "concepts")?.trim() || undefined;
  const conceptIds = parseCsv(conceptsRaw || null);
  const docId = firstQueryParam(url.searchParams, "doc_id")?.trim() || undefined;
  const expand = parseBoolean(firstQueryParam(url.searchParams, "expand"), false);
  const assemble = parseBoolean(firstQueryParam(url.searchParams, "assemble"), false);
  const filterBy = buildSearchFilterBy({
    concept,
    concepts: conceptIds,
    docId,
  });

  const response = await typesenseSearch(
    DOCS_CHUNKS_COLLECTION,
    buildDocsChunksSearchParams({
      q,
      page,
      perPage,
      semantic,
      filterBy,
    }),
  );

  const initialFacetCounts = getFacetCounts(response, "primary_concept_id");
  const initialHits = (response.hits || []).map((hit) => mapSearchHit(hit));
  let mergedHits = [...initialHits];
  let combinedFacetCounts = initialFacetCounts;
  let found = response.found || 0;
  let expandedConcepts: string[] = [];

  if (expand && initialHits.length < perPage) {
    const seedConceptIds = buildConceptFacetsFromCounts(initialFacetCounts).map((facet) => facet.concept);
    const relatedConceptIds = [...new Set(
      seedConceptIds.flatMap((conceptId) => getConceptById(conceptId)?.related || []),
    )].filter((conceptId) => !seedConceptIds.includes(conceptId));

    if (relatedConceptIds.length > 0) {
      expandedConcepts = relatedConceptIds;
      const expandedBaseFilter = buildSearchFilterBy({
        docId,
      });
      const expandedConceptFilter = `primary_concept_id:=[${quoteFilterValues(relatedConceptIds)}]`;
      const expandedFilterBy = [expandedBaseFilter, expandedConceptFilter]
        .filter((value): value is string => Boolean(value))
        .join(" && ");

      const expandedResponse = await typesenseSearch(
        DOCS_CHUNKS_COLLECTION,
        buildDocsChunksSearchParams({
          q,
          page: 1,
          perPage,
          semantic,
          filterBy: expandedFilterBy,
        }),
      );

      combinedFacetCounts = mergeCountRecords(
        initialFacetCounts,
        getFacetCounts(expandedResponse, "primary_concept_id"),
      );
      found += expandedResponse.found || 0;

      const existingIds = new Set(initialHits.map((hit) => hit.id));
      const expandedHits = (expandedResponse.hits || [])
        .map((hit) => mapSearchHit(hit, true))
        .filter((hit) => !existingIds.has(hit.id));

      if (expandedHits.length > 0) {
        mergedHits = [...initialHits, ...expandedHits].slice(0, perPage);
      }
    }
  }

  if (assemble) {
    const parentChunkIds = mergedHits
      .filter((hit) => hit.chunkType === "snippet" && hit.parentChunkId)
      .map((hit) => hit.parentChunkId || "");
    
    const cacheKey = parentChunkIds.sort().join("|");
    let parents = chunkCache.get(cacheKey) as Map<string, { id: string; headingPath: string[]; content: string }> | undefined;
    
    if (!parents) {
      parents = await fetchParentSections(parentChunkIds);
      chunkCache.set(cacheKey, parents);
    }

    mergedHits = mergedHits.map((hit) => {
      if (hit.chunkType !== "snippet" || !hit.parentChunkId) {
        return hit;
      }

      const parentSection = parents.get(hit.parentChunkId);
      if (!parentSection) {
        return hit;
      }

      return {
        ...hit,
        parentSection,
      };
    });
  }

  const hits: SearchHitResult[] = mergedHits.map(({ parentChunkId: _parentChunkId, ...hit }) => hit);
  const docSummaries = await fetchDocSummaries(hits.map((hit) => hit.docId));
  const conceptFacets = buildConceptFacetsFromCounts(combinedFacetCounts);

  const first = hits[0];
  const nextActions: NextAction[] = [];

  if (first?.id) {
    nextActions.push({
      command: `GET /chunks/${first.id}`,
      description: "Fetch full chunk content",
    });
  }

  if (first?.docId) {
    nextActions.push(
      {
        command: `GET /docs/${first.docId}/chunks?type=section&page=1&perPage=50`,
        description: "Read surrounding section chunks",
      },
      {
        command: `GET /docs/${first.docId}/toc`,
        description: "Browse the matched document TOC",
      },
      {
        command: `GET /docs/${first.docId}/markdown`,
        description: "Read the full markdown artifact",
      },
      {
        command: `GET /docs/${first.docId}/summary`,
        description: "View the document summary and taxonomy",
      },
    );
  }

  nextActions.push({
    command: "GET /docs",
    description: "List indexed documents",
  });

  for (const facet of conceptFacets.slice(0, 3)) {
    nextActions.push({
      command: buildSearchCommand({
        q,
        perPage,
        semantic,
        concept: facet.concept,
        docId,
        expand,
        assemble,
      }),
      description: `Drill into ${facet.label} results`,
    });
  }

  return jsonResponse(
    ok(
      command,
      {
        query: q,
        semantic,
        perPage,
        found,
        page: response.page || page,
        hits,
        docSummaries,
        conceptFacets,
        ...(expand ? { expandedConcepts } : {}),
        filters: {
          ...(concept ? { concept } : {}),
          ...(conceptIds.length > 0 ? { concepts: conceptIds.join(",") } : {}),
          ...(docId ? { docId } : {}),
          expand,
          assemble,
        },
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleDocsList(url: URL, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const page = requirePositiveInt(firstQueryParam(url.searchParams, "page"), 1);
  const perPage = Math.min(
    requirePositiveInt(firstQueryParam(url.searchParams, "perPage", "per_page", "limit"), 20),
    100,
  );

  const params = new URLSearchParams({
    q: "*",
    query_by: "title,filename",
    page: String(page),
    per_page: String(perPage),
    include_fields:
      "id,title,filename,summary,tags,added_at,nas_path,storage_category,document_type,file_type",
  });

  const response = await typesenseSearch("docs", params);
  const docs = (response.hits || []).map((hit) => hit.document || {});
  const first = docs[0];
  const firstId = asString(first?.id);

  const nextActions: NextAction[] = [
    {
      command: "GET /search?q=<query>",
      description: "Search chunk content",
    },
    {
      command: "GET /docs/search?q=<query>",
      description: "Search document metadata",
    },
  ];

  if (firstId) {
    nextActions.push(
      {
        command: `GET /docs/${firstId}`,
        description: "Fetch the first listed document",
      },
      ...buildDocExplorationNextActions(firstId, asString(first?.title) || undefined),
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        found: response.found || 0,
        page: response.page || page,
        perPage,
        docs,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleDocsSearch(url: URL, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const q = url.searchParams.get("q")?.trim() || "";
  if (!q) {
    return jsonResponse(
      fail(command, "INVALID_QUERY", "Missing q query parameter"),
      400,
    );
  }

  const concept = firstQueryParam(url.searchParams, "concept");
  const page = requirePositiveInt(firstQueryParam(url.searchParams, "page"), 1);
  const perPage = Math.min(
    requirePositiveInt(firstQueryParam(url.searchParams, "perPage", "per_page"), 20),
    100,
  );

  const params = new URLSearchParams({
    q,
    query_by: "title,filename,summary,tags",
    page: String(page),
    per_page: String(perPage),
    include_fields:
      "id,title,filename,summary,tags,storage_category,document_type,file_type,primary_concept_id,concept_ids,added_at",
  });

  if (concept) {
    params.set("filter_by", `primary_concept_id:=${quoteFilterValue(concept)}`);
  }

  const response = await typesenseSearch("docs", params);
  const docs = (response.hits || []).map((hit) => hit.document || {});
  const firstDocId = asString(docs[0]?.id);
  const nextActions: NextAction[] = [
    {
      command: `GET /search?q=${encodeURIComponent(q)}`,
      description: "Search chunk content for the same query",
    },
    {
      command: "GET /docs",
      description: "List indexed documents",
    },
  ];

  if (firstDocId) {
    nextActions.push(
      {
        command: `GET /docs/${firstDocId}`,
        description: "Fetch the first matching document",
      },
      ...buildDocExplorationNextActions(firstDocId, q),
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        query: q,
        concept: concept || null,
        found: response.found || 0,
        page: response.page || page,
        perPage,
        docs,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleDocById(id: string, path: string): Promise<Response> {
  const command = `GET ${path}`;

  // Check cache first
  const cachedDoc = docCache.get(id);
  if (cachedDoc) {
    const docId = asString(cachedDoc.id) || id;
    return jsonResponse(
      ok(
        command,
        cachedDoc,
        buildDocExplorationNextActions(docId, asString(cachedDoc.title) || docId),
      ),
    );
  }

  const response = await typesenseGetById("docs", id);
  if (response.status === 404) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Document not found: ${id}`),
      404,
    );
  }

  const doc = response.body || {};
  docCache.set(id, doc);

  const docId = asString(doc.id) || id;
  docByIdCache.set(docId, doc);
  return jsonResponse(
    ok(
      command,
      doc,
      buildDocExplorationNextActions(docId, asString(doc.title) || docId),
    ),
  );
}

async function handleDocChunks(docId: string, url: URL, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const page = requirePositiveInt(firstQueryParam(url.searchParams, "page"), 1);
  const perPage = Math.min(
    requirePositiveInt(firstQueryParam(url.searchParams, "perPage", "per_page"), 50),
    200,
  );
  const chunkType = firstQueryParam(url.searchParams, "type");

  const filters = [`doc_id:=${quoteFilterValue(docId)}`];
  if (chunkType === "section" || chunkType === "snippet") {
    filters.push(`chunk_type:=${chunkType}`);
  }

  const response = await typesenseSearch(
    DOCS_CHUNKS_COLLECTION,
    new URLSearchParams({
      q: "*",
      query_by: "content",
      filter_by: filters.join(" && "),
      sort_by: "chunk_index:asc",
      page: String(page),
      per_page: String(perPage),
      include_fields:
        "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,content",
      exclude_fields: "retrieval_text,embedding",
    }),
  );

  const chunks = (response.hits || []).map((hit) => hit.document || {});
  const firstChunkId = asString(chunks[0]?.id);
  const nextActions: NextAction[] = [
    {
      command: `GET /docs/${docId}`,
      description: "Fetch parent document metadata",
    },
    {
      command: `GET /docs/${docId}/toc`,
      description: "Browse the document table of contents",
    },
    {
      command: `GET /docs/${docId}/markdown`,
      description: "Read the full markdown artifact",
    },
    {
      command: `GET /docs/${docId}/summary`,
      description: "View the document summary and taxonomy",
    },
  ];

  if (firstChunkId) {
    nextActions.push({
      command: `GET /chunks/${firstChunkId}`,
      description: "Fetch the first listed chunk",
    });
  }

  return jsonResponse(
    ok(
      command,
      {
        docId,
        chunkType: chunkType === "section" || chunkType === "snippet" ? chunkType : null,
        found: response.found || 0,
        page: response.page || page,
        perPage,
        chunks,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function listDocSectionChunks(docId: string): Promise<Record<string, unknown>[]> {
  const perPage = 250;
  const sections: Record<string, unknown>[] = [];
  let page = 1;

  while (true) {
    const response = await typesenseSearch(
      DOCS_CHUNKS_COLLECTION,
      new URLSearchParams({
        q: "*",
        query_by: "content",
        filter_by: `doc_id:=${quoteFilterValue(docId)} && chunk_type:=section`,
        sort_by: "chunk_index:asc",
        page: String(page),
        per_page: String(perPage),
        include_fields: "id,chunk_index,heading_path",
      }),
    );

    const hits = response.hits || [];
    sections.push(...hits.map((hit) => hit.document || {}));

    if (hits.length === 0 || hits.length < perPage || sections.length >= (response.found || 0)) {
      break;
    }

    page += 1;
  }

  return sections;
}

async function handleDocToc(docId: string, path: string): Promise<Response> {
  const command = `GET ${path}`;

  // Check cache first
  const cachedSections = tocCache.get(docId);
  if (cachedSections) {
    const toc: Array<{
      depth: number;
      title: string;
      path: string[];
      chunkId: string;
      chunkIndex: number | null;
    }> = [];
    const seen = new Set<string>();

    for (const doc of cachedSections) {
      const headingPath = asStringArray(doc.heading_path);
      const key = headingPath.length > 0 ? headingPath.join(" > ") : "__document__";
      if (seen.has(key)) continue;
      seen.add(key);
      toc.push({
        depth: headingPath.length,
        title: headingPath[headingPath.length - 1] || "Document",
        path: headingPath,
        chunkId: asString(doc.id) || "",
        chunkIndex: asNumber(doc.chunk_index),
      });
    }

    const nextActions: NextAction[] = [
      {
        command: `GET /docs/${docId}`,
        description: "Fetch document metadata",
      },
      {
        command: `GET /docs/${docId}/chunks?type=section`,
        description: "List section chunks for this document",
      },
      {
        command: `GET /docs/${docId}/markdown`,
        description: "Read the full markdown artifact",
      },
      {
        command: `GET /docs/${docId}/summary`,
        description: "View the document summary and taxonomy",
      },
    ];

    if (toc[0]?.chunkId) {
      nextActions.push({
        command: `GET /chunks/${toc[0].chunkId}`,
        description: "Fetch the first TOC section chunk",
      });
    }

    return jsonResponse(
      ok(
        command,
        {
          docId,
          entries: toc.length,
          toc,
        },
        dedupeNextActions(nextActions),
      ),
    );
  }

  const sections = await listDocSectionChunks(docId);
  tocCache.set(docId, sections);

  const toc: Array<{
    depth: number;
    title: string;
    path: string[];
    chunkId: string;
    chunkIndex: number | null;
  }> = [];
  const seen = new Set<string>();

  for (const doc of sections) {
    const headingPath = asStringArray(doc.heading_path);
    const key = headingPath.length > 0 ? headingPath.join(" > ") : "__document__";
    if (seen.has(key)) continue;
    seen.add(key);
    toc.push({
      depth: headingPath.length,
      title: headingPath[headingPath.length - 1] || "Document",
      path: headingPath,
      chunkId: asString(doc.id) || "",
      chunkIndex: asNumber(doc.chunk_index),
    });
  }

  const nextActions: NextAction[] = [
    {
      command: `GET /docs/${docId}`,
      description: "Fetch document metadata",
    },
    {
      command: `GET /docs/${docId}/chunks?type=section`,
      description: "List section chunks for this document",
    },
    {
      command: `GET /docs/${docId}/markdown`,
      description: "Read the full markdown artifact",
    },
    {
      command: `GET /docs/${docId}/summary`,
      description: "View the document summary and taxonomy",
    },
  ];

  if (toc[0]?.chunkId) {
    nextActions.push({
      command: `GET /chunks/${toc[0].chunkId}`,
      description: "Fetch the first TOC section chunk",
    });
  }

  return jsonResponse(
    ok(
      command,
      {
        docId,
        entries: toc.length,
        toc,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleChunkById(id: string, path: string, url: URL): Promise<Response> {
  const command = `GET ${path}`;
  const response = await typesenseGetById(DOCS_CHUNKS_COLLECTION, id);
  if (response.status === 404) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Chunk not found: ${id}`),
      404,
    );
  }

  const includeEmbedding = parseBoolean(
    firstQueryParam(url.searchParams, "includeEmbedding", "embedding"),
    true,
  );
  const lite = parseBoolean(firstQueryParam(url.searchParams, "lite"), false);

  const chunk = { ...(response.body || {}) };
  const docId = asString(chunk.doc_id);
  const prevChunkId = asString(chunk.prev_chunk_id);
  const nextChunkId = asString(chunk.next_chunk_id);
  const parentChunkId = asString(chunk.parent_chunk_id);

  if (!includeEmbedding) {
    delete chunk.embedding;
  }

  if (lite) {
    const content = asString(chunk.content) || "";
    chunk.contentPreview = content.slice(0, 320);
    delete chunk.content;
    delete chunk.retrieval_text;
    delete chunk.embedding;
  }

  const nextActions: NextAction[] = [];
  if (docId) {
    nextActions.push(
      {
        command: `GET /docs/${docId}`,
        description: "Fetch parent document",
      },
      {
        command: `GET /docs/${docId}/toc`,
        description: "Browse the document TOC",
      },
      {
        command: `GET /docs/${docId}/markdown`,
        description: "Read the full markdown artifact",
      },
      {
        command: `GET /docs/${docId}/summary`,
        description: "View the document summary and taxonomy",
      },
    );
  }

  if (parentChunkId) {
    nextActions.push({
      command: `GET /chunks/${parentChunkId}`,
      description: "Read the parent section chunk",
    });
  }

  if (prevChunkId) {
    nextActions.push({
      command: `GET /chunks/${prevChunkId}`,
      description: "Navigate to the previous sequential chunk",
    });
  }

  if (nextChunkId) {
    nextActions.push({
      command: `GET /chunks/${nextChunkId}`,
      description: "Navigate to the next sequential chunk",
    });
  }

  return jsonResponse(ok(command, chunk, dedupeNextActions(nextActions)));
}

async function handleConceptsList(path: string): Promise<Response> {
  const command = `GET ${path}`;
  const counts = await getConceptCounts();
  const concepts = TAXONOMY_CONCEPTS.map((concept) => buildConceptResponse(concept, counts));
  const first = concepts[0];

  const nextActions: NextAction[] = [
    {
      command: "GET /docs",
      description: "List indexed documents",
    },
    {
      command: "GET /search?q=<query>",
      description: "Search chunk content before drilling into taxonomy",
    },
  ];

  if (first?.id) {
    nextActions.push(
      {
        command: `GET /concepts/${first.id}`,
        description: "Inspect the first concept",
      },
      {
        command: `GET /concepts/${first.id}/docs?page=1&perPage=20`,
        description: "List documents for the first concept",
      },
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        found: concepts.length,
        concepts,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleConceptById(conceptId: string, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const concept = getConceptById(conceptId);
  if (!concept) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Concept not found: ${conceptId}`),
      404,
    );
  }

  const counts = await getConceptCounts();
  const topDocs = await listTopDocsForConcept(concept.id);
  const firstTopDocId = asString(topDocs[0]?.id);
  const nextActions: NextAction[] = [
    {
      command: "GET /concepts",
      description: "List all concepts",
    },
    {
      command: `GET /concepts/${concept.id}/docs?page=1&perPage=20`,
      description: "List documents in this concept",
    },
  ];

  if (firstTopDocId) {
    nextActions.push(
      {
        command: `GET /docs/${firstTopDocId}`,
        description: "Fetch the top document",
      },
      ...buildDocExplorationNextActions(firstTopDocId),
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        ...buildConceptResponse(concept, counts),
        topDocs,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

async function handleConceptDocs(url: URL, conceptId: string, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const concept = getConceptById(conceptId);
  if (!concept) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Concept not found: ${conceptId}`),
      404,
    );
  }

  const page = requirePositiveInt(firstQueryParam(url.searchParams, "page"), 1);
  const perPage = Math.min(
    requirePositiveInt(firstQueryParam(url.searchParams, "perPage", "per_page", "limit"), 20),
    100,
  );

  const response = await typesenseSearch(
    "docs",
    new URLSearchParams({
      q: "*",
      query_by: "title,filename",
      filter_by: `primary_concept_id:=${quoteFilterValue(concept.id)}`,
      page: String(page),
      per_page: String(perPage),
      include_fields: DOCS_INCLUDE_FIELDS,
    }),
  );

  const docs = (response.hits || []).map((hit) => hit.document || {});
  const firstDocId = asString(docs[0]?.id);
  const nextActions: NextAction[] = [
    {
      command: `GET /concepts/${concept.id}`,
      description: "Fetch concept details",
    },
    {
      command: "GET /concepts",
      description: "List all concepts",
    },
  ];

  if (firstDocId) {
    nextActions.push(
      {
        command: `GET /docs/${firstDocId}`,
        description: "Fetch the first document in this concept",
      },
      ...buildDocExplorationNextActions(firstDocId),
    );
  }

  return jsonResponse(
    ok(
      command,
      {
        concept: {
          id: concept.id,
          prefLabel: concept.prefLabel,
        },
        found: response.found || 0,
        page: response.page || page,
        perPage,
        docs,
      },
      dedupeNextActions(nextActions),
    ),
  );
}

function unauthorized(path: string): Response {
  return jsonResponse(
    fail(
      `GET ${path}`,
      "UNAUTHORIZED",
      "Bearer token required",
      { fix: "Set Authorization: Bearer <token>" },
    ),
    401,
  );
}

function misconfigured(path: string, code: string, message: string): Response {
  return jsonResponse(fail(`GET ${path}`, code, message), 503);
}

const server = Bun.serve({
  hostname: HOST,
  port: Number.isFinite(PORT) ? PORT : 3838,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = parsePath(request.url);
    const method = request.method.toUpperCase();

    if (method !== "GET") {
      return jsonResponse(
        fail(`${method} ${path}`, "METHOD_NOT_ALLOWED", "Only GET is supported"),
        405,
      );
    }

    if (path === "/health") {
      return handleHealth(path);
    }

    if (!API_TOKEN) {
      return misconfigured(path, "TOKEN_NOT_CONFIGURED", "PDF_BRAIN_API_TOKEN is not configured");
    }

    if (!isAuthorized(request)) {
      return unauthorized(path);
    }

    try {
      if (path === "/") {
        return jsonResponse(
          ok(
            `GET ${path}`,
            {
              routes: [
                "GET /status",
                "GET /search?q=<query>[&page=1][&perPage=10][&semantic=true|false][&concept=<id>][&concepts=<id1>,<id2>][&doc_id=<id>][&expand=true|false][&assemble=true|false]",
                "GET /docs/search?q=<query>[&concept=<id>][&page=1][&perPage=20]",
                "GET /docs/:id/toc",
                "GET /docs/:id/chunks[?type=section|snippet][&page=1][&perPage=50]",
                "GET /docs/:id/markdown",
                "GET /docs/:id/summary",
                "GET /docs/:id/artifact/meta",
                "GET /docs/:id",
                "GET /docs[?page=1][&perPage=20]",
                "GET /chunks/:id[?lite=true][&includeEmbedding=false]",
                "GET /concepts",
                "GET /concepts/:id",
                "GET /concepts/:id/docs[?page=1][&perPage=20]",
                "GET /health",
              ],
              agentInstructions: {
                overview:
                  "PDF Brain API — search and read 600+ indexed books with taxonomy-classified, semantically-chunked content. Nomic 768-dim embeddings for retrieval-tuned vector search.",
                gettingStarted:
                  "Start with GET /search?q=your+question to find relevant chunks. Use &semantic=true (default) for meaning-based search, &expand=true to discover related concepts, &assemble=true to attach parent section context to snippet hits.",
                expandingContext: [
                  "1. Search: GET /search?q=query — returns chunk-level hits with headingPath and snippet",
                  "2. If a hit is interesting, fetch the full chunk: GET /chunks/:chunkId",
                  "3. For broader context, fetch the parent document TOC: GET /docs/:docId/toc — shows the full heading hierarchy",
                  "4. To read the full section around a chunk, use: GET /docs/:docId/chunks?type=section — sequential section chunks",
                  "5. For the complete book text: GET /docs/:docId/markdown — raw structured markdown with headings and tables",
                  "6. For document-level summary and taxonomy: GET /docs/:docId/summary",
                  "7. To explore by domain: GET /concepts — browse the SKOS taxonomy, then GET /concepts/:id/docs to find books in that domain",
                ],
                searchTips: [
                  "Use &concept=jc:docs:programming to narrow by domain",
                  "Use &doc_id=<id> to search within a specific book",
                  "Use &assemble=true to get parent section content alongside snippet hits (richer context for RAG)",
                  "Use &expand=true to discover results from related domains (e.g. programming → AI)",
                  "Combine: GET /search?q=distributed+consensus&semantic=true&expand=true&assemble=true for maximum context",
                ],
                collections: {
                  active: DOCS_CHUNKS_COLLECTION,
                  note:
                    "v2 uses nomic-embed-text-v1.5 (768-dim, retrieval-tuned). v1 used MiniLM-L12 (384-dim).",
                },
              },
              mountedPrefixes: ["/", OPTIONAL_PATH_PREFIX],
            },
            [
              {
                command: "GET /status",
                description: "Inspect docs-api version, collections, and artifact availability",
              },
              {
                command: "GET /search?q=<query>",
                description: "Start with chunk-level semantic search",
              },
              {
                command: "GET /concepts",
                description: "Browse the taxonomy before filtering searches",
              },
            ],
          ),
        );
      }

      if (path === "/status") {
        return await handleStatus(path);
      }

      if (path === "/search") {
        return await handleSearch(url, path);
      }

      if (path === "/docs/search") {
        return await handleDocsSearch(url, path);
      }

      if (path === "/concepts") {
        return await handleConceptsList(path);
      }

      const conceptDocsMatch = path.match(/^\/concepts\/([^/]+)\/docs$/);
      if (conceptDocsMatch) {
        return await handleConceptDocs(url, decodeURIComponent(conceptDocsMatch[1] || ""), path);
      }

      const conceptMatch = path.match(/^\/concepts\/([^/]+)$/);
      if (conceptMatch) {
        return await handleConceptById(decodeURIComponent(conceptMatch[1] || ""), path);
      }

      const docsTocMatch = path.match(/^\/docs\/([^/]+)\/toc$/);
      if (docsTocMatch) {
        return await handleDocToc(decodeURIComponent(docsTocMatch[1] || ""), path);
      }

      const docsMarkdownMatch = path.match(/^\/docs\/([^/]+)\/markdown$/);
      if (docsMarkdownMatch) {
        return await handleDocMarkdown(decodeURIComponent(docsMarkdownMatch[1] || ""), path);
      }

      const docsSummaryMatch = path.match(/^\/docs\/([^/]+)\/summary$/);
      if (docsSummaryMatch) {
        return await handleDocSummary(decodeURIComponent(docsSummaryMatch[1] || ""), path);
      }

      const docsArtifactMetaMatch = path.match(/^\/docs\/([^/]+)\/artifact\/meta$/);
      if (docsArtifactMetaMatch) {
        return await handleDocSummary(decodeURIComponent(docsArtifactMetaMatch[1] || ""), path);
      }

      const docsChunksMatch = path.match(/^\/docs\/([^/]+)\/chunks$/);
      if (docsChunksMatch) {
        return await handleDocChunks(decodeURIComponent(docsChunksMatch[1] || ""), url, path);
      }

      const docsMatch = path.match(/^\/docs\/([^/]+)$/);
      if (docsMatch) {
        return await handleDocById(decodeURIComponent(docsMatch[1] || ""), path);
      }

      if (path === "/docs") {
        return await handleDocsList(url, path);
      }

      const chunksMatch = path.match(/^\/chunks\/([^/]+)$/);
      if (chunksMatch) {
        return await handleChunkById(decodeURIComponent(chunksMatch[1] || ""), path, url);
      }

      return jsonResponse(
        fail(`GET ${path}`, "NOT_FOUND", `No route for ${path}`),
        404,
      );
    } catch (error) {
      return jsonResponse(
        fail(
          `GET ${path}`,
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : String(error),
        ),
        500,
      );
    }
  },
});

console.log(`[docs-api] listening on http://${server.hostname}:${server.port}`);
console.log(`[docs-api] typesense=${TYPESENSE_URL}`);
