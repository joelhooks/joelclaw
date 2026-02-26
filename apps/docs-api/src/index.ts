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

type TypesenseSearchResponse = {
  found?: number;
  page?: number;
  hits?: TypesenseSearchHit[];
};

const PROTOCOL_VERSION = 1 as const;
const SERVICE_VERSION = "0.1.1";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3838", 10);
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://typesense:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";
const API_TOKEN = process.env.PDF_BRAIN_API_TOKEN || process.env.pdf_brain_api_token || "";
const OPTIONAL_PATH_PREFIX = "/api/docs";

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

function parseBoolean(
  value: string | null,
  fallback: boolean,
): boolean {
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
