/**
 * ADR-0243: GET /api/runs/:id/jsonl — stream the full transcript from NAS.
 *
 * Privacy: caller must be in the Run's readable_by (Rule 4). The Run row
 * in Typesense is the authority for that check; NAS is the authority for
 * the content itself (Rule 10).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
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

  const runRes = await fetch(
    `${TYPESENSE_URL}/collections/${RUNS_COLLECTION}/documents/${encodeURIComponent(id)}`,
    {
      headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY },
    }
  );

  if (runRes.status === 404) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", run_id: id } },
      { status: 404 }
    );
  }
  if (!runRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "typesense_error",
          detail: (await runRes.text()).slice(0, 500),
        },
      },
      { status: 502 }
    );
  }

  const run = (await runRes.json()) as {
    readable_by?: string[];
    jsonl_path?: string;
    jsonl_bytes?: number;
  };

  if (!run.readable_by?.includes(auth.user_id)) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", run_id: id } },
      { status: 404 }
    );
  }
  if (!run.jsonl_path) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "no_blob", message: "Run has no jsonl_path recorded" },
      },
      { status: 410 }
    );
  }

  try {
    await stat(run.jsonl_path);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "blob_missing",
          message: `jsonl blob not found on NAS at ${run.jsonl_path}`,
        },
      },
      { status: 410 }
    );
  }

  const stream = Readable.toWeb(
    createReadStream(run.jsonl_path)
  ) as unknown as ReadableStream;

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Length": String(run.jsonl_bytes ?? ""),
      "X-Run-Id": id,
    },
  });
}
