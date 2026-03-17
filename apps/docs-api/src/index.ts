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
const SERVICE_VERSION = "0.1.2";
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

function buildTypesenseUrl(path: string, params?: URLSearchParams): string {
  const base = TYPESENSE_URL.endsWith("/") ? TYPESENSE_URL.slice(0, -1) : TYPESENSE_URL;
  const query = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  return `${base}${path}${query}`;
}

function quoteFilterValue(value: string): string {
  const escaped = value.replace(/`/g, "\\`");
  return `\`${escaped}\``;
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

  const params = new URLSearchParams({
    q,
    page: String(page),
    query_by: semantic ? "retrieval_text,content,title,embedding" : "retrieval_text,content,title",
    per_page: String(perPage),
    include_fields:
      "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,taxonomy_version,evidence_tier,parent_evidence_id,source_entity_id,content",
    exclude_fields: "retrieval_text,embedding",
    highlight_full_fields: "content,retrieval_text",
  });

  if (semantic) {
    params.set("vector_query", `embedding:([], k:${Math.max(perPage * 3, 20)}, alpha:0.75)`);
  }

  const response = await typesenseSearch("docs_chunks", params);
  const hits = (response.hits || []).map((hit) => {
    const doc = hit.document || {};
    const snippet = hit.highlights?.find((entry) => entry.field === "content")?.snippet;
    return {
      id: asString(doc.id) || "",
      docId: asString(doc.doc_id) || "",
      title: asString(doc.title) || "",
      chunkType: asString(doc.chunk_type) || "",
      chunkIndex: doc.chunk_index,
      score: hit.hybrid_search_info?.rank_fusion_score || hit.text_match_info?.score || null,
      snippet: snippet || asString(doc.content)?.slice(0, 320) || "",
    };
  });

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

  return jsonResponse(
    ok(
      command,
      {
        query: q,
        semantic,
        perPage,
        found: response.found || 0,
        page: response.page || page,
        hits,
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
    ]),
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
              "GET /search?q=<query>[&page=1][&perPage=10][&semantic=true|false]",
              "GET /docs[&page=1][&perPage=20]",
              "GET /docs/:id",
              "GET /chunks/:id[?lite=true][&includeEmbedding=false]",
              "GET /concepts",
              "GET /concepts/:id",
              "GET /concepts/:id/docs[&page=1][&perPage=20]",
              "GET /health",
            ],
            mountedPrefixes: ["/", OPTIONAL_PATH_PREFIX],
          }),
        );
      }

      if (path === "/search") {
        return await handleSearch(url, path);
      }

      if (path === "/docs") {
        return await handleDocsList(url, path);
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

      const docsMatch = path.match(/^\/docs\/([^/]+)$/);
      if (docsMatch) {
        return await handleDocById(decodeURIComponent(docsMatch[1] || ""), path);
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
