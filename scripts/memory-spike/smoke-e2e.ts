#!/usr/bin/env bun
/**
 * E2E smoke for the Phase 1 slice:
 *   POST /api/runs with a real jsonl fixture →
 *   wait for memory/run.captured Inngest function to index →
 *   POST /api/runs/search and verify the Run is findable.
 *
 * Requires:
 *   - Next.js dev server running on :3000 (pnpm --filter web dev)
 *   - system-bus-worker deployed with memory/run.captured registered
 *   - Typesense + Ollama + Inngest all healthy
 *
 * Env:
 *   WEB_URL=http://localhost:3000 (override for tailnet testing)
 *   TYPESENSE_API_KEY=<from k8s/typesense.yaml>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const BEARER = "dev-joel-panda";
const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY not set; aborting.");
  process.exit(1);
}

const FIXTURE_PATH =
  process.argv[2] ??
  `${homedir()}/.claude/projects/-Users-joel/ebadb712-b23d-4e55-8792-ab58b39b23eb.jsonl`;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${WEB_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function poll<T>(
  label: string,
  check: () => Promise<T | null>,
  { intervalMs = 2_000, timeoutMs = 120_000 } = {}
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function main() {
  console.log("== step 1: POST /api/runs ==");
  console.log(`  fixture: ${FIXTURE_PATH}`);
  const jsonl = readFileSync(FIXTURE_PATH, "utf8");

  const ingestRes = await post("/api/runs", {
    agent_runtime: "claude-code",
    tags: ["smoke-e2e"],
    started_at: Date.now(),
    jsonl,
  });
  if (!ingestRes.ok) {
    console.error(`  FAIL ingest: ${ingestRes.status}`);
    console.error(await ingestRes.text());
    process.exit(1);
  }
  const ingestBody = (await ingestRes.json()) as {
    run_id: string;
    jsonl_path: string;
    jsonl_bytes: number;
  };
  console.log(`  OK run_id=${ingestBody.run_id}`);
  console.log(`     jsonl_path=${ingestBody.jsonl_path}`);
  console.log(`     jsonl_bytes=${ingestBody.jsonl_bytes}`);

  console.log(`\n== step 2: wait for Typesense index ==`);
  const indexed = await poll(
    "chunks indexed",
    async () => {
      const res = await fetch(
        `${TYPESENSE_URL}/collections/run_chunks_dev/documents/search?q=*&query_by=text&filter_by=run_id:=\`${ingestBody.run_id}\`&per_page=0`,
        {
          headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY! },
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { found?: number };
      return (data.found ?? 0) > 0 ? data.found! : null;
    }
  );
  console.log(`  OK indexed ${indexed} chunks`);

  console.log(`\n== step 3: POST /api/runs/search ==`);
  const searchRes = await post("/api/runs/search", {
    query: "first user message test",
    mode: "hybrid",
    filters: { tags: ["smoke-e2e"] },
    limit: 5,
  });
  if (!searchRes.ok) {
    console.error(`  FAIL search: ${searchRes.status}`);
    console.error(await searchRes.text());
    process.exit(1);
  }
  const searchBody = (await searchRes.json()) as {
    count: number;
    total_matched: number;
    hits: Array<{ run_id: string; role: string; text: string; score: unknown }>;
    timing: Record<string, number>;
  };
  console.log(`  OK ${searchBody.count}/${searchBody.total_matched} hits`);
  console.log(`     timing: ${JSON.stringify(searchBody.timing)}`);
  searchBody.hits.slice(0, 3).forEach((h, i) => {
    console.log(
      `     [${i + 1}] ${h.role} run=${h.run_id}: ${h.text.slice(0, 80).replace(/\s+/g, " ")}…`
    );
  });

  const ourHit = searchBody.hits.find((h) => h.run_id === ingestBody.run_id);
  if (ourHit) {
    console.log(`\n  ✓ smoke-e2e PASS — ingested Run is findable via search`);
    process.exit(0);
  } else {
    console.log(
      `\n  ✗ smoke-e2e WARN — search returned ${searchBody.hits.length} hits but not our run_id (${ingestBody.run_id}); may be a ranking issue or wrong query`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
