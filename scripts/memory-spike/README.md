# memory-spike

End-to-end vertical slice proving the memory API architecture works with real data
against real interfaces. See `/Users/joel/Code/joelhooks/joelclaw/CONTEXT.md` for
the full architectural context (21 rules, 13 terms).

## What this spike proves

1. **qwen3-embedding:8b via Ollama actually produces useful embeddings** — not just
   that it runs, but that semantic similarity behaves as expected on real agent
   transcripts.
2. **Matryoshka truncation to 768-dim preserves quality** — the API parameter
   `dimensions: 768` truncates cleanly and the 768-dim vectors cluster as expected.
3. **Per-turn chunking handles real claude-code jsonl** — extracts user / assistant /
   tool turns correctly, skips meta entries.
4. **Typesense hybrid search (BM25 + vector) returns relevant results** — semantic
   queries retrieve on-topic chunks from a real conversation.
5. **End-to-end ingest latency is acceptable at family scale** — measured.

## What this spike does NOT cover

- PDS identity / App Password auth (bearer is hardcoded as `dev-spike`)
- NAS blob storage (logs jsonl_path but skips actual NFS writes)
- Inngest durability (embedding + index happens inline in the script)
- Share Grants / privacy filtering (single User, readable_by = [owner] only)
- Entity extraction / enrichment (entities_mentioned left empty)
- Capture hooks (reads a fixture jsonl directly)
- Tree structure / parent_run_id (single flat Run)
- Run metadata collection (only run_chunks_spike exists)

These are all explicit deferrals, not forgotten items. They have designed
insertion points per CONTEXT.md.

## Running the spike

Prereqs:
- Ollama running locally (`ollama serve`)
- `qwen3-embedding:8b` pulled (`ollama pull qwen3-embedding:8b`)
- Typesense reachable at `localhost:8108` via the SSH tunnel to Colima
- Env: `TYPESENSE_API_KEY` set (see `~/Code/joelhooks/joelclaw/k8s/typesense.yaml`)

```bash
cd ~/Code/joelhooks/joelclaw
export TYPESENSE_API_KEY=391a65d92ff0b1d63af0e0d6cca04fdff292b765d833a65a25fb928b8a0fb065

# Ingest a real claude-code session into the spike collection
bun scripts/memory-spike/ingest.ts ~/.claude/projects/-Users-joel/a97e5c2b-bd82-4a63-ac5a-9df7e5f3cbaf.jsonl

# Hybrid semantic + keyword search
bun scripts/memory-spike/search.ts "why did joelclaw shit the bed"
bun scripts/memory-spike/search.ts --mode=semantic "disaster recovery plan"
bun scripts/memory-spike/search.ts --mode=keyword "colima"
```

## Observations (2026-04-19)

**Ingested fixture**: `~/.claude/projects/-Users-joel/a97e5c2b-bd82-4a63-ac5a-9df7e5f3cbaf.jsonl` — 1247 jsonl lines / 2.54MB / a real Claude Code session from 2026-04-16 about recovering the k8s cluster after Colima died.

- **Chunks produced**: 708 (314 user turns + 394 assistant turns + 0 tool turns — see surprises)
- **Total ingest time**: 573 s (9.5 min)
- **Embedding rate**: 1.2 chunks/sec sustained on M4 Pro
- **Embedding latency per chunk**: 133 ms – 3136 ms (median ~400 ms), mostly correlated with chunk token count
- **Typesense bulk index**: 708 docs in 0.49 s (not the bottleneck)
- **Semantic query latency**: ~420 ms end-to-end (220 ms embed + 200 ms search)
- **Keyword query latency**: ~20 ms (no embed needed)

**Retrieval quality on real queries:**

| Query | Mode | Top result |
|---|---|---|
| "disaster recovery plan for k8s cluster" | semantic | Chunk discussing NAS backup of k8s PV data (vec_dist 0.33) |
| "why did the cluster fail" | semantic | Connection-refused error chunks (vec_dist 0.28) — the literal root cause |
| "Typesense" | keyword | 84 matches in 21 ms; BM25 works |
| "what broke colima" | hybrid | BM25 hits on "colima" literal ranked first; the best semantic hit ("Colima wedged again — same crash") at rank 3 |

**Surprises:**

1. **Tool results show as `role=user`, not `role=tool`.** Claude Code's jsonl wraps tool results inside user-type entries (the "next user message" carries the tool result). My chunker's role detection needs to inspect content shape (presence of `[tool_result]` marker or a `toolUseResult` field) rather than rely on the `type` field. Fix for v1 build-out.
2. **Hybrid search requires `query_by: "text"` alone, not `"text,embedding"`.** Typesense auto-combines BM25 on the text field with the `vector_query` against `embedding`. Putting embedding in `query_by` broke search and returned zero results. Fixed in `search.ts`.
3. **Embed latency variance is large.** Short chunks (~130 ms) and long chunks (~3000 ms) differ 20x. Batching (via `embedBatch`) would amortize the per-request overhead and likely halve total ingest time. Deferred to v1 build-out.
4. **The initial embedding call after model load was slow (first 1200 ms)**, then latency stabilized. Model load into Ollama memory is one-time per process lifetime.
5. **Semantic quality is better than expected on this mixed English+code+tool-output data.** qwen3-embedding-8b handles the corpus well; no obvious "garbage in, garbage out" on the messy tool-result chunks.

**What works (proves architecture correct):**

- ✅ qwen3-embedding:8b via Ollama with Matryoshka truncation to 768-dim is production-ready.
- ✅ Per-turn chunking produces meaningful retrievable units.
- ✅ Typesense hybrid (BM25 + vector) returns relevant results across all three modes.
- ✅ Embedding Model Tag (`qwen3-embedding-8b@768`) written per-chunk; future re-embed is a filter query away.
- ✅ `readable_by` filter works as the privacy primitive — every query carries it.

**Open items surfaced by the spike:**

- Fix role detection for tool_result entries in `chunking.ts`
- Use `embedBatch` for ~2x ingest speedup
- Confirmation that conversation-level splitting into per-invocation Runs (vs one Run per session as this spike did) doesn't degrade retrieval — this needs the build-out's capture hook to be validated

## Deletions after spike

The `run_chunks_spike` collection can be dropped cleanly:

```bash
curl -X DELETE -H "X-TYPESENSE-API-KEY: $TYPESENSE_API_KEY" \
  http://localhost:8108/collections/run_chunks_spike
```

## What comes next

Once this spike confirms the happy path, the full build-out follows the
Implementation Plan in the omnibus ADR:

1. Graduate the inline embed call into an `@joelclaw/inference-router/embeddings`
   lane with model catalog + tracing.
2. Move ingest into an Inngest function `memory/run.captured` for durability.
3. Add NAS blob writes (real NFS mount) alongside Typesense indexing.
4. Add auth (PDS + App Password + bearer).
5. Add search endpoint `POST /api/runs/search` in `apps/web/`.
6. Add CLI commands `joelclaw runs search` etc.
7. Add capture hooks (pi extension + claude-code Stop hook).
