#!/usr/bin/env bun
/**
 * Migrate all observations from Qdrant → Typesense memory_observations collection.
 * Reads all points from Qdrant, maps payload → Typesense document, bulk upserts.
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_COLLECTION = "memory_observations";
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY!;

if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY required");
  process.exit(1);
}

interface QdrantPoint {
  id: string;
  payload: {
    observation?: string;
    source?: string;
    session_id?: string;
    category?: string;
    superseded?: boolean;
    timestamp?: string | number;
    [key: string]: any;
  };
}

async function scrollQdrant(): Promise<QdrantPoint[]> {
  const all: QdrantPoint[] = [];
  let offset: string | null = null;
  const limit = 100;

  while (true) {
    const body: any = { limit, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;

    const resp = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.error(`Qdrant scroll failed: ${resp.status} ${await resp.text()}`);
      break;
    }

    const data = await resp.json() as any;
    const points = data.result?.points || [];
    all.push(...points);

    if (!data.result?.next_page_offset) break;
    offset = data.result.next_page_offset;
    console.log(`  Scrolled ${all.length} points...`);
  }

  return all;
}

async function main() {
  console.log("Scrolling all points from Qdrant...");
  const points = await scrollQdrant();
  console.log(`Got ${points.length} points from Qdrant`);

  if (points.length === 0) {
    console.log("Nothing to migrate");
    return;
  }

  // Map to Typesense docs
  const docs = points.map((p) => {
    const ts = p.payload.timestamp
      ? typeof p.payload.timestamp === "number"
        ? p.payload.timestamp
        : Math.floor(new Date(p.payload.timestamp).getTime() / 1000)
      : undefined;

    return {
      id: String(p.id),
      observation: p.payload.observation || p.payload.text || "",
      source: p.payload.source || "unknown",
      session_id: p.payload.session_id || undefined,
      category: p.payload.category || undefined,
      superseded: p.payload.superseded || false,
      timestamp: ts || undefined,
    };
  }).filter((d) => d.observation.length > 0);

  console.log(`Prepared ${docs.length} documents for Typesense`);

  // Bulk import via JSONL
  const BATCH = 50;
  let success = 0;
  let errors = 0;

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const jsonl = batch.map((d) => JSON.stringify(d)).join("\n");

    const resp = await fetch(
      `${TYPESENSE_URL}/collections/memory_observations/documents/import?action=upsert`,
      {
        method: "POST",
        headers: {
          "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
          "Content-Type": "text/plain",
        },
        body: jsonl,
      }
    );

    const text = await resp.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    success += lines.filter((l) => l.success).length;
    errors += lines.filter((l) => !l.success).length;

    if (lines.some((l) => !l.success)) {
      console.error("  Errors:", lines.filter((l) => !l.success).slice(0, 2));
    }

    const pct = Math.round(((i + batch.length) / docs.length) * 100);
    process.stdout.write(`\r  Migrated: ${success}/${docs.length} (${pct}%) errors: ${errors}`);
  }

  console.log(`\n\nDone! ${success} migrated, ${errors} errors`);
}

main().catch(console.error);
