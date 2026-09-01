export const DOCS_API_PUBLIC_PATH = "/api/docs";

export type DocsApiUpstreamResolution =
  | { ok: true; url: string }
  | { ok: false; code: "MISSING" | "INVALID"; message: string };

export function resolveDocsApiUpstream(environment: {
  DOCS_API_UPSTREAM_URL?: string;
}): DocsApiUpstreamResolution {
  const configured = environment.DOCS_API_UPSTREAM_URL?.trim();

  if (!configured) {
    return {
      ok: false,
      code: "MISSING",
      message: "DOCS_API_UPSTREAM_URL is not configured",
    };
  }

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        code: "INVALID",
        message: "DOCS_API_UPSTREAM_URL must use HTTP or HTTPS",
      };
    }
    if (parsed.search || parsed.hash) {
      return {
        ok: false,
        code: "INVALID",
        message: "DOCS_API_UPSTREAM_URL must not contain a query or fragment",
      };
    }

    return {
      ok: true,
      url: parsed.toString().replace(/\/+$/, ""),
    };
  } catch {
    return {
      ok: false,
      code: "INVALID",
      message: "DOCS_API_UPSTREAM_URL is not a valid URL",
    };
  }
}

const jsonObjectResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
});

export function buildDocsOpenApi(origin: string, version: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Joelclaw Docs API",
      version,
      description:
        "Search and read Joelclaw's indexed document corpus through the public, rate-limited docs proxy.",
    },
    servers: [{ url: `${origin}${DOCS_API_PUBLIC_PATH}` }],
    paths: {
      "/": {
        get: {
          operationId: "discover_docs",
          summary: "Discover the docs API",
          description: "Return the docs API resource map, examples, and links.",
          responses: { "200": jsonObjectResponse("Discovery document") },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "get_openapi_schema",
          summary: "Get the OpenAPI schema",
          description: "Return the current Joelclaw docs API contract.",
          responses: { "200": jsonObjectResponse("OpenAPI document") },
        },
      },
      "/ui": {
        get: {
          operationId: "get_swagger_ui",
          summary: "Get the Swagger UI",
          description: "Return the human-readable Swagger UI HTML.",
          responses: {
            "200": {
              description: "Swagger UI HTML",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/health": {
        get: {
          operationId: "check_docs_health",
          summary: "Check docs API health",
          description: "Check whether the docs API and its search index are ready.",
          responses: { "200": jsonObjectResponse("Healthy docs API") },
        },
      },
      "/search": {
        get: {
          operationId: "search_docs",
          summary: "Search Joelclaw docs",
          description:
            "Search indexed document chunks. Use each returned chunk ID with get_chunk for exact source context.",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              description: "Search query",
              schema: { type: "string" },
            },
            {
              name: "page",
              in: "query",
              description: "One-based result page",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "perPage",
              in: "query",
              description: "Results per page",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            },
            {
              name: "semantic",
              in: "query",
              description: "Use semantic search when true",
              schema: { type: "boolean", default: false },
            },
          ],
          responses: { "200": jsonObjectResponse("Search results") },
        },
      },
      "/docs": {
        get: {
          operationId: "list_docs",
          summary: "List indexed documents",
          description: "Page through the indexed document catalog.",
          parameters: [
            {
              name: "page",
              in: "query",
              description: "One-based result page",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "perPage",
              in: "query",
              description: "Documents per page",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: { "200": jsonObjectResponse("Document page") },
        },
      },
      "/docs/{id}": {
        get: {
          operationId: "get_doc",
          summary: "Get a document by ID",
          description: "Return metadata and content for one indexed document.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "Document ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": jsonObjectResponse("Document"),
            "404": { description: "Document not found" },
          },
        },
      },
      "/chunks/{id}": {
        get: {
          operationId: "get_chunk",
          summary: "Get a source chunk by ID",
          description:
            "Return one exact source chunk. Use lite=true to omit heavy fields. Request embeddings only when vector data is required.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "Chunk ID",
              schema: { type: "string" },
            },
            {
              name: "lite",
              in: "query",
              description: "Return a lighter payload",
              schema: { type: "boolean", default: false },
            },
            {
              name: "includeEmbedding",
              in: "query",
              description: "Include embedding vectors",
              schema: { type: "boolean", default: false },
            },
          ],
          responses: {
            "200": jsonObjectResponse("Source chunk"),
            "404": { description: "Chunk not found" },
          },
        },
      },
    },
  } as const;
}
