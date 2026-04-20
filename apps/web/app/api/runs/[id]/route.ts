/**
 * ADR-0243: GET /api/runs/:id — fetch a Run's metadata row.
 *
 * Privacy: the caller's user_id must be in the Run's readable_by list
 * (Rule 4). Not the caller's to spoof.
 */
import { RUNS_COLLECTION } from "@joelclaw/memory";
import { type NextRequest, NextResponse } from "next/server";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

const DEV_BEARER_TOKENS: Record<string, { user_id: string; machine_id: string }> =
  (() => {
    const raw = process.env.MEMORY_DEV_BEARER_TOKENS;
    if (!raw) {
      return { "dev-joel-panda": { user_id: "joel", machine_id: "panda" } };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

function authenticate(
  request: NextRequest
): { user_id: string; machine_id: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return DEV_BEARER_TOKENS[token] ?? null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = authenticate(request);
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await context.params;

  const res = await fetch(
    `${TYPESENSE_URL}/collections/${RUNS_COLLECTION}/documents/${encodeURIComponent(id)}`,
    {
      headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY },
    }
  );

  if (res.status === 404) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", run_id: id } },
      { status: 404 }
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "typesense_error",
          message: `typesense ${res.status}`,
          detail: (await res.text()).slice(0, 500),
        },
      },
      { status: 502 }
    );
  }

  const doc = (await res.json()) as {
    readable_by?: string[];
    [k: string]: unknown;
  };

  // Enforce Rule 4 at read time (defense in depth — the chunk index also
  // denormalizes readable_by, but Run row isn't filtered the same way).
  if (!doc.readable_by?.includes(auth.user_id)) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", run_id: id } },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    run: doc,
    _links: {
      self: `/api/runs/${id}`,
      jsonl: `/api/runs/${id}/jsonl`,
      descendants: `/api/runs/${id}/descendants`,
      search_conversation: doc.conversation_id
        ? `/api/runs/search?conversation_id=${doc.conversation_id}`
        : undefined,
    },
  });
}
