# Task: Graph-store research for the Brain Graph (wayfinder ticket)

You are a pi worker in pane wJ:p2, steered by a Claude session in wJ:p1. Work autonomously. **Do not commit.** Print a `DONE` summary (5–10 lines) when finished.

## Read first

- `.brain/projects/wayfinder/research-graph-store-weird-ideas.svx` — your ticket. It is the contract.
- `.brain/projects/wayfinder/joelclaw-brain-graph-map.svx` — the map: destination, substrate insight, standing preferences.
- `.brain/projects/wayfinder/build-wikilink-edges-graph-json.svx` — the existing single-root graph.json (704 nodes, 145 edges) your candidates must ingest.

## The job

Research graph stores for the Brain Graph and write the comparison the ticket demands. Candidates to cover honestly (no strawmanning the weird ones — Joel loves neo4j/Cypher AND the Datalog family and wants to be entertained):

1. neo4j community edition (Cypher ergonomics vs JVM/ops weight on a Mac Studio)
2. Datalog family: DataScript, Datahike, XTDB, Datalevin, or embedded Datalog over SQLite
3. Embedded engines: Kuzu, DuckDB property-graph/recursive CTEs, SQLite + recursive CTEs
4. No database: graph.json v2 + in-process query layer (honest baseline — the data is small)

Judge each on: (a) ops cost of running on flagg (Mac Studio, launchd/Docker available, k8s cluster exists); (b) query ergonomics for AGENTS — can a CLI/MCP tool expose it well; (c) ingestion fit — graph.json stays the deterministic build artifact, the store ingests it; (d) pairing with Typesense (Typesense keeps semantic/FTS; store owns traversal/backlinks/paths); (e) honest fun + which demos best on camera (the overbuilt-second-brain video angle).

Use web research; cite what you read (URLs). Prefer 2025–2026 state of the art; note versions.

## Deliverable

Write `.brain/resources/brain-graph-store-research.svx` — svx with small frontmatter (`title`, `type: "research"`, `created_at: "2026-07-12"`), plain Markdown body: comparison table + a paragraph per candidate + a clear recommendation section at the end ("recommendation the relationship-decision ticket can grill against"). Keep it in Joel's register: terse, concrete, no corporate sludge.

Do NOT edit the ticket file or the map — the steering session records resolution. Do not commit anything.
