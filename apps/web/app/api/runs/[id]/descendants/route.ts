/**
 * ADR-0243: GET /api/runs/:id/descendants — walk a Run's subtree.
 *
 * Returns every Run whose root_run_id equals :id (or whose id is :id itself
 * — the root is included). Ordered by started_at ascending so callers can
 * reconstruct the timeline. Privacy-filtered by readable_by.
 */
import { RUNS_COLLECTION } from "@joelclaw/memory";
import { type NextRequest, NextResponse } from "next/server";
import { authenticateMemoryRequest } from "@/lib/memory-auth";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateMemoryRequest(request);
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await context.params;

  const res = await fetch(
    `${TYPESENSE_URL}/collections/${RUNS_COLLECTION}/documents/search?${new URLSearchParams(
      {
        q: "*",
        query_by: "id",
        filter_by: `(id:=\`${id}\` || root_run_id:=\`${id}\`) && readable_by:=\`${auth.user_id}\``,
        sort_by: "started_at:asc",
        per_page: "250",
      }
    )}`,
    {
      headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY },
    }
  );

  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "typesense_error",
          detail: (await res.text()).slice(0, 500),
        },
      },
      { status: 502 }
    );
  }

  const data = (await res.json()) as {
    found: number;
    hits: Array<{ document: Record<string, unknown> }>;
  };

  const runs = data.hits.map((h) => h.document);

  if (runs.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", run_id: id } },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    root_run_id: id,
    count: runs.length,
    runs,
    _links: {
      root: `/api/runs/${id}`,
      search_subtree: `/api/runs/search?root_run_id=${id}`,
    },
  });
}
