/**
 * Vault API — serves vault notes from Typesense for authenticated owner.
 * ADR-0075 + ADR-0082
 *
 * GET /api/vault — list all vault notes (path, title, type, tags)
 * GET /api/vault?path=Resources/articles/foo.md — full note content
 * GET /api/vault?q=search+term — search vault_notes only
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || "";

async function typesenseGet(path: string) {
  const resp = await fetch(`${TYPESENSE_URL}${path}`, {
    headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY },
  });
  if (!resp.ok) throw new Error(`Typesense ${resp.status}`);
  return resp.json();
}

async function typesenseSearch(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return typesenseGet(`/collections/vault_notes/documents/search?${qs}`);
}

export async function GET(request: NextRequest) {
  const authed = await isAuthenticated().catch(() => false);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  const q = request.nextUrl.searchParams.get("q");

  // Single note by path
  if (path) {
    try {
      const data = await typesenseSearch({
        q: path,
        query_by: "path",
        filter_by: `path:=${path}`,
        per_page: "1",
        include_fields: "title,path,content,type,tags",
      });
      const hit = data.hits?.[0]?.document;
      if (!hit) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(hit);
    } catch {
      return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
    }
  }

  // Search vault notes
  if (q) {
    try {
      const data = await typesenseSearch({
        q,
        query_by: "title,content",
        per_page: "30",
        highlight_full_fields: "title,content",
        exclude_fields: "embedding",
        include_fields: "title,path,type,tags",
      });
      const hits = (data.hits || []).map((h: any) => ({
        title: h.document.title,
        path: h.document.path,
        type: h.document.type,
        tags: h.document.tags,
        snippet: h.highlights?.[0]?.snippet?.slice(0, 200) || "",
      }));
      return NextResponse.json({ hits, found: data.found || 0 });
    } catch {
      return NextResponse.json({ error: "Search failed" }, { status: 502 });
    }
  }

  // List all vault notes (lightweight — no content)
  try {
    const data = await typesenseSearch({
      q: "*",
      query_by: "title",
      per_page: "250",
      include_fields: "title,path,type,tags",
      sort_by: "path:asc",
    });
    const notes = (data.hits || []).map((h: any) => ({
      title: h.document.title,
      path: h.document.path,
      type: h.document.type,
      tags: h.document.tags,
    }));
    // Group by top-level directory
    const tree: Record<string, typeof notes> = {};
    for (const note of notes) {
      const section = note.path?.split("/")[0] || "root";
      if (!tree[section]) tree[section] = [];
      tree[section].push(note);
    }
    return NextResponse.json({ tree, total: data.found || 0 });
  } catch (error) {
    return NextResponse.json(
      { error: "List failed", detail: String(error) },
      { status: 502 }
    );
  }
}
