# joelclaw

Personal AI infrastructure operated as a **central service for a distributed network of user machines** belonging to Joel and his family. Complexity lives at the center; edge devices stay thin.

## Language

**Network**:
The constellation of Users and their Machines coordinated by the Central service. Not a physical network — a coordination boundary.
_Avoid_: cluster, fleet, mesh (those mean other specific things in joelclaw)

**User**:
A person in the joelclaw Network (Joel, his wife, his kids). Each User has one identity across all their Machines.
_Avoid_: account, operator, member, principal

**Machine**:
An endpoint device belonging to exactly one User (laptop, phone, Pi, microVM, sandbox). Identified by a stable `machine_id`.
_Avoid_: node, client, device (in API/DB contexts — "Machine" is canonical)

**Central**:
The Panda-hosted joelclaw service: joelclaw.com (Next.js on Vercel) + the k8s cluster on Colima (system-bus worker, Inngest, Typesense, Redis, Restate, NAS-backed storage). One Central per Network.
_Avoid_: server, backend, hub

**Run**:
One agent invocation — the atomic unit of capture. A single `pi -p` call, one claude-code turn, one codex call, one loop iteration, one gateway reply generation. Has a jsonl transcript and structured metadata. May have a `parent_run_id` pointing to a larger Run (workload stage, nested agent call). Runs form trees.
_Avoid_: session, trace, conversation (all three are already booked — "Run" is canonical)

**Conversation**:
A label linking sibling Runs that share interactive context (a claude-code session across 40 turns, a pi chat). Not a first-class entity — just a `conversation_id` field on Runs. Roll-ups happen at query time.
_Avoid_: session, thread

**Tag**:
A free-form string label on a Run (e.g. `household:travel`, `work:joelclaw`, `kiddo:homework`). Primary unit of sharing — Share Grants scope to tags. Tags are set at capture time by the Machine or added later.

**Share Grant**:
A record that grants read access on a set of Runs from one User to another. Scope is either `tag:<tag>` (all Runs, present and future, with that tag) or `run:<id>` (one Run and all its descendants in the tree). Tag grants are primary; Run grants are the special case.
_Avoid_: permission, ACL, sharing (verb)

**DID**:
The AT Protocol identifier for a **User** in the joelclaw PDS (`did:plc:...`). Sovereign, portable, one-to-one with User. Users never see their DID — the CLI handles it.

**App Password**:
An AT Protocol credential bound to a (DID, Machine) pair, issued by Central and stored in `~/.joelclaw/auth.json` on the Machine. Revocable individually. Machines present it (as a bearer token in v1) to authenticate Run POSTs.
_Avoid_: API key, token, auth secret

**Capture Hook**:
The runtime-native mechanism that emits a Run. pi extension for pi, `Stop` hook in `~/.claude/settings.json` for claude-code, equivalent for codex. Every hook invokes `joelclaw capture-stdin` which enriches the jsonl with identity + lineage and POSTs to `/api/runs`. Server-side runtimes (loops, workload-rig, gateway) skip the hook and call `captureRun()` inline.
_Avoid_: capture agent, capture daemon (we have neither)

**Outbox**:
The per-Machine directory `~/.joelclaw/outbox/` holding Runs whose POST failed (offline, Central down, rate limit). Drained by any `joelclaw` CLI invocation plus a launchd/systemd timer every 5min. File-based, survives reboots, inspectable with `ls`.
_Avoid_: queue, buffer, spool (those imply a running process)

**Chunk**:
An indexed fragment of a **Run**, scoped to one turn (user message + assistant response + any tool calls between them). 40K-token context of the embedding model means most turns are one Chunk; oversized turns split at paragraph boundaries with 100-token overlap. Each Chunk carries a 768-dim vector plus denormalized identity/access fields for single-query Typesense search.

**Embedding Model Tag**:
The string stored on each Chunk identifying which model + dimension produced its vector (e.g. `qwen3-embedding-8b@768`). Used to identify rows that need re-embedding when the model is upgraded. Never omitted.

**Run Status**:
One of `active` (default, searchable) or `deleted` (hard-removed from NAS + Typesense, tombstoned only via optional PDS audit record). `archived` is reserved as a future tri-state addition (NAS-retained, Typesense-dropped) and not implemented in v1.

## Relationships

- A **Network** has one **Central** and many **Users**
- A **User** owns many **Machines**
- A **Machine** produces many **Runs**
- A **Run** is owned by exactly one **User** (via the Machine that produced it)
- A **Run** may have a parent **Run** (nested agent calls, workload-rig sub-runs); Runs form trees
- A **Run** may have a **Conversation** ID grouping it with siblings (turns of the same session)
- A **Run** has zero or more **Tags**
- A **Share Grant** scopes to a **Tag** (primary) or a **Run** subtree (special case)

## Architectural rules derived from this language

1. **Ingestion is Central.** Machines ship raw jsonl + metadata to `/api/memory/*`. Chunking, embedding, indexing all happen on the Central worker. Machines never run embedding models, never write to Typesense, never touch NAS directly. This is the "KISS the Machines" rule.
2. **Embedding is an interface, not an implementation.** The Central worker calls embeddings through `@joelclaw/inference-router`. Local Ollama today, Mac Studio Ollama tomorrow — caller code unchanged.
3. **Every Run carries User + Machine identity at capture time.** Ownership is not inferred downstream.
4. **Runs are private by default; sharing is explicit.** Queries filter to `owner_user_id` or a `readable_by` grant. No Network-wide pool. (Per-Run vs per-tag sharing granularity still open.)
5. **Design for horizontal migration, not RAM optimization.** Panda (64GB) runs everything today. Mac Studio (128GB) is the upgrade target for RAM-bound services like Typesense. Current capacity ceiling is ~270K Runs in RAM — several years of headroom at realistic family rates — but services must be designed so Typesense (or any other service) can move to a different Mac-class node over Tailscale without a refactor. In practice: stable typed HTTP interfaces between services, persistent state on NAS or PVC (never host disk), no service assumes colocation with another.
6. **Identity is PDS; the wire is a bearer token.** Every User has a DID in the joelclaw PDS. Every Machine has an AT Protocol App Password scoped to its User's DID. Machines present the App Password (as a bearer token in v1) to authenticate Run POSTs. Central verifies against PDS, extracts `(user_id, machine_id)`, never trusts identity from the request body. Users are provisioned manually via `joelclaw user create <name>`; self-serve invite flow is a later upgrade. Upgrade path to full AT Proto signed requests is reserved for federation scenarios (e.g. external DIDs participating in the Network).
7. **Ingress is Tailnet-only.** `/api/runs/*` and `/api/memory/*` are not reachable from the public internet. Defense in depth beneath the bearer-token layer.
8. **Capture uses native runtime hooks; wrappers are the fallback.** Pi extension, claude-code `Stop` hook, codex hook — each invokes `joelclaw capture-stdin` which enriches and POSTs. Explicit `joelclaw capture -- <cmd>` only for tools with no hook surface. Machines get one CLI installed, nothing else. Parent linkage propagates via `JOELCLAW_PARENT_RUN_ID` + `JOELCLAW_CONVERSATION_ID` env vars — best-effort; orphan Runs are acceptable. Failed POSTs go to the Outbox.
9. **Embeddings: qwen3-embedding:8b via Ollama, Matryoshka-truncated to 768-dim.** Chunking is per-turn (40K context window makes sub-turn splits rare). Every Chunk carries its Embedding Model Tag (`qwen3-embedding-8b@768`). Dimension is a query-time/deployment knob, not a data commitment — full 4096-dim can be re-computed at zero cost since the same model produces it. Ingest path calls the model through `@joelclaw/inference-router`; swap via config.

9a. **Embed concurrency is an Inngest-managed knob with priority lanes.** Ollama serializes embed calls internally, so raw concurrency at the HTTP layer is a fake optimization — what matters is *who waits*. Every embed call routes through Inngest with one of three priorities: `query` (agent/CLI search, interactive, never starved), `ingest-realtime` (live Run captures, normal priority), `ingest-bulk` (reindex, backfill, spike ingest — lowest priority, drops out when anything else arrives). Concrete contention observed during the spike: a query embed queued behind bulk work went from ~220ms idle to 8-10 s under load. Priority lanes are the fix. Implementation: `memory/embed.requested` event carries a `priority` field; `@joelclaw/inference-router` embeddings lane sets it based on caller; Inngest `priority.run` expression gates scheduling. Background ingest must never steal query latency.
10. **NAS is authoritative; Typesense is rebuildable.** Each Run writes `<run-id>.jsonl` + `<run-id>.metadata.json` to NAS as the source of truth. Typesense is a derived index. Schema changes, embedding-model upgrades, chunk-strategy shifts, and service migrations are all "re-walk NAS and rebuild the collection" — a safe bulk operation, not a database migration. Typesense corruption or loss is recoverable.
11. **NAS path convention is user-partitioned.** Run blobs live at `/nas/memory/runs/<user_id>/<yyyy-mm>/<run-id>.{jsonl,metadata.json}`. User-first partitioning makes per-User export, deletion, and privacy audits trivial filesystem operations.
12. **Agent-first, humans are a vestigial afterthought.** Every API, response shape, error, and pagination choice is optimized for agents consuming them. Stable typed JSON envelopes, machine-readable error codes, idempotency keys on mutating POSTs, cursor-based pagination, rich `_links` and `next_actions`, deterministic result ordering. No dashboard, no web UI, no visual manual-operations surface in v1 — humans use the CLI, which is itself an agent-shaped thin wrapper over the same endpoints.
13. **Search API shape: D — one hybrid search + convenience traversal endpoints.** Primary call is `POST /api/runs/search` with hybrid-by-default mode, AND-semantics tag filters, and auto-applied `user_id` + `readable_by` filters from the bearer token (never from the request body — no way to spoof privacy from client). Traversal endpoints (`GET /api/runs/:id`, `:id/jsonl`, `:id/descendants`) are separate. Mutation endpoints (`POST /api/runs/:id/tags`) are owner-gated.
14. **Retention is keep-forever.** No TTLs, no rolling windows, no auto-expiration. Storage is not the constraint; the value of agent memory compounds across years. Explicit deletion is the privacy lever.
15. **Deletion is owner-only, hard, cascade-by-default, durable via Inngest.** `DELETE /api/runs/:id` fires `memory/run.delete.requested`. The function removes Typesense chunks → removes the Run row → removes NAS jsonl + metadata. Idempotent at every step; safe to retry. Descendant Runs in the same tree cascade-delete (`root_run_id` match). Bulk delete is always filter-scoped and owner-scoped; no wildcard. DR is covered by nightly NAS snapshots. Optional `dev.joelclaw.run.deleted` PDS record available per-User but off by default in v1.
16. **Re-indexing is three distinct paths, each an Inngest function.** (1) Embedding/chunking rebuild: admin-triggered, fans out from NAS (not Typesense), writes to a new collection `run_chunks_v2`, atomic alias swap on completion, throttled to qwen3 ingestion throughput, resumable. (2) Metadata enrichment: updates Run rows only, no chunk work. (3) Share-Grant fanout: updates `readable_by` on affected chunks only. NAS is always the source of truth for the "what to reindex" list. New-collection-swap is preferred over in-place mutation for Path 1 — rollback is an alias swap, failed reindex never corrupts live data, cost is 2× Typesense disk during the window.
17. **Parsed metadata is inline-deterministic; entity extraction is async-LLM.** The `memory/run.captured` Inngest function populates deterministic fields inline from the jsonl (`turn_count`, `user_turn_count`, `assistant_turn_count`, `tool_turn_count`, `token_total`, `tool_call_count`, `files_touched` via structured-tool-call parsing, `skills_invoked` via string match against the `skills/` dir, `intent` as first 500 chars of first user message, `status` as terminal state). A separate `memory/run.enrich.requested` Inngest function fires fire-and-forget afterward: one local `pi -p` call per Run with a strict JSON schema extracting five entity kinds — `people`, `projects`, `tools`, `concepts`, `resources`. Stored as a flat prefix-kinded `string[]` (e.g. `people:Melissa`, `tools:typesense`) on the Run row. Runs become searchable immediately; `entities_mentioned` populates within minutes. Entity *linking* (resolving surface strings to canonical Contacts/Projects) is a Path 2 enhancement, not v1.
18. **Share Grants are their own Typesense collection.** `POST /api/share-grants { grantee_user_id, scope: "tag:<tag>"|"run:<id>", expires_at? }` creates a row and fires `memory/share-grant.created` → Path 3 reindex. Revoke fires `memory/share-grant.revoked`. A nightly Inngest cron expires time-bounded grants. `GET /api/share-grants` returns grants given + received for the caller.
19. **Admin = a DID in the `ADMIN_DIDS` env var on Central.** No separate admin token or auth scheme. Admin endpoints (`/api/admin/*`) check the caller's resolved DID against `ADMIN_DIDS`; non-members get 403. V1 list is Joel's DID. KISS extends all the way through authorization.
20. **PDS integration is `createAppPassword` + bearer token, with a 60s session cache.** User creation calls the existing PDS admin API to mint a `did:plc:...` + handle. Machine registration calls `com.atproto.server.createAppPassword` on behalf of the User's DID; the app password is returned to the CLI once and written to `~/.joelclaw/auth.json` (0600). On every POST, Central validates the bearer token via `com.atproto.server.createSession` (cached 60s), extracts the DID, maps to `user_id`. Revocation calls `com.atproto.server.revokeAppPassword`. AT Proto signed-request envelopes, `dev.joelclaw.run.captured` audit records, and federation with external DIDs are reserved upgrades — not v1.
21. **`packages/memory` is the new home.** Types (`Run`, `Chunk`, `ShareGrant`, `User`, `Machine`, `RunStatus`), Typesense collection schemas, NAS path helpers, the per-turn chunker, and interface definitions (`RunStore`, `ChunkStore`, `ShareGrantStore`) all live there, mirroring the `@joelclaw/telemetry` pattern. Heavy logic (chunking, embedding call, indexing) lives in `packages/memory` and is consumed by `packages/system-bus/src/inngest/functions/memory/*`. Route handlers in `apps/web/app/api/runs/*` and `apps/web/app/api/share-grants/*` are thin composition roots — they authenticate, enforce Rule 4, delegate to memory functions, and return HATEOAS envelopes. Embeddings lane is a new file `packages/inference-router/src/embeddings.ts`.

## Example dialogue

> **Joel:** "When kiddo's laptop runs claude-code, where does the memory go?"
> **Agent:** "The laptop ships jsonl to **Central** as a **Run** tagged with kiddo's **User** ID and the laptop's `machine_id`. **Central** chunks, embeds, indexes. Kiddo's **Runs** are isolated from Joel's by default."
> **Joel:** "Can my agents search kiddo's **Runs**?"
> **Agent:** "Only if kiddo's **User** record grants access — isolation by default, explicit sharing contract required." _(pending Q2)_

## API surfaces

- **`/api/runs/*`** — capture + search of raw **Runs**. The first thing we're building.
- **`/api/memory/*`** — reserved for **derived retrieval** endpoints (e.g. `POST /api/memory/retrieve` to get "what Joel knows about X, composed across Runs, ready for prompt injection"). Not built yet.

Runs = raw. Memory = derived from Runs. Keep them namespaced apart.

## Flagged ambiguities

- **"Session"** is overloaded — pi, claude-code, and the gateway each use it differently. Resolved: use **Run** for captured agent traces. "Session" reserved for its existing meanings.
- **"Operator"** — resolved: drop "operator", use **User** (the owning person) + `agent_runtime` field (pi, claude-code, codex, etc.).
