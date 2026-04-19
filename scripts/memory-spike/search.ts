#!/usr/bin/env bun
import {
  embed,
  RUN_CHUNKS_COLLECTION,
} from "../../packages/memory/src/index";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY not set; aborting.");
  process.exit(1);
}

const SPIKE_USER_ID = "joel";

type Mode = "hybrid" | "semantic" | "keyword";

function parseArgs(argv: string[]): { mode: Mode; query: string; limit: number } {
  let mode: Mode = "hybrid";
  let limit = 10;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length) as Mode;
    } else if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10) || 10;
    } else {
      positional.push(arg);
    }
  }
  return { mode, query: positional.join(" "), limit };
}

async function main() {
  const { mode, query, limit } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.error(
      'usage: bun scripts/memory-spike/search.ts [--mode=hybrid|semantic|keyword] [--limit=N] "query text"'
    );
    process.exit(1);
  }

  console.log(`mode=${mode} limit=${limit} query=${JSON.stringify(query)}`);
  console.log("");

  const tStart = performance.now();

  let searchBody: Record<string, unknown>;

  if (mode === "keyword") {
    searchBody = {
      searches: [
        {
          collection: RUN_CHUNKS_COLLECTION,
          q: query,
          query_by: "text",
          filter_by: `readable_by:=\`${SPIKE_USER_ID}\``,
          per_page: limit,
          include_fields: "id,run_id,chunk_idx,role,text,agent_runtime,tags,started_at",
        },
      ],
    };
  } else {
    const tEmbed = performance.now();
    const embedding = await embed(query, { dimensions: 768 });
    const tAfterEmbed = performance.now();
    console.log(
      `  embedded query in ${(tAfterEmbed - tEmbed).toFixed(0)}ms`
    );

    const vectorQuery = `embedding:([${embedding.embedding.join(
      ","
    )}], k:${limit * 2})`;

    if (mode === "semantic") {
      searchBody = {
        searches: [
          {
            collection: RUN_CHUNKS_COLLECTION,
            q: "*",
            vector_query: vectorQuery,
            filter_by: `readable_by:=\`${SPIKE_USER_ID}\``,
            per_page: limit,
            include_fields: "id,run_id,chunk_idx,role,text,agent_runtime,tags,started_at",
          },
        ],
      };
    } else {
      // hybrid: Typesense auto-combines BM25 on text with vector_query on embedding
      searchBody = {
        searches: [
          {
            collection: RUN_CHUNKS_COLLECTION,
            q: query,
            query_by: "text",
            vector_query: vectorQuery,
            filter_by: `readable_by:=\`${SPIKE_USER_ID}\``,
            per_page: limit,
            include_fields: "id,run_id,chunk_idx,role,text,agent_runtime,tags,started_at",
          },
        ],
      };
    }
  }

  const searchRes = await fetch(
    `${TYPESENSE_URL}/multi_search`,
    {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody),
    }
  );

  if (!searchRes.ok) {
    const body = await searchRes.text();
    throw new Error(`typesense search failed: ${searchRes.status} ${body}`);
  }

  const data = (await searchRes.json()) as {
    results: Array<{
      found: number;
      hits: Array<{
        document: {
          run_id: string;
          chunk_idx: number;
          role: string;
          text: string;
          agent_runtime: string;
          tags?: string[];
          started_at: number;
        };
        vector_distance?: number;
        text_match?: number;
      }>;
    }>;
  };

  const tEnd = performance.now();
  const result = data.results[0];
  console.log(`  ${result?.found ?? 0} matches in ${(tEnd - tStart).toFixed(0)}ms`);
  console.log("");

  if (!result?.hits?.length) {
    console.log("(no hits)");
    return;
  }

  result.hits.forEach((hit, i) => {
    const { document: d, vector_distance, text_match } = hit;
    const score = vector_distance !== undefined
      ? `vector_dist=${vector_distance.toFixed(4)}`
      : text_match !== undefined
        ? `text_match=${text_match}`
        : "";
    const when = new Date(d.started_at).toISOString();
    const snippet = d.text.slice(0, 220).replace(/\s+/g, " ");
    console.log(`${i + 1}. [${d.role}] ${when} ${score}`);
    console.log(`   run=${d.run_id}:${d.chunk_idx}`);
    console.log(`   ${snippet}${d.text.length > 220 ? "…" : ""}`);
    console.log("");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
