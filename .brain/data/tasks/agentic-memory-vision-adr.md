# Task: Draft the Agentic Memory System Vision ADR (wayfinder ticket)

You are a pi worker in pane wJ:p3, steered by a Claude session in wJ:p1. Work autonomously. **Do not commit.** Print a `DONE` summary (5–10 lines) when finished.

## Read first

- `.brain/projects/wayfinder/write-agentic-memory-vision-adr.svx` — your ticket. It is the contract; its four bullet points are the ADR's required sections.
- `.brain/projects/wayfinder/joelclaw-brain-graph-map.svx` — the map. The Destination and "substrate insight" sections are the grilling record you draft from; quote the substrate insight faithfully.
- `.brain/projects/wayfinder/joelclaw-personal-wiki-map.svx` — the adjoining wiki map (product boundary + fixed technical direction you must not contradict).
- `~/.brain/resources/fleet-sync-doctrine.svx` — how dark-wizard actually syncs (the user-brain-as-repo claim must match it).
- https://mastra.ai/docs/memory/overview — the memory vocabulary (message history / working memory / semantic recall / observational memory).

## The job

Draft the vision ADR: the distributed, multi-agent, multi-machine, agentic-first second brain. Required content, per the ticket:

1. The substrate insight: network of Git repositories; dark-wizard as THE user brain (union of Joel's user across machines, not per-machine, not network-level); project brains per repo; machine checkouts as divergeable replicas; divergence is data; repo@machine as a future query dimension.
2. The Mastra mapping: which joelclaw pieces play message history (session transcripts), working memory, semantic recall (Typesense), observational memory (bugle observations → durable Brain pages). Be explicit about what exists today vs aspiration.
3. The read/write split: graph surface first (this map's proof); active observation processing is a follow-on charted map, not scope creep here.
4. Dual purpose: working memory system AND demo content ("fuck Obsidian" video); demoability is a design constraint. The video itself is out of scope everywhere.

## Deliverable

Write `.brain/resources/decisions/agentic-memory-system-vision.svx` — svx, small frontmatter (`title`, `type: "decision"`, `status: "draft"`, `created_at: "2026-07-12"`), ADR shape (Context / Decision / Consequences is fine). Joel's register: plain words, concrete nouns, one idea per sentence, no sludge. Mark anything you cannot source from the listed reads as `TODO(joel)` rather than inventing it.

Do NOT edit the ticket or the map — the steering session records resolution. Status stays `draft` — Joel reviews (the ticket is AFK-draft + HITL-review). Do not commit anything.
