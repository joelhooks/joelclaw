/**
 * Fetch a single Typesense document by collection + ID.
 * Owner-only. Used by detail pages for memory, syslog, voice.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "../../../../../lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

const ALLOWED = new Set(["memory_observations", "system_log", "voice_transcripts", "discoveries"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ collection: string; id: string }> }
) {
  const authed = await isAuthenticated().catch(() => false);
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { collection, id } = await params;
  if (!ALLOWED.has(collection)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  try {
    const resp = await fetch(
      `${TYPESENSE_URL}/collections/${collection}/documents/${id}`,
      { headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY } }
    );
    if (!resp.ok) {
      return NextResponse.json({ error: "Not found" }, { status: resp.status });
    }
    return NextResponse.json(await resp.json());
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  }
}
