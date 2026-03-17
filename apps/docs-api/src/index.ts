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

type ConceptId =
  | "jc:docs:general"
  | "jc:docs:programming"
  | "jc:docs:business"
  | "jc:docs:education"
  | "jc:docs:design"
  | "jc:docs:marketing"
  | "jc:docs:strategy"
  | "jc:docs:ai"
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
const SERVICE_VERSION = "0.1.3";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3838", 10);
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://typesense:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";
const API_TOKEN = process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";
const OPTIONAL_PATH_PREFIX = "/api/docs";
const DOCS_INCLUDE_FIELDS =
  "id,title,filename,summary,tags,added_at,nas_path,nas_paths,storage_category,document_type,file_type,primary_concept_id,concept_ids,taxonomy_version";
const CONCEPT_COUNTS_TTL_MS = 5 * 60 * 1000;

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
    narrower: [],
    related: ["jc:docs:ai"],
    scopeNote: "Software engineering, code, architecture, and technical implementation.",
  },
  {
    id: "jc:docs:business",
    prefLabel: "Business",
    altLabels: ["company", "finance", "entrepreneurship", "sales"],
    broader: [],
    narrower: [],
    related: ["jc:docs:marketing", "jc:docs:strategy"],
    scopeNote: "Business operations, management, finance, and growth.",
  },
  {
    id: "jc:docs:education",
    prefLabel: "Education",
    altLabels: ["learning", "teaching", "curriculum", "training"],
    broader: [],
    narrower: [],
    related: [],
    scopeNote: "Learning resources, instructional material, and pedagogy.",
  },
  {
    id: "jc:docs:design",
    prefLabel: "Design",
    altLabels: ["ux", "ui", "product design", "visual design"],
    broader: [],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Interface, product, systems, and visual design practices.",
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
    narrower: [],
    related: ["jc:docs:programming"],
    scopeNote: "Artificial intelligence, models, tooling, and agent systems.",
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

  if (options.semantic) {
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

  const response = await typesenseSearch(
    "docs_chunks",
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

  return parents;
}

function buildSearchCommand(options: {
  q: string;
  perPage: number;
  semantic: boolean;
  concept?: string;
  docId?: string;
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
  collection: "docs" | "docs_chunks",
  params: URLSearchParams,
): Promise<TypesenseSearchResponse> {
  const response = await typesenseRequest(`/collections/${collection}/documents/search?${params.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Typesense search failed (${response.status}): ${text}`);
  }
  return (await response.json()) as TypesenseSearchResponse;
}

async function typesenseGetById(collection: "docs" | "docs_chunks", id: string): Promise<{
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
      "docs_chunks",
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
    "docs_chunks",
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

  return jsonResponse(ok(command, healthResult));
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
    "docs_chunks",
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
        "docs_chunks",
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
    const parents = await fetchParentSections(
      mergedHits
        .filter((hit) => hit.chunkType === "snippet" && hit.parentChunkId)
        .map((hit) => hit.parentChunkId || ""),
    );

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
  const conceptFacets = buildConceptFacetsFromCounts(combinedFacetCounts);

  const first = hits[0];
  const nextActions: NextAction[] = [
    {
      command: "GET /docs",
      description: "List indexed documents",
    },
  ];

  if (first?.docId) {
    nextActions.push({
      command: `GET /docs/${first.docId}`,
      description: "Fetch matched document metadata",
    });
  }

  if (first?.id) {
    nextActions.push({
      command: `GET /chunks/${first.id}`,
      description: "Fetch full chunk content",
    });
  }

  for (const facet of conceptFacets.slice(0, 3)) {
    nextActions.push({
      command: buildSearchCommand({
        q,
        perPage,
        semantic,
        concept: facet.concept,
        docId,
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
      nextActions,
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
    nextActions.push({
      command: `GET /docs/${firstId}`,
      description: "Fetch first listed document",
    });
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
      nextActions,
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
      {
        command: `GET /docs/${firstDocId}/toc`,
        description: "Browse the first document table of contents",
      },
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
      nextActions,
    ),
  );
}

async function handleDocById(id: string, path: string): Promise<Response> {
  const command = `GET ${path}`;
  const response = await typesenseGetById("docs", id);
  if (response.status === 404) {
    return jsonResponse(
      fail(command, "NOT_FOUND", `Document not found: ${id}`),
      404,
    );
  }

  const doc = response.body || {};
  const docId = asString(doc.id) || id;
  return jsonResponse(
    ok(command, doc, [
      {
        command: `GET /search?q=${encodeURIComponent(asString(doc.title) || docId)}`,
        description: "Search related chunks",
      },
      {
        command: `GET /docs/${docId}/toc`,
        description: "Browse the document table of contents",
      },
      {
        command: `GET /docs/${docId}/chunks`,
        description: "List document chunks",
      },
    ]),
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
    "docs_chunks",
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
      nextActions,
    ),
  );
}

async function listDocSectionChunks(docId: string): Promise<Record<string, unknown>[]> {
  const perPage = 250;
  const sections: Record<string, unknown>[] = [];
  let page = 1;

  while (true) {
    const response = await typesenseSearch(
      "docs_chunks",
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
  const sections = await listDocSectionChunks(docId);

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
      nextActions,
    ),
  );
}

async function handleChunkById(id: string, path: string, url: URL): Promise<Response> {
  const command = `GET ${path}`;
  const response = await typesenseGetById("docs_chunks", id);
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
    nextActions.push({
      command: `GET /docs/${docId}`,
      description: "Fetch parent document",
    });
  }

  return jsonResponse(ok(command, chunk, nextActions));
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
      nextActions,
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
    nextActions.push({
      command: `GET /docs/${firstTopDocId}`,
      description: "Fetch the top document",
    });
  }

  return jsonResponse(
    ok(
      command,
      {
        ...buildConceptResponse(concept, counts),
        topDocs,
      },
      nextActions,
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
    nextActions.push({
      command: `GET /docs/${firstDocId}`,
      description: "Fetch the first document in this concept",
    });
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
      nextActions,
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
          ok(`GET ${path}`, {
            routes: [
              "GET /search?q=<query>[&page=1][&perPage=10][&semantic=true|false][&concept=<id>][&concepts=<id1>,<id2>][&doc_id=<id>][&expand=true|false][&assemble=true|false]",
              "GET /docs/search?q=<query>[&concept=<id>][&page=1][&perPage=20]",
              "GET /docs/:id/toc",
              "GET /docs/:id/chunks[?type=section|snippet][&page=1][&perPage=50]",
              "GET /docs/:id",
              "GET /docs[?page=1][&perPage=20]",
              "GET /chunks/:id[?lite=true][&includeEmbedding=false]",
              "GET /concepts",
              "GET /concepts/:id",
              "GET /concepts/:id/docs[?page=1][&perPage=20]",
              "GET /health",
            ],
            mountedPrefixes: ["/", OPTIONAL_PATH_PREFIX],
          }),
        );
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
