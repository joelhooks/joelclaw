/**
 * ADR-0243: POST /api/runs/search — hybrid search over Run chunks.
 *
 * Primary interface per Rule 13 (D — one hybrid search + convenience traversal).
 * Rule 12 (agent-first) shapes: HATEOAS envelope, stable JSON, rich
 * _links + next_actions, deterministic ordering, tag filters default to AND.
 *
 * Auto-applied privacy filters from the bearer token (Rule 4):
 *   - user_id: caller
 *   - readable_by CONTAINS caller
 * These are NEVER read from the request body. There is no way to spoof
 * privacy from the client.
 *
 * v1 scope:
 *   - Dev bearer token auth (PDS flow lands Phase 3)
 *   - Hybrid default; semantic and keyword modes available
 *   - Embeds the query at priority="query" so it preempts any ingest-bulk
 *     or ingest-realtime work queued in Ollama
 */
import { type EmbeddingPriority, embed } from "@joelclaw/inference-router";
import { RUN_CHUNKS_COLLECTION } from "@joelclaw/memory";
import { type NextRequest, NextResponse } from "next/server";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";
const EMBED_DIMS = 768;

const DEV_BEARER_TOKENS: Record<string, { user_id: string; machine_id: string }> =
  (() => {
    const raw = process.env.MEMORY_DEV_BEARER_TOKENS;
    if (!raw) {
      return {
        "dev-joel-panda": { user_id: "joel", machine_id: "panda" },
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

type Mode = "hybrid" | "semantic" | "keyword";

interface SearchRequest {
  query: string;
  mode?: Mode;
  filters?: {
    tags?: string[];
    agent_runtime?: string[];
    machine_id?: string;
    conversation_id?: string;
    root_run_id?: string;
    started_at?: { gte?: number; lte?: number };
  };
  facets?: string[];
  limit?: number;
}

function authenticate(
  request: NextRequest
): { user_id: string; machine_id: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return DEV_BEARER_TOKENS[token] ?? null;
}

function buildFilterBy(
  userId: string,
  filters?: SearchRequest["filters"]
): string {
  // Auto-applied — caller cannot override these.
  const parts: string[] = [`readable_by:=\`${userId}\``];
  if (filters?.tags?.length) {
    // AND semantics: all tags must be present.
    for (const tag of filters.tags) {
      parts.push(`tags:=\`${tag}\``);
    }
  }
  if (filters?.agent_runtime?.length) {
    const list = filters.agent_runtime.map((r) => `\`${r}\``).join(",");
    parts.push(`agent_runtime:=[${list}]`);
  }
  if (filters?.machine_id) {
    parts.push(`machine_id:=\`${filters.machine_id}\``);
  }
  if (filters?.conversation_id) {
    parts.push(`conversation_id:=\`${filters.conversation_id}\``);
  }
  if (filters?.root_run_id) {
    parts.push(`root_run_id:=\`${filters.root_run_id}\``);
  }
  if (filters?.started_at?.gte !== undefined) {
    parts.push(`started_at:>=${filters.started_at.gte}`);
  }
  if (filters?.started_at?.lte !== undefined) {
    parts.push(`started_at:<=${filters.started_at.lte}`);
  }
  return parts.join(" && ");
}

export async function POST(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "unauthorized", message: "bearer token required" },
      },
      { status: 401 }
    );
  }

  let body: SearchRequest;
  try {
    body = (await request.json()) as SearchRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "body must be JSON" } },
      { status: 400 }
    );
  }

  const query = (body.query ?? "").trim();
  if (!query) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "missing_query", message: "`query` required" },
      },
      { status: 400 }
    );
  }

  const mode: Mode = body.mode ?? "hybrid";
  const limit = Math.min(Math.max(body.limit ?? 20, 1), 100);
  const filterBy = buildFilterBy(auth.user_id, body.filters);
  const facets = body.facets?.join(",");

  const tEmbedStart = performance.now();
  let vectorQuery: string | undefined;
  let queryEmbedMs = 0;
  let queryQueuedMs = 0;

  if (mode !== "keyword") {
    const result = await embed(query, {
      priority: "query" as EmbeddingPriority,
      dimensions: EMBED_DIMS,
    });
    vectorQuery = `embedding:([${result.embedding.join(",")}], k:${limit * 2})`;
    queryEmbedMs = Math.round(result.total_ms);
    queryQueuedMs = Math.round(result.queued_ms);
  }

  const searchBody = {
    searches: [
      {
        collection: RUN_CHUNKS_COLLECTION,
        q: mode === "semantic" ? "*" : query,
        query_by: "text",
        ...(vectorQuery && { vector_query: vectorQuery }),
        filter_by: filterBy,
        per_page: limit,
        ...(facets && { facet_by: facets }),
        include_fields:
          "id,run_id,chunk_idx,role,text,agent_runtime,tags,conversation_id,machine_id,started_at",
      },
    ],
  };

  const tSearchStart = performance.now();
  const res = await fetch(`${TYPESENSE_URL}/multi_search`, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchBody),
  });
  const tSearchEnd = performance.now();

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "typesense_error",
          message: `typesense search failed: ${res.status}`,
          detail: errText.slice(0, 500),
        },
      },
      { status: 502 }
    );
  }

  const data = (await res.json()) as {
    results: Array<{
      found: number;
      hits: Array<{
        document: Record<string, unknown>;
        vector_distance?: number;
        text_match?: number;
      }>;
      facet_counts?: Array<{
        field_name: string;
        counts: Array<{ value: string; count: number }>;
      }>;
    }>;
  };

  const result = data.results[0];
  const hits = (result?.hits ?? []).map((hit) => ({
    run_id: hit.document.run_id,
    chunk_idx: hit.document.chunk_idx,
    role: hit.document.role,
    text: hit.document.text,
    agent_runtime: hit.document.agent_runtime,
    tags: hit.document.tags,
    conversation_id: hit.document.conversation_id,
    machine_id: hit.document.machine_id,
    started_at: hit.document.started_at,
    score: {
      vector_distance: hit.vector_distance,
      text_match: hit.text_match,
    },
    _links: {
      run: `/api/runs/${hit.document.run_id}`,
      jsonl: `/api/runs/${hit.document.run_id}/jsonl`,
      conversation: hit.document.conversation_id
        ? `/api/runs/search?conversation_id=${hit.document.conversation_id}`
        : undefined,
    },
  }));

  return NextResponse.json(
    {
      ok: true,
      count: hits.length,
      total_matched: result?.found ?? 0,
      mode,
      hits,
      facets:
        result?.facet_counts?.reduce<Record<string, Record<string, number>>>(
          (acc, f) => {
            acc[f.field_name] = Object.fromEntries(
              f.counts.map((c) => [c.value, c.count])
            );
            return acc;
          },
          {}
        ) ?? {},
      timing: {
        query_embed_ms: queryEmbedMs,
        query_queued_ms: queryQueuedMs,
        typesense_ms: Math.round(tSearchEnd - tSearchStart),
        total_ms: Math.round(tSearchEnd - tEmbedStart),
      },
      next_actions: [
        {
          description: "Retrieve as context for prompt injection (Phase 6)",
          command: `POST /api/memory/retrieve { run_ids: [${hits
            .slice(0, 3)
            .map((h) => `"${h.run_id}"`)
            .join(", ")}] }`,
        },
      ],
    },
    { status: 200 }
  );
}
