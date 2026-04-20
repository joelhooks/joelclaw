/**
 * ADR-0243: GET /api/runs/forest — flat listing of the caller's Runs with
 * parent/root linkage for client-side tree rendering.
 *
 * Matches the "global pi-tree" idea: a cross-runtime view of every Run the
 * caller can read (own + Share Granted), regardless of which agent produced
 * it. The client walks parent_run_id to build the visual tree; the server
 * returns a flat, deterministically-sorted list so the wire format is cheap.
 *
 * Filters:
 *   ?since=<ms>           only Runs started_at >= value (default: last 7d)
 *   ?runtime=<x>          comma-separated agent_runtime values
 *   ?root_run_id=<id>     only the named subtree
 *   ?limit=<n>            cap (default 500, max 2000)
 *
 * Privacy: auto-applied readable_by filter from bearer token (Rule 4).
 */
import { RUNS_COLLECTION } from "@joelclaw/memory";
import { type NextRequest, NextResponse } from "next/server";
import { authenticateMemoryRequest } from "@/lib/memory-auth";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const auth = await authenticateMemoryRequest(request);
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized" } },
      { status: 401 }
    );
  }

  const sp = request.nextUrl.searchParams;
  const sinceRaw = sp.get("since");
  const since = sinceRaw
    ? Number.parseInt(sinceRaw, 10)
    : Date.now() - DEFAULT_WINDOW_MS;
  const runtimes = sp
    .get("runtime")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rootRunId = sp.get("root_run_id");
  // Typesense caps per_page at 250.
  const limit = Math.min(
    Math.max(Number.parseInt(sp.get("limit") ?? "250", 10) || 250, 1),
    250
  );

  const filterParts: string[] = [
    `readable_by:=\`${auth.user_id}\``,
    `started_at:>=${since}`,
  ];
  if (runtimes?.length) {
    const list = runtimes.map((r) => `\`${r}\``).join(",");
    filterParts.push(`agent_runtime:=[${list}]`);
  }
  if (rootRunId) {
    filterParts.push(
      `(id:=\`${rootRunId}\` || root_run_id:=\`${rootRunId}\` || parent_run_id:=\`${rootRunId}\`)`
    );
  }

  const params = new URLSearchParams({
    q: "*",
    query_by: "intent",
    filter_by: filterParts.join(" && "),
    sort_by: "started_at:asc",
    per_page: String(limit),
    include_fields:
      "id,user_id,machine_id,agent_runtime,parent_run_id,root_run_id,conversation_id,tags,intent,started_at,ended_at,duration_ms,turn_count,user_turn_count,assistant_turn_count,tool_turn_count,tool_call_count,status",
  });

  const res = await fetch(
    `${TYPESENSE_URL}/collections/${RUNS_COLLECTION}/documents/search?${params}`,
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
  const roots = runs.filter(
    (r) => !r.parent_run_id || r.parent_run_id === null
  );

  return NextResponse.json({
    ok: true,
    count: runs.length,
    total_matched: data.found,
    window: {
      since,
      now: Date.now(),
      runtimes: runtimes ?? null,
      root_run_id: rootRunId,
    },
    runs,
    roots_count: roots.length,
    _links: {
      search: "/api/runs/search",
    },
    next_actions: [
      {
        description: "Narrow to a subtree",
        command: "GET /api/runs/forest?root_run_id=<id>",
      },
      {
        description: "Render as ASCII tree in terminal",
        command: "joelclaw-runs-tree",
      },
    ],
  });
}
