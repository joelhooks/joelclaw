---
title: Adopt comprehensive agent memory system
status: shipped
accepted: 2026-02-17
date: 2026-02-15
updated: 2026-02-21
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-15)
informed: All agents operating on this machine
supersedes:
  - "[ADR-0014 — Agent memory workspace](0014-agent-memory-workspace.md)"
  - "[ADR-0020 — Observational memory pipeline](0020-observational-memory-pipeline.md)"
related:
  - "[ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)"
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0019 — Event naming past tense](0019-event-naming-past-tense.md)"
credits:
  - "Mastra AI ([@mastra-ai](https://github.com/mastra-ai/mastra)) — Observational Memory pattern, Observer/Reflector two-agent architecture, async buffering design, priority-based extraction, compression guidance, continuation hints. MIT licensed. Source: packages/memory/src/processors/observational-memory/"
  - "Alex Hillman ([@alexknowshtml](https://github.com/alexknowshtml)) — kuato (session recall, 'user messages are the signal'), andy-timeline (narrative memory, weekly chapter format), defib (health monitoring, auto/ask/deny taxonomy). Indy Hall co-founder, Stacking the Bricks."
  - "John Lindquist ([@johnlindquist](https://github.com/johnlindquist)) — lamarck (session → reflection → playbook → MEMORY.md pipeline, Lamarckian inheritance metaphor, bullet lifecycle, feedback decay, secret redaction). egghead.io co-founder, Script Kit creator."
  - "Simen Svale / Sanity ([@sanity-io](https://github.com/sanity-io)) — Nuum memory architecture: distillation over summarization, segment-aware extraction (coherent conversation segments vs flat observation lists), dual-distillate format (operational context + retained facts), recursive distillation with temporal gradient, Reflect tool for on-demand recall. Source: https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem"
---

# ADR-0021: Adopt Comprehensive Agent Memory System

> **2026-02-21 Update**: Qdrant has been fully deprecated and removed. Typesense (ADR-0082) is now the sole memory backend, providing hybrid search (vector + text via rank fusion). The Qdrant pod, PVC, k8s manifests, client dependency, and all code references have been deleted. Historical Qdrant details below are preserved for context but no longer reflect the running system.

## Context and Problem Statement

Agents on this system lose conversational nuance between sessions. Memory is the critical missing capability — without it, every session starts from zero, hard-won debugging insights evaporate, user preferences must be restated, and architecture decisions exist only in ADRs that agents may not read.

Two prior ADRs addressed this in pieces:

- **ADR-0014** (agent memory workspace): Established `~/.joelclaw/workspace/` with `MEMORY.md` + daily logs. Mostly implemented by the session-lifecycle pi extension (pi-tools v0.3.0). But still `proposed` status with 3 of 7 verification criteria unmet (compaction workflow, memory search, heartbeat maintenance).

- **ADR-0020** (observational memory pipeline): Designed the Observer/Reflector pattern adapted from Mastra's Observational Memory. Detailed but never accepted — a Codex review found transport conflicts with ADR-0018, missing idempotency, and priority ordering disagreements with Project 08.

**Project 08** (memory system) added a 5-layer architecture model researched from four open-source projects (kuato, andy-timeline, defib, lamarck). But the layers were aspirational — the project itself noted "stop pretending all five layers are equally near-term."

The result: memory knowledge is scattered across 2 ADRs, 1 project doc, an extension, and a working MEMORY.md file — with path disagreements, overlapping Inngest function names, and conflicting priority ordering.

This ADR consolidates everything into one canonical specification.

### What exists and works today

| Component | State | Location |
|-----------|-------|----------|
| Memory workspace | ✅ Working | `~/.joelclaw/workspace/MEMORY.md` + `memory/YYYY-MM-DD.md` |
| Identity files | ✅ Working | `joelclaw/.agents/` (SOUL, IDENTITY, USER, AGENTS), symlinked to all harnesses |
| System log | ✅ Working | `~/Vault/system/system-log.jsonl` (slog CLI) |
| Session briefing | ✅ Working | pi-tools session-lifecycle extension injects MEMORY.md + system state on first turn |
| Pre-compaction flush | ✅ Working (metadata only) | Extension writes file ops to daily log before compaction |
| Shutdown handoff | ✅ Working | Extension auto-names session, writes handoff to daily log |
| Redis | ✅ Running | Docker, port 6379, used for loop state |
| Qdrant | ✅ Running | Docker, port 6333, no memory collections yet |
| Inngest | ✅ Running | Docker, port 8288, 10+ functions registered |
| Observation extraction | ❌ Missing | No structured extraction from session content |
| Automated reflection | ❌ Missing | MEMORY.md is manually curated |
| Memory search | ❌ Missing | No keyword or semantic search over memory |
| Review workflow | ❌ Missing | No mechanism to prompt Joel to review proposed memory updates |

### Session data (first 24 hours, 2026-02-14 to 2026-02-15)

- 23 sessions, 18M total session data
- 4 sessions hit compaction (17%) — these lose the most nuance
- 39% started with manual handoff files (now automated by session-lifecycle)
- 0 sessions used `/resume` or `/tree` branching
- Average session: 5-24 user messages

### Nuum refinement (2026-02-15, post-initial design)

After Phase 1 implementation began (MEM-1 through MEM-4 complete), analysis of Sanity's Nuum memory architecture ([blog post](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem)) revealed a strictly better extraction strategy than the flat observation list in the original Observer design.

**Key Nuum insight: distillation, not summarization.** "Compressing unrelated messages together produces mush. Compressing related messages produces useful abstraction." And: "A summary of a debugging session tells you the story. A distillation tells you the file path, the fix, and the gotcha to avoid next time."

**What Nuum does differently:**

1. **Segment-aware extraction.** Instead of extracting a flat list of priority-tagged observations from the full message dump, Nuum identifies *coherent conversation segments* — groups of 10-50 messages clustered by topic (debugging a specific bug, implementing a feature, making a decision). Boundaries detected by topic shifts, natural breakpoints (bug fixed, feature committed), and temporal clustering.

2. **Dual distillates per segment.** Each segment produces two outputs:
   - *Operational context* (1-3 sentences): what happened — the narrative for orientation.
   - *Retained facts* (bullet list): specific file paths, values, decisions with rationale, gotchas, error messages and fixes — for continuing work.

3. **Recursive distillation.** Distillations can be distilled again, creating a temporal gradient: last few hours = full detail, yesterday = distilled segments, last week = meta-distillations, older = increasingly abstract. Only the most durable insights survive.

4. **Reflect tool.** An on-demand sub-agent with full-text search over all temporal messages + LTM knowledge base. The main agent asks a question ("what did we decide about Redis TTLs?"), the reflect agent searches and returns a synthesized answer. "Illusion of perfect recall without loading everything into context."

5. **Three-tier architecture** (maps to ours):
   - Tier 1: Temporal Memory (full messages, searchable) ≈ our Foundation
   - Tier 2: Distilled Memory (compressed segments with narrative + facts) ≈ our Processing
   - Tier 3: Long-Term Memory (durable knowledge, injected into system prompt) ≈ our Identity

**What we adopt:**

- **Segment-aware Observer prompt** (Phase 1 addendum, MEM-7): Refactor `OBSERVER_SYSTEM_PROMPT` to identify coherent conversation segments before extracting. Per segment: operational context + retained facts with priority markers. Output uses `<segment>` tags within `<observations>`. Backward-compatible: parser falls back to flat format.
- **Segment-aware parser** (Phase 1 addendum, MEM-8-10): `DistilledSegment` interface, `parseSegments()`, updated `optimizeForContext()` and `formatSegmentsForLog()`.
- **Recursive distillation** (Phase 2 enhancement): Reflector re-distills observations older than 3 days more aggressively. Temporal gradient emerges from repeated compression.
- **Reflect tool** (new Phase 5 capability): Pi skill or extension tool for on-demand Qdrant + Redis memory search mid-session.

**What we don't adopt:**

- **Continuous context window monitoring.** Nuum watches token count and proactively compresses at ~60% capacity. We trigger on compaction/shutdown events — simpler, durable via Inngest, and pi's compaction handles context window management separately.
- **In-process background workers.** Nuum runs distillation and LTM curation in-process. Our pipeline is Inngest functions — durable, observable, retryable.
- **Auto-writing LTM.** Nuum's LTM Curator directly creates/updates knowledge entries. We stage proposals in REVIEW.md for human review — trust-first approach until the pipeline proves reliable.

## Decision

Adopt a three-tier agent memory system — Foundation, Processing, and Identity — implemented as a pi extension + Inngest pipeline + Redis + Qdrant, with no external dependencies for core memory operations.

### Three-Tier Architecture

The previous 5-layer model (Project 08) was aspirational research. In practice, three tiers match what's being built:

```
┌──────────────────────────────────────────────────────────────┐
│  IDENTITY (permanent, hand-curated, version-controlled)       │
│                                                               │
│  SOUL.md — voice, values, boundaries                         │
│  IDENTITY.md — name, nature                                  │
│  USER.md — about Joel                                        │
│  AGENTS.md — operating instructions                          │
│                                                               │
│  Location: joelclaw/.agents/ (symlinked to all harnesses)    │
├──────────────────────────────────────────────────────────────┤
│  PROCESSING (automated extraction → human-reviewed curation)  │
│                                                               │
│  Observer — extracts structured observations from sessions    │
│  Reflector — condenses observations, proposes MEMORY.md edits │
│  Review — stages proposals, nudges Joel, promotes on approval │
│                                                               │
│  Execution: Inngest functions + Redis + Qdrant               │
├──────────────────────────────────────────────────────────────┤
│  FOUNDATION (files + events + infrastructure)                 │
│                                                               │
│  MEMORY.md — curated long-term memory (the product)          │
│  memory/YYYY-MM-DD.md — daily append-only logs               │
│  REVIEW.md — pending observation proposals                    │
│  system-log.jsonl — structured system events (slog)          │
│  Redis — hot observation storage, dedupe locks               │
│  Qdrant — vector embeddings for semantic search              │
│                                                               │
│  Location: ~/.joelclaw/workspace/ (not version-controlled)   │
└──────────────────────────────────────────────────────────────┘
```

### Canonical Paths

| File | Path | Version Controlled |
|------|------|--------------------|
| Curated memory | `~/.joelclaw/workspace/MEMORY.md` | No |
| Daily logs | `~/.joelclaw/workspace/memory/YYYY-MM-DD.md` | No |
| Review staging | `~/.joelclaw/workspace/REVIEW.md` | No |
| Identity files | `~/Code/joelhooks/joelclaw/.agents/` | Yes |
| System log | `~/Vault/system/system-log.jsonl` | No (Vault-synced) |
| Active symlinks | `~/.agents/`, `~/.pi/agent/`, `~/.claude/` | Symlinks |

### Pipeline Overview

```
Pi Session
│
├─ session_before_compact (messages about to be summarized):
│   serialize via serializeConversation()
│   igs send "memory/session.compaction.pending"
│
├─ session_shutdown (if ≥5 user messages):
│   serialize session entries
│   igs send "memory/session.ended"
│
│         ┌──────────────────────────────────┐
│         │  Inngest Worker                   │
│         │                                   │
└────────→│  memory/observe:                  │
          │    ① Dedupe (Redis SETNX)         │
          │    ② Observer LLM (haiku-4.5)    │
          │    ③ Parse XML output             │
          │    ④ Store → Redis (hot)          │
          │    ⑤ Store → Qdrant (embeddings)  │
          │    ⑥ Append → daily log           │
          │    ⑦ Token check → threshold?     │
          │         │                          │
          │         ├─ yes → memory/reflect    │
          │         │    ① Load observations   │
          │         │    ② Reflector LLM       │
          │         │    ③ Validate compression│
          │         │    ④ Stage → REVIEW.md   │
          │         │    ⑤ Append → daily log  │
          │         │                          │
          │         └─ no → done               │
          └──────────────────────────────────┘

Next Pi Session
│
├─ session_start:
│   session-lifecycle reads MEMORY.md
│   session-lifecycle reads REVIEW.md → "3 pending memory proposals"
│   session-lifecycle reads daily log
│   all injected as briefing
│
└─ Joel reviews proposals → approves/rejects → MEMORY.md updated
```

### Event Schema

Per ADR-0019, event names describe facts or pending states.

```typescript
// ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts

// --- Memory pipeline (ADR-0021) ---
"memory/session.compaction.pending": {
  data: {
    sessionId: string;
    dedupeKey: string;            // sha256(sessionId + firstMessageId + "compaction")
    trigger: "compaction";
    messages: string;             // serialized via serializeConversation()
    messageCount: number;
    tokensBefore: number;
    filesRead: string[];
    filesModified: string[];
    capturedAt: string;           // ISO 8601
    schemaVersion: 1;
  };
};
"memory/session.ended": {
  data: {
    sessionId: string;
    dedupeKey: string;            // sha256(sessionId + "shutdown")
    trigger: "shutdown";
    messages: string;             // serialized via serializeConversation()
    messageCount: number;
    userMessageCount: number;
    duration: number;             // session duration in seconds
    sessionName?: string;
    filesRead: string[];
    filesModified: string[];
    capturedAt: string;           // ISO 8601
    schemaVersion: 1;
  };
};
"memory/observations.accumulated": {
  data: {
    date: string;                 // YYYY-MM-DD
    totalTokens: number;
    observationCount: number;
    capturedAt: string;
  };
};
"memory/observations.reflected": {
  data: {
    date: string;
    inputTokens: number;
    outputTokens: number;
    compressionRatio: number;
    proposalCount: number;        // items staged in REVIEW.md
    capturedAt: string;
  };
};
```

### Idempotency

Dual triggers (compaction + shutdown) can fire for the same session — and that's intentional. A compaction observation captures messages about to be summarized; a shutdown observation may capture later messages. Both are valuable.

Deduplication guards against **retries**, not across trigger types:

1. **Dedupe key**: `sha256(sessionId + trigger + firstEntryTimestamp)` — unique per session × trigger × content window.
2. **Redis guard**: `SETNX memory:observe:lock:{dedupeKey}` with 1-hour TTL. If key exists, Observer function returns early (Inngest retry hit).
3. **Observation entries include dedupeKey** — duplicate detection in daily log is visible.
4. **Expected behavior**: A session that compacts AND shuts down produces TWO observations (different triggers, potentially different message windows). This is correct.

This replaces Mastra's in-process `activeOps` mutex (`observational-memory.ts` lines ~45-70) with Redis, appropriate for durable execution across worker restarts.

### Transport

The pi extension shells out to `igs send` (will become `joelclaw send` per ADR-0009). The CLI owns the Inngest URL, event key, and error handling. If transport changes later, only the CLI changes.

```typescript
// In session-lifecycle extension
import { spawn } from "child_process";

function emitEvent(name: string, data: Record<string, unknown>): void {
  const child = spawn("igs", ["send", name, "--data", JSON.stringify(data)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref(); // don't block parent process exit
}
```

Uses `spawn` with `detached: true` + `unref()` — safe for JSON payloads with quotes/newlines (no shell interpolation), and the spawned process survives parent exit (critical for `session_shutdown` which fires during process teardown).

**Shutdown reliability**: If `igs send` fails to launch (binary not found, system overloaded), the event is lost. Mitigation: the `session_shutdown` handler also writes the handoff to the daily log (existing behavior), which serves as a human-readable fallback. If telemetry shows events being dropped at shutdown, a future enhancement can add a `~/.joelclaw/workspace/memory/pending-events.jsonl` queue replayed on next `session_start`.

### Storage Architecture

#### Redis Keys

| Key Pattern | Type | TTL | Purpose | Phase |
|-------------|------|-----|---------|-------|
| `memory:observations:{YYYY-MM-DD}` | List (RPUSH) | 30 days | Hot observation storage, ordered by time | 1 |
| `memory:observe:lock:{dedupeKey}` | String (SETNX) | 1 hour | Observer idempotency guard (retry dedup) | 1 |
| `memory:reflect:triggered:{YYYY-MM-DD}` | String (SETNX) | 24 hours | Reflection once-per-day guard | 2 |
| `memory:review:pending` | List (RPUSH) | None | Pending MEMORY.md proposal IDs | 2 |
| `memory:review:proposal:{id}` | Hash | 30 days | Individual proposal content + metadata | 2 |

Each observation entry in Redis is JSON:
```json
{
  "dedupeKey": "abc123",
  "sessionId": "session-uuid",
  "trigger": "compaction",
  "priority": "high",
  "observations": "Date: 2026-02-15\n\n* 🔴 (09:15) Joel stated...",
  "currentTask": "Primary: Building memory system ADR",
  "suggestedResponse": "Continue with implementation plan",
  "timestamp": "2026-02-15T09:15:00Z",
  "tokenCount": 450,
  "schemaVersion": 1
}
```

#### Qdrant Collection

Collection: `memory_observations`

```json
{
  "vectors": {
    "size": 768,
    "distance": "Cosine"
  },
  "payload_schema": {
    "date": "keyword",
    "sessionId": "keyword",
    "dedupeKey": "keyword",
    "priority": "keyword",
    "trigger": "keyword",
    "text": "text",
    "currentTask": "text",
    "timestamp": "datetime",
    "tokenCount": "integer",
    "schemaVersion": "integer"
  }
}
```

**Embedding model**: `nomic-ai/nomic-embed-text-v1.5` (768 dimensions) via `sentence-transformers` on Apple Silicon. Local inference, no external API dependency. Invoked as subprocess: `uv run --with sentence-transformers --with einops python3 embed.py`. First run downloads ~550MB model to HuggingFace cache. Spike confirmed: embedding + Qdrant upsert + semantic search all work (similarity score 0.454 for related queries vs 0.004 for unrelated). Lock to 768 dims for Phase 1; migration path is collection recreation (observations are reproducible from daily logs).

Each observation is embedded as one Qdrant point. The `text` payload contains the full observation block. The `priority` field is the highest priority level in the observation block (`"high"`, `"medium"`, or `"low"`). Metadata filters enable scoped queries: `date >= "2026-02-10" AND priority = "high"`.

**Qdrant point ID**: Use a UUID v5 derived from the `dedupeKey` (deterministic, collision-free). Qdrant requires UUID or integer IDs — raw sha256 hex strings are rejected. `uuidv5(NAMESPACE_URL, dedupeKey)` produces a stable UUID from any string. Re-upserts are idempotent.

#### Daily Log Format

Observations append to `~/.joelclaw/workspace/memory/YYYY-MM-DD.md`:

**Flat format (Loop A):**
```markdown
### 🔭 Observations (session: {sessionName}, {HH:MM})

**Trigger**: compaction | shutdown
**Files**: {filesModified count} modified, {filesRead count} read

Date: 2026-02-15

* 🔴 (09:15) Joel stated slog is for infrastructure changes only, not code edits
* 🔴 (09:20) ADR-0014 superseded by ADR-0021 — comprehensive memory system spec
* 🟡 (09:25) Session-lifecycle extension v0.3.0 handles briefing, compaction flush, shutdown
* 🟢 (09:30) Considered Qdrant for observation search — decided to dual-write from Phase 1

**Current task**: Building comprehensive memory system ADR
```

**Segment-aware format (Loop B, via `formatSegmentsForLog`):**
```markdown
### 🔭 Observations (session: {sessionName}, {HH:MM})

**Trigger**: compaction | shutdown
**Files**: {filesModified count} modified, {filesRead count} read

#### Debugged Inngest worker registration
*Debugged the Inngest worker registration failure. Root cause: duplicate event trigger across two functions. Fixed by removing the stale trigger from video-download.ts.*

* 🔴 (09:15) Inngest rejects function registration when two functions share the same event trigger — silent failure
* 🔴 (09:20) The fix was removing `video.requested` trigger from video-download.ts
* 🟡 (09:25) Docker logs show registration errors that worker stderr does not

#### Accepted ADR-0019 past-tense naming
*Reviewed and accepted ADR-0019 for past-tense event naming. Renamed 19 files, 219 tests pass.*

* 🔴 (10:00) All Inngest events now use past-tense naming: `video.requested` not `video.request`

**Current task**: Building comprehensive memory system ADR
```

#### REVIEW.md Format

Reflector proposals staged in `~/.joelclaw/workspace/REVIEW.md`:

```markdown
# Pending Memory Proposals

_Reviewed by Reflector on 2026-02-15. Approve, edit, or reject each item._
_Mark [x] to approve, delete the line to reject, or edit the text before approving._

## Proposed for: Hard Rules
- [ ] `p-20250215-001` **Events follow past-tense naming** (ADR-0019) — `memory/session.compaction.pending`, not `memory/observe`
- [ ] `p-20250215-002` **Memory infrastructure uses local embedding only** — no external API dependency for core memory operations

## Proposed for: System Architecture
- [ ] `p-20250215-003` **Memory is three tiers**: Foundation (files + infra), Processing (observer + reflector), Identity (static)
- [ ] `p-20250215-004` **Observer dual-writes**: Redis (hot, 30-day TTL) + Qdrant (persistent vectors) + daily log (human-readable)

## Proposed for: Patterns
- [ ] `p-20250215-005` **Dedupe via Redis SETNX** with TTL for any idempotent pipeline step — proven in observation pipeline

_Last updated: 2026-02-15T18:00:00Z | 5 proposals pending_
```

Proposal IDs (`p-YYYYMMDD-NNN`) enable deterministic promotion and rejection tracking. Each ID maps to a `memory:review:proposal:{id}` Redis hash containing source observation references, original text, and status.

Session-lifecycle briefing includes: `"📋 5 pending memory proposals in REVIEW.md — review when ready"`

### Todoist-as-Review-Surface Refinement (2026-02-19)

**Problem**: REVIEW.md was designed as the primary surface for proposal review, but it was never written — proposals accumulated in Redis with no path to Joel's attention. Joel checks Todoist daily; he does not check `~/.joelclaw/workspace/REVIEW.md`. The review surface must meet Joel where he already is.

**Insight**: The task management system (ADR-0045) and webhook pipeline (ADR-0048) already provide a closed loop: Todoist tasks → webhooks → Inngest events. Proposals are reviewable work items — they belong in the task system, not a file.

**What changes:**

1. **Reflector creates Todoist tasks**, not REVIEW.md entries. After storing proposals in Redis, the `stage-review` step shells out to `todoist-cli add` with the `@memory-review` label. Task content is the proposal text; description includes the proposal ID, target section, and source observations.

2. **Label-based routing**, not string prefix parsing. The `@memory-review` Todoist label identifies proposal tasks cleanly — filterable, colorable, visible on all devices. Joel can view all pending proposals with `todoist-cli list --label memory-review` or the Todoist filter `@memory-review`.

3. **Completion → approval via webhook pipeline**. When Joel completes a `@memory-review` task, the Todoist webhook fires `todoist/task.completed`. A small bridge function matches the `memory-review` label, extracts the proposal ID from the task description, and emits `memory/proposal.approved`. The existing `promote.ts` handles the rest — writing to MEMORY.md, logging, cleanup.

4. **Deletion → rejection**. Tasks deleted by Joel fire `todoist/task.deleted` (needs webhook mapping). The bridge function emits `memory/proposal.rejected` with the proposal ID.

5. **REVIEW.md becomes optional audit trail**. Still written for observability, but no longer the primary review surface. Session-lifecycle briefing queries Todoist (`todoist-cli list --label memory-review`) instead of reading REVIEW.md.

6. **7-day auto-expiry preserved**. The existing daily cron in `promote.ts` still expires proposals older than 7 days. When it expires a Redis proposal, it also completes the corresponding Todoist task (or deletes it if Joel never saw it).

**Pipeline with Todoist:**

```
Reflector
  → Redis proposals (as before)
  → todoist-cli add "Promote: {text} → {section}" --labels memory-review,agent
      ↓
Joel sees task in Todoist (mobile/desktop)
  → completes task
      ↓
Todoist webhook → todoist/task.completed (with labels)
  → bridge function: labels.includes("memory-review")?
      → extract proposal ID from description
      → emit memory/proposal.approved
          ↓
promote.ts → MEMORY.md updated
```

**Requirements for this flow:**
- `todoist/task.completed` event must include `labels` array (currently missing — normalizer strips it)
- Bridge Inngest function matching `@memory-review` label → `memory/proposal.approved`
- `todoist/task.deleted` webhook mapping (not yet in EVENT_MAP)
- Reflector `stage-review` step updated to call `todoist-cli add`

**What we don't change:**
- Redis remains the proposal store (Todoist task is the notification surface, not the source of truth)
- Proposal IDs (`p-YYYYMMDD-NNN`) still deterministic and trackable
- `promote.ts` logic unchanged — it reacts to `memory/proposal.approved` regardless of source
- Phase 4 friction proposals follow the same pattern (just use `@memory-review` label)

### Observer Prompt

Adapted from Mastra's `CURRENT_OBSERVER_EXTRACTION_INSTRUCTIONS` (`observer-agent.ts` lines ~100-340) for system-engineering context. The original is optimized for consumer chatbot memory (personal facts, preferences, social context). This version weights toward infrastructure decisions, debugging insights, and system state changes.

> **Evolution note (2026-02-15):** The flat observation format below was implemented in Phase 1 Loop A (MEM-2/MEM-3). Phase 1 Loop B (MEM-7) refactors this to segment-aware distillation per Nuum: identify coherent conversation segments first, then extract operational context + retained facts per segment. The flat format remains as fallback. See "Nuum refinement" section above and Loop B PRD stories MEM-7 through MEM-10.

```typescript
// ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-prompt.ts

export const OBSERVER_SYSTEM_PROMPT = `You are an observation engine for a personal AI system operated by Joel Hooks — a systems thinker who builds developer tools and AI infrastructure.

Your job: extract structured observations from agent session transcripts. You are NOT summarizing. You are extracting durable facts, decisions, preferences, and insights that should persist beyond this session.

## What to Observe

### 🔴 High Priority — Durable facts and decisions
These persist for weeks/months. Extract when Joel:
- STATES a preference, rule, or constraint ("always use...", "never do...", "I prefer...")
- MAKES an architecture decision with rationale
- DISCOVERS a debugging root cause (what broke, why, the actual fix)
- CHANGES service/tool state (installed, removed, reconfigured, migrated)
- CORRECTS the agent's understanding of something
- ESTABLISHES a new convention or pattern

### 🟡 Medium Priority — Working context
These persist for days. Extract when:
- Files are modified and why (not the diff, the intent)
- Tool configurations or commands are noteworthy
- Project status changes (task completed, blocked, descoped)
- A pattern is discovered (something that worked or didn't, and why)
- An ADR is created, accepted, or superseded

### 🟢 Low Priority — Ephemeral context
These persist for hours. Extract when:
- Questions are asked but not definitively answered
- Options are explored but not committed to
- Routine operations happen without novel insight
- Something is noted as "maybe later" or "worth considering"

## Rules

1. **TEMPORAL ANCHORING**: Use timestamps from the transcript when available: "(09:15) ..."
   Pi session entries include ISO timestamps. The serialized input prepends "[HH:MM]" to each message block.
   If no timestamp is available for a message, use relative ordering: "(early in session)" / "(near end)".
   If the observation references a future or past event, note both: "(09:15) Joel will restart the worker after lunch. (meaning ~13:00 PST)"
   NEVER invent a specific clock time that isn't in the transcript.

2. **ASSERTIONS > QUESTIONS**: When Joel STATES something = 🔴 authoritative fact.
   When Joel ASKS about something = 🟡 question, NOT a fact.
   A question NEVER invalidates a prior assertion.
   Pattern from Mastra: "The question doesn't invalidate what they told you."

3. **STATE CHANGES**: Note what replaced what.
   Good: "Worker now runs from monorepo (replacing standalone ~/Code/system-bus/)"
   Bad: "Worker location changed"

4. **PRESERVE SPECIFICS**: Keep exact paths, versions, error messages, config values, command output.
   Good: "Redis SETNX memory:observe:lock:{key} with EX 3600"
   Bad: "Using Redis for locking"

5. **QUOTE UNUSUAL PHRASING**: If Joel says something distinctive, quote it verbatim.
   Example: Joel stated "slog is for infra changes only, not code edits"

6. **NO HALLUCINATION**: Only observe what's explicitly in the transcript.
   If uncertain, use 🟢 and note: "(09:30) 🟢 Joel may prefer local models for embedding (inferred from 'prefer to avoid API for core memory shit')"

7. **NO TOOL OUTPUT REGURGITATION**: Don't repeat file contents, command output, or code blocks.
   Observe the DECISION or INSIGHT that resulted from them.

## Output Format (flat — Phase 1 Loop A, superseded by segment format below)

<observations>
Date: {YYYY-MM-DD}

* 🔴 ({HH:MM}) {observation}
* 🔴 ({HH:MM}) {observation}
* 🟡 ({HH:MM}) {observation}
* 🟢 ({HH:MM}) {observation}
</observations>

<current-task>
Primary: {what was being worked on when the session ended/compacted}
Secondary: {other active threads, if any}
</current-task>

<suggested-response>
{If interrupted by compaction: how should the agent continue? What was the last user intent?}
{If session ended normally: "Session completed normally."}
</suggested-response>

## Output Format (segment-aware — Phase 1 Loop B, MEM-7)

<observations>
Date: {YYYY-MM-DD}

<segment>
<narrative>Debugged the Inngest worker registration failure. Root cause: duplicate event trigger across two functions. Fixed by removing the stale trigger from video-download.ts.</narrative>
<facts>
* 🔴 ({HH:MM}) Inngest rejects function registration when two functions share the same event trigger — silent failure, no error in worker logs
* 🔴 ({HH:MM}) The fix was removing `video.requested` trigger from video-download.ts (already handled by video-ingest.ts)
* 🟡 ({HH:MM}) Docker logs (`docker logs system-bus-inngest-1`) show registration errors that worker stderr does not
</facts>
</segment>

<segment>
<narrative>Reviewed and accepted ADR-0019 for past-tense event naming. Renamed 19 files, 219 tests pass.</narrative>
<facts>
* 🔴 ({HH:MM}) All Inngest events now use past-tense naming: `video.requested` not `video.request`
* 🟡 ({HH:MM}) Agent loop chain order: started → story.dispatched → tests.written → code.committed → checks.completed → story.passed/failed/retried → completed
</facts>
</segment>

</observations>

<current-task>
Primary: {what was being worked on when the session ended/compacted}
Secondary: {other active threads, if any}
</current-task>

<suggested-response>
{If interrupted by compaction: how should the agent continue? What was the last user intent?}
{If session ended normally: "Session completed normally."}
</suggested-response>
`;

export const OBSERVER_USER_PROMPT = (messages: string, trigger: string, sessionName?: string) =>
  \`Extract observations from this \${trigger === "compaction" ? "pre-compaction" : "session"} transcript\${sessionName ? \` (session: \${sessionName})\` : ""}:

\${messages}\`;
```

### Observer Output Parser

Resilient XML parser with list-item fallback, adapted from Mastra's `parseObserverOutput()` (`observer-agent.ts` lines ~560-580).

> **Evolution note (2026-02-15):** Phase 1 Loop B (MEM-8) adds `DistilledSegment` interface and `parseSegments()` for the segment-aware format. `ObserverOutput` gains a `segments: DistilledSegment[]` field. Empty array = flat format fallback (backward compatible).

```typescript
// ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-parser.ts

export interface ObserverOutput {
  observations: string;           // raw observation text (date-grouped, prioritized)
  currentTask: string | null;
  suggestedResponse: string | null;
  parsed: boolean;                // false = fell back to list-item extraction
}

export function parseObserverOutput(raw: string): ObserverOutput {
  const obsMatch = raw.match(/<observations>([\s\S]*?)<\/observations>/);
  const taskMatch = raw.match(/<current-task>([\s\S]*?)<\/current-task>/);
  const respMatch = raw.match(/<suggested-response>([\s\S]*?)<\/suggested-response>/);

  if (obsMatch) {
    return {
      observations: obsMatch[1].trim(),
      currentTask: taskMatch?.[1]?.trim() ?? null,
      suggestedResponse: respMatch?.[1]?.trim() ?? null,
      parsed: true,
    };
  }

  // Fallback: extract lines with priority emoji markers
  const lines = raw.split("\n").filter(l => /^\s*\*?\s*[🔴🟡🟢]/.test(l));
  return {
    observations: lines.join("\n") || raw,
    currentTask: null,
    suggestedResponse: null,
    parsed: false,
  };
}

/**
 * Strip 🟡/🟢 observations for context injection (keep only 🔴).
 * Adapted from Mastra's optimizeObservationsForContext() (observer-agent.ts lines ~630-660).
 */
export function optimizeForContext(observations: string): string {
  return observations
    .split("\n")
    .filter(l => l.includes("🔴") || l.startsWith("Date:") || l.trim() === "")
    .join("\n")
    .trim();
}
```

### Reflector Prompt

Adapted from Mastra's `buildReflectorSystemPrompt()` (`reflector-agent.ts` lines ~20-110). Key pattern: the Reflector receives the Observer's extraction instructions so it understands how observations were created, then condenses them.

```typescript
// ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/reflect-prompt.ts

import { OBSERVER_SYSTEM_PROMPT } from "./observe-prompt";

export const REFLECTOR_SYSTEM_PROMPT = `You are a memory reflector for Joel Hooks' personal AI system.

You receive structured observations extracted by the Observer (instructions below for context).
Your job: condense and reorganize these observations into proposed updates for MEMORY.md.

## Observer Instructions (for your reference)
${OBSERVER_SYSTEM_PROMPT}

## Your Task

Read the accumulated observations and produce proposed updates for MEMORY.md.
MEMORY.md has these sections: Joel, Hard Rules, System Architecture, Patterns.

### Condensation Rules

1. **TEMPORAL GRADIENT**: Condense older observations more aggressively. Keep recent ones (last 24h) nearly verbatim. Observations from 3+ days ago should be distilled to their core fact.

2. **ASSERTION PRECEDENCE**: User assertions (🔴) are authoritative. If a later question (🟡) seems to revisit a prior assertion, the assertion stands unless explicitly contradicted by a new assertion.

3. **MERGE RELATED**: Combine observations about the same topic across sessions. "Installed Redis" + "Configured Redis port 6379" + "Redis running in Docker" → one consolidated observation.

4. **PRESERVE SPECIFICS**: Keep paths, versions, commands. "Redis at port 6379 in Docker" not "Redis is running."

5. **DROP RESOLVED**: If an observation was about a problem that was subsequently fixed in a later observation, keep only the resolution (and the root cause if it's a useful pattern).

6. **CATEGORIZE**: Each proposed update should target a specific MEMORY.md section:
   - **Joel**: preferences, communication style, decision patterns
   - **Hard Rules**: explicit "never/always" constraints Joel has stated
   - **System Architecture**: infrastructure state, service topology, key paths
   - **Patterns**: what works, what doesn't, debugging insights, conventions

## Output Format

<proposals>
## Proposed for: {section name}
- {proposed MEMORY.md line, with (YYYY-MM-DD) prefix}
- {proposed MEMORY.md line}

## Proposed for: {section name}
- {proposed MEMORY.md line}
</proposals>

<summary>
{1-2 sentence summary of what changed across all observations — for the daily log}
</summary>
`;

/**
 * Compression guidance levels per Mastra's COMPRESSION_GUIDANCE
 * (reflector-agent.ts lines ~115-160). Applied on retry when output ≥ input.
 */
export const COMPRESSION_GUIDANCE = [
  "", // level 0: no guidance (first attempt)
  "\n\nIMPORTANT: Your previous output was too large. Aim for 8/10 detail level. Merge more aggressively, especially for observations older than 48 hours.",
  "\n\nCRITICAL: Your output must be significantly shorter. Aim for 6/10 detail level. Keep only 🔴 observations and the most critical 🟡 patterns. Drop all 🟢 items entirely.",
];
```

### Compression Validation

Per Mastra's `validateCompression()` (`reflector-agent.ts` lines ~230-235):

```typescript
export function validateCompression(inputTokens: number, outputTokens: number): boolean {
  return outputTokens < inputTokens;
}
```

Reflector function retries up to 2 times with escalating compression guidance if validation fails.

## Constraints

- **No Mastra dependency.** Patterns and prompts are adapted from MIT-licensed source, not imported.
- **No external API for core memory embeddings.** Embedding model runs locally on Apple Silicon. Observer and Reflector LLMs run via `pi -p --no-session` — the same pattern used by `content/summarize`. Pi handles model selection, API keys, and provider routing. No additional SDK dependency in the worker.
- **`igs send` is the transport abstraction.** Pi extension shells out to CLI, never HTTP POSTs directly.
- **Inngest is the execution layer.** No in-process LLM calls from the pi extension.
- **MEMORY.md is hand-editable.** The Reflector stages proposals in REVIEW.md; Joel approves. Automated promotion is a future phase after trust is established.
- **MEMORY.md canonical path: `~/.joelclaw/workspace/MEMORY.md`**. All references must use this path. Project 08's `~/Vault/MEMORY.md` reference is stale.
- **Pi's `serializeConversation()` is the serializer.** Import from `@mariozechner/pi-coding-agent`, don't reimplement.
- **Event names follow ADR-0019.** Factual state descriptors, not imperative commands.
- **Observation pipeline never blocks pi.** Events are fire-and-forget via `exec()`.

## Non-goals

- **Lamarck-style bullet lifecycle.** Maturity levels (candidate → proven → deprecated), feedback decay, skill analysis — these are valuable but premature. The Reflector is simpler: extract → condense → propose. Bullet lifecycle can layer on top once the base pipeline is proven.
- **Andy-timeline narrative chapters.** Weekly narrative generation is a separate concern. Observations feed into daily logs, not narrative arcs.
- **Defib-style health monitoring.** Health checks for Docker/worker/Caddy belong in a separate system, not the memory pipeline.
- **Multi-user scoping.** All sessions are Joel's. No need for Mastra's thread vs resource scope distinction.
- **Real-time observation.** Mastra's async buffering pre-computes observations in background intervals. Inngest IS the async layer — no need for in-process background threads.
- **Replacing pi's compaction.** Pi's built-in compaction continues as-is. Observations are a parallel extraction, not a replacement.

## Considered Alternatives

### Alternative A: Keep ADR-0014 + ADR-0020 as separate specs

Maintain the workspace ADR and observation pipeline ADR independently.

**Rejected because:** The two ADRs have overlapping scopes (both touch daily logs, both affect session-lifecycle extension, both define storage patterns), conflicting path references, and the implementation plan in each assumes the other exists without explicit coordination. A single spec eliminates these gaps.

### Alternative B: Full lamarck-style pipeline from day one

Implement the complete lamarck pipeline: incremental session scan → LLM reflection → playbook curation with bullet lifecycle → feedback decay → per-project MEMORY.md export.

**Rejected because:** Lamarck is sophisticated infrastructure optimized for multi-project, multi-session analysis at scale. Joel's system has 23 sessions over 24 hours on one machine. The Observer/Reflector pattern gets 80% of the value (structured extraction + condensation) with 20% of the complexity. Bullet lifecycle and feedback decay can layer on top once the base pipeline proves itself.

### Alternative C: Enhance pi compaction with custom summary

Replace pi's compaction summary with an observation-enriched one by returning a custom summary from `session_before_compact`.

**Rejected because:** Compaction and observation serve different purposes. Compaction maintains session continuity for the current conversation. Observation extracts durable knowledge for future sessions. Coupling them means a regression in one degrades the other.

## Consequences

### Positive

- **One canonical spec.** No more hunting across ADR-0014, ADR-0020, and Project 08 for memory system design.
- **Knowledge compounds.** Every session ≥5 messages produces structured observations → proposals → curated MEMORY.md.
- **Semantic search from day one.** Qdrant dual-write means observations are searchable by meaning, not just keywords.
- **Human-in-the-loop.** REVIEW.md staging + session briefing nudge keeps Joel in control of what enters MEMORY.md.
- **Observable pipeline.** Every observation and reflection is visible in Inngest dashboard with full trace.

### Negative

- **LLM cost per session.** Observer (per-session, cheap model) + Reflector (daily cron, stronger model) via `pi -p`. Cost depends on pi's configured provider/model. At Anthropic rates with Haiku 4.5 / Sonnet 4.5: estimated <$0.50/day at current volume. Monitor via Inngest run history.
- **Local embedding cost.** CPU/GPU time for embedding each observation. On M-series with MLX, this should be negligible (<1s per observation).
- **Redis dependency.** If Redis is down, observations can't be stored. Mitigation: daily log append is a fallback write path. Inngest retries handle transient failures.
- **Review fatigue.** If the Observer is noisy, REVIEW.md fills with low-value proposals. Mitigation: Reflector filters 🟢 items; only 🔴 and notable 🟡 become proposals. Auto-archive proposals older than 7 days.

### Follow-up tasks

**Immediate (on acceptance):**
1. ~~Set ADR-0014 status to `superseded by ADR-0021`~~ ✅ done
2. ~~Set ADR-0020 status to `superseded by ADR-0021`~~ ✅ done
3. ~~Update ADR README index with ADR-0021 and supersession notes~~ ✅ done
4. ~~Update Project 08 index: reference ADR-0021, fix stale path, replace 5-layer with 3-tier~~ ✅ done

**Phase 1 (Observer pipeline):**
5. Add memory event types to `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts`
6. Create `observe.ts`, `observe-prompt.ts`, `observe-parser.ts` in system-bus functions
7. Add `@qdrant/js-client-rest` dependency, create collection `memory_observations` with 768-dim vectors
8. Implement local embedding utility via MLX (`nomic-embed-text`)
9. Register observe function in `functions/index.ts` and `serve.ts`
10. Update session-lifecycle extension: timestamp-aware serialization, `spawn`-based `igs send`
11. Write unit tests: `observe-parser.test.ts`, dedupe key generation
12. Run golden test: 3 real transcripts → Observer → manual quality review

**Phase 1 addendum — Nuum segment-aware distillation (Loop B, post MEM-6):**
13. Refactor `OBSERVER_SYSTEM_PROMPT` to segment-aware distillation — identify coherent conversation segments, per segment produce operational context + retained facts with `<segment>` tags
14. Add `DistilledSegment` interface and `parseSegments()` to `observe-parser.ts`, update `ObserverOutput` with `segments` field (backward-compatible)
15. Update `optimizeForContext` for segment-aware format + add `formatSegmentsForLog()` for daily log rendering
16. Update `observe-parser.test.ts` with segment-aware test cases (all existing tests must still pass)

**Phase 2 (Reflector + review):**
17. Create `reflect.ts`, `reflect-prompt.ts` in system-bus functions
14. Create REVIEW.md format with proposal IDs
15. Add REVIEW.md reading + nudge to session-lifecycle briefing
16. Write tests: compression validation, retry escalation, REVIEW.md format

**Phase 3 (Promotion workflow):**
17. Implement proposal promotion/rejection/archive by proposal ID
18. Add 7-day auto-archive for unreviewed proposals

**Phase 4 (Friction analysis) — GATED, collecting data:**
19. Create `friction.ts`, `friction-prompt.ts` — daily cron, Qdrant semantic clustering
20. Add `## Friction Fixes` section to REVIEW.md format
21. Gate: requires 2+ weeks of observation data before deployment
22. ~~**Prerequisite**: Add real embeddings to observe.ts~~ ✅ Done — local nomic-embed-text-v1.5 via Python subprocess, 768-dim vectors confirmed real and searchable

**Data collection status (updated 2026-02-19):**
- Pipeline running: observe → reflect → promote all verified end-to-end
- Observations: 227 Qdrant points across 6 days with `🔭 Observations` in daily logs
- Redis: 20 proposals generated (`p-20260219-001` through `020`)
- Qdrant: 227 points with 768-dim nomic-embed vectors (semantic search verified)
- ~~Gap: REVIEW.md never written — proposals trapped in Redis.~~ ✅ Fixed: Todoist-as-review-surface implemented
- ~~Gap: `todoist/task.completed` webhook doesn't pass labels~~ ✅ Fixed: labels flow through normalizer
- Phase 3 **verified**: todoist-memory-review-bridge fires on task.completed AND task.deleted, reflect→Todoist creates 8 proposal tasks on manual trigger, promote expiry+cleanup deployed
- Phase 3 review UX: complete=approve, delete=reject, @rejected label=reject, ignore=7-day auto-expiry. check-memory-review surfaces expiring proposals (>5 days).
- Phase 4 deployed: friction.ts + friction-prompt.ts, daily cron 7 AM + manual `memory/friction.requested` event, gated on 100+ points (have 227). First manual run produced no friction tasks — needs investigation.
- Check-in target: ~2026-03-05 (Todoist task — verify friction produces actionable results)
- ✅ Real nomic-embed vectors confirmed in Qdrant (768-dim, similarity search working)

## Implementation Plan

### Phase 1: Observer Pipeline + Search Foundation

**Target**: First working observation extracted, stored, and searchable.

**Affected paths:**
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` — add event types
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe.ts` — new
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-prompt.ts` — new
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-parser.ts` — new
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/index.ts` — register
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts` — register + health list
- `~/Code/joelhooks/pi-tools/session-lifecycle/index.ts` — add event emission

**Story 1: Event types + Observer Inngest function**
- Add `memory/session.compaction.pending` and `memory/session.ended` to client.ts (typed schema above)
- Create `observe.ts`:
  - Triggered by either event
  - Step 1 (`dedupe-check`): `SETNX memory:observe:lock:{dedupeKey}` with `EX 3600`. Return early if exists.
  - Step 2 (`observe`): Call `pi -p --no-session --system-prompt {observerPrompt}` with timestamped serialized messages as user prompt. Model selection via pi's `--model` flag (e.g., `--model haiku` for cheap extraction).
  - Step 3 (`parse`): Parse XML output via `observe-parser.ts`. Extract highest priority level for metadata.
  - Step 4 (`append-daily-log`): Write `### 🔭 Observations` section to daily log **first** — this is the durable fallback if subsequent writes fail.
  - Step 5 (`store-redis`): `RPUSH memory:observations:{date}` with JSON entry (including `priority`, `schemaVersion`)
  - Step 6 (`store-qdrant`): Embed observation text locally via `nomic-embed-text`, upsert to `memory_observations` collection with full payload metadata
  - Step 7 (`check-threshold`): Sum token counts via `LRANGE`. If > 40k AND `SETNX memory:reflect:triggered:{date}` succeeds (once-per-day guard), emit `memory/observations.accumulated`.
  - Concurrency: `{ key: "event.data.sessionId", limit: 1 }`
- Export from `functions/index.ts`, register in `serve.ts`

**Story 2: Pi extension event emission**
- In `session_before_compact`:
  - Serialize messages with timestamps: iterate `preparation.messagesToSummarize`, prepend `[HH:MM]` from each entry's `timestamp` field, then `serializeConversation()` for content. Pi session entries have ISO timestamps (confirmed: `"timestamp": "2026-02-14T17:05:50.648Z"` in JSONL).
  - Compute dedupe key: `sha256(sessionId + "compaction" + firstEntryTimestamp)`
  - `emitEvent("memory/session.compaction.pending", payload)` via `spawn` (see Transport section)
  - Continue with existing metadata flush
- In `session_shutdown`:
  - Count user messages from session entries; skip if < 5
  - Serialize entries with timestamps (same approach as compaction)
  - Compute dedupe key: `sha256(sessionId + "shutdown" + firstEntryTimestamp)`
  - `emitEvent("memory/session.ended", payload)` via `spawn`
  - Continue with existing auto-name + handoff

**Story 3: Qdrant collection setup**
- Create collection `memory_observations` with schema (see Storage Architecture above)
- Select and test local embedding model (MLX or ONNX)
- Implement `embedObservation(text: string): Promise<number[]>` utility
- Test: embed 3 real observation texts, verify Qdrant stores and retrieves them

**Tests for Phase 1:**
- `observe-parser.test.ts`: XML extraction, fallback, malformed input, empty input
- Dedupe key generation: deterministic, collision-free
- Integration: emit event → observe → Redis has entry → Qdrant has point → daily log has section
- Failure: Redis down → Inngest retries (not silent)
- Failure: LLM malformed output → parser fallback → observation still stored
- Golden: 3 real session transcripts → Observer → manual quality review
- Structural: `bunx tsc --noEmit` passes

### Phase 2: Reflector + Review Staging + Recursive Distillation

**Target**: Observations condense into MEMORY.md proposals, staged for review. Older observations are recursively distilled to create a temporal gradient (Nuum pattern).

**Affected paths:**
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/reflect.ts` — new
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/reflect-prompt.ts` — new
- `~/.joelclaw/workspace/REVIEW.md` — created by Reflector

**Story 4: Reflector Inngest function**
- Create `reflect.ts`:
  - Triggered by `memory/observations.accumulated` OR daily cron (`0 6 * * *` — 6 AM PST)
  - Step 1 (`load-observations`): `LRANGE memory:observations:{date} 0 -1` for all dates in period
  - Step 1b (`recursive-distill`): For observations older than 3 days, apply recursive distillation — compress segments more aggressively, keeping only narratives + 🔴 facts. This creates the Nuum temporal gradient: recent segments stay detailed, older ones become abstract. Re-distilled entries replace originals in Redis (LSET by index).
  - Step 2 (`reflect`): Call `pi -p --no-session --model sonnet-4.5 --system-prompt {reflectorPrompt}` with observations + existing MEMORY.md as user prompt. When segment-aware observations are present, the Reflector sees structured segments (narrative + facts) rather than flat bullet lists.
  - Step 3 (`validate`): `validateCompression(inputTokens, outputTokens)`. If fails, retry with `COMPRESSION_GUIDANCE[level]` up to level 2.
  - Step 4 (`stage-review`): Parse `<proposals>` → write/append `REVIEW.md`
  - Step 5 (`append-daily-log`): Write `### 🔭 Reflected` summary to daily log
  - Step 6 (`emit-complete`): Emit `memory/observations.reflected` with stats

**Story 5: Session-lifecycle REVIEW.md integration**
- In `before_agent_start` (first turn):
  - Read `~/.joelclaw/workspace/REVIEW.md`
  - If proposals exist, add to briefing: `"📋 {N} pending memory proposals in REVIEW.md — review when ready"`
  - Include `<current-task>` and `<suggested-response>` from most recent observation

**Tests for Phase 2:**
- Compression validation: output < input across guidance levels
- Retry logic: level 0 → 1 → 2 escalation works
- REVIEW.md format: proposals grouped by section, checkboxes present
- Briefing: nudge appears when REVIEW.md has content, absent when empty
- Golden: Reflector condenses 5+ observations into coherent proposals

### Phase 3: Review Workflow + Memory Promotion

**Target**: Joel can approve/reject proposals; approved items merge into MEMORY.md.

**Affected paths:**
- `~/Code/joelhooks/pi-tools/session-lifecycle/index.ts` — review integration
- `~/.joelclaw/workspace/MEMORY.md` — promoted content
- Future: pi extension for status bar notification

**Story 6: Review and promotion**
- When Joel marks a proposal checkbox as `[x]` in REVIEW.md, next session detects it
- Approved proposals: append to appropriate MEMORY.md section with `(YYYY-MM-DD)` prefix
- Rejected proposals (deleted or marked `[-]`): archived in daily log as rejected
- Auto-archive: proposals older than 7 days without action → move to daily log as expired
- Future enhancement: pi TUI status bar extension showing pending review count

**Tests for Phase 3:**
- Promotion: checked item in REVIEW.md → appears in MEMORY.md
- Rejection: deleted item → logged in daily log as rejected
- Auto-archive: 7-day expiry works
- No data loss: every proposal either promoted, rejected, or archived

### Phase 4: Friction Analysis (daily cron, cross-session pattern detection)

**Target**: System self-healing through automated detection of recurring pain points across sessions.

This phase is a **consumer** of the observation pipeline, not part of it. It runs as an independent daily Inngest cron that reads accumulated observations from Qdrant and identifies friction patterns that the per-session Observer can't see.

**Affected paths:**
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/friction.ts` — new
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/friction-prompt.ts` — new
- `~/.joelclaw/workspace/REVIEW.md` — friction proposals added alongside Reflector proposals

**What friction analysis detects:**

| Pattern | Example | Action |
|---------|---------|--------|
| **Repeated corrections** | Joel corrected agent about slog usage in 4 sessions | Propose AGENTS.md update or new Hard Rule |
| **Recurring failures** | Same Inngest debugging loop across 5 sessions | Propose skill or config fix |
| **Tool misuse** | Agent keeps using `pip` instead of `uv` | Strengthen skill enforcement or add to system prompt |
| **Configuration drift** | Worker restarted 3 times, same root cause | Propose infrastructure fix (launchd, Docker config) |
| **Missing skills** | Agent repeatedly searches for the same capability | Propose new skill creation |
| **Stale memory** | MEMORY.md entry contradicted by recent observations | Propose MEMORY.md correction |

**Story 7: Friction analysis Inngest function**
- `memory/friction.analyze` — daily cron, runs after the Reflector (e.g., 7 AM PST)
- Step 1 (`query-observations`): Query Qdrant `memory_observations` for all observations from the past 7 days. Group by semantic similarity (cluster related observations).
- Step 2 (`detect-patterns`): Call LLM with clustered observations + current MEMORY.md + AGENTS.md. Prompt: "Identify recurring friction patterns — corrections stated multiple times, failures with the same root cause, tool misuse, stale information."
- Step 3 (`propose-fixes`): For each detected pattern, generate a concrete actionable proposal:
  - Target file (AGENTS.md, MEMORY.md, a specific skill, a config file)
  - Proposed change (exact text to add/modify/remove)
  - Evidence (which sessions/observations support this)
  - Severity: how many sessions affected, estimated time wasted
- Step 4 (`stage-proposals`): Append to REVIEW.md under `## Friction Fixes` section with proposal IDs (`f-YYYYMMDD-NNN`)
- Concurrency: `{ limit: 1 }` (only one friction analysis at a time)

**Friction prompt design principles:**
- Input: 7 days of observations (from Qdrant semantic clusters) + MEMORY.md + AGENTS.md
- Focus: What keeps going wrong? What does Joel keep having to repeat? What's the system not learning?
- Output: Concrete proposals with evidence, not vague "improve X"
- Severity scoring: frequency × impact (sessions affected × estimated friction per occurrence)
- Attribution: every proposal links back to specific observation IDs

**REVIEW.md friction section:**
```markdown
## Friction Fixes (auto-detected 2026-02-22)
- [ ] `f-20260222-001` **Add uv-only rule to AGENTS.md** — Agent used pip in 3/20 sessions this week despite python skill. Target: `~/.pi/agent/AGENTS.md`, add to Hard Rules. Evidence: sessions 2026-02-18, 2026-02-20, 2026-02-21.
- [ ] `f-20260222-002` **Update MEMORY.md: worker path** — "Worker runs from ~/Code/system-bus/" is stale (migrated 2026-02-14). Target: `~/.joelclaw/workspace/MEMORY.md` System Architecture section. Evidence: 2 sessions referenced wrong path.
```

**Verification for Phase 4:**
- [ ] Friction cron fires daily at 7 AM PST
- [ ] Qdrant query returns clustered observations from past 7 days
- [ ] At least one friction pattern detected from test data (seed 10+ observations with known repeats)
- [ ] Proposals in REVIEW.md include evidence links, target files, and severity scores
- [ ] Proposals are actionable: an agent can implement the proposed change without follow-up questions

**Gating condition**: Phase 4 requires at least 2 weeks of observation data in Qdrant to produce meaningful cross-session patterns. Do not implement until Phases 1-2 have been running in production.

### Phase 5: Reflect Tool (on-demand memory recall)

**Target**: Agents can query accumulated memory mid-session without loading full history into context. Nuum pattern: "illusion of perfect recall."

**Affected paths:**
- `~/.pi/agent/skills/reflect/` — new pi skill, OR
- `~/Code/joelhooks/pi-tools/` — new pi extension tool

**Concept**: A pi skill or tool that, when invoked by an agent ("what did we decide about Redis TTLs?" or "reflect on the Inngest worker debugging"), spawns a sub-agent with:
- Full-text search over Redis temporal memory (`LRANGE` + keyword filter)
- Semantic search over Qdrant `memory_observations` (dense + BM25 + RRF)
- Access to current MEMORY.md (curated long-term memory)
- Returns a synthesized answer — not raw observations, but a coherent response to the query

**Why this matters**: Without it, agents only see MEMORY.md (curated, possibly stale) and the daily log (verbose, unstructured). The Reflect tool gives access to the full observation history — including segment narratives, retained facts, and distilled context from weeks ago — without consuming context window tokens until specifically asked.

**Gating condition**: Requires Phases 1-2 operational (observations in Qdrant, distilled segments in Redis) to return meaningful results.

### Phase 6: Future Enhancements (roadmap only)

- **Lamarck-style bullet lifecycle**: candidate → established → proven → deprecated with feedback decay. Layer on top of Reflector proposals once the review workflow proves reliable.
- **Timeline narrative**: weekly chapter generation from observations + git activity (andy-timeline pattern). Writes to `~/Vault/system/timeline/`.
- **Auto-promotion with trust score**: After N successful review cycles, auto-promote 🔴 proposals. Track acceptance rate per category to calibrate trust threshold.
- **Pi TUI status bar extension**: subtle footer notification for pending reviews.
- **Friction → auto-fix pipeline**: For low-risk friction fixes (stale MEMORY.md entries, missing Hard Rules), auto-apply and notify rather than staging for review.
- **Nuum-style continuous distillation**: Monitor context window fill rate and proactively distill at ~60% capacity, rather than waiting for compaction/shutdown events. Would require deeper pi integration (custom compaction handler).

## Verification Criteria

### Phase 1 — Must pass before shipping
- [ ] `bunx tsc --noEmit` passes in system-bus with new event types and functions
- [ ] `observe-parser.test.ts` passes: XML extraction, list-item fallback, malformed input, empty input
- [ ] `memory/session.compaction.pending` event appears in Inngest dashboard when pi compacts
- [ ] `memory/session.ended` event appears when session shuts down with ≥5 user messages
- [ ] Events do NOT fire for sessions with <5 user messages on shutdown
- [ ] Dedupe works: same event retried by Inngest → only one observation stored (SETNX prevents duplicate)
- [ ] Observer produces `<observations>` with 🔴/🟡/🟢 markers and timestamps
- [ ] Observations in Redis: `LRANGE memory:observations:YYYY-MM-DD 0 -1` returns entries
- [ ] Observations in Qdrant: `memory_observations` collection has points with correct metadata
- [ ] Observations in daily log: `### 🔭 Observations` section present
- [ ] Pi compaction latency unchanged: `spawn` returns immediately, no measurable delay added
- [ ] `igs runs --status COMPLETED --hours 1` shows observe function runs with step traces
- [ ] Redis down → Inngest retries function (visible as retry count > 0 in `igs run {id}`)
- [ ] Golden test: 3 real transcripts → Observer output reviewed manually → each has ≥1 🔴 observation, no hallucinated timestamps, no regurgitated tool output

### Phase 1 addendum (Loop B) — Must pass before shipping
- [ ] `OBSERVER_SYSTEM_PROMPT` instructs segment identification (topic shifts, natural breakpoints, temporal clustering)
- [ ] Each segment produces operational context (narrative) + retained facts (bullets with 🔴/🟡/🟢)
- [ ] Output uses `<segment>` tags with `<narrative>` and `<facts>` children inside `<observations>`
- [ ] `DistilledSegment` interface exported from `observe-parser.ts`
- [ ] `parseSegments()` extracts segments from `<segment>` blocks
- [ ] `ObserverOutput` includes `segments: DistilledSegment[]` (empty array for flat format — backward compatible)
- [ ] `optimizeForContext` handles both segment and flat formats
- [ ] `formatSegmentsForLog` renders segments as readable markdown for daily log
- [ ] All existing MEM-6 tests still pass (backward compat)
- [ ] New tests cover segment parsing, backward compat, optimizeForContext with segments, formatSegmentsForLog
- [ ] `bunx tsc --noEmit` passes

### Phase 2 — Must pass before shipping
- [ ] Reflector output < input tokens (compression validation)
- [ ] Retry with escalating guidance works (level 0 → 1 → 2)
- [ ] REVIEW.md created with proposals grouped by section
- [ ] Session briefing shows review nudge when proposals pending
- [ ] Daily log has `### 🔭 Reflected` section with summary
- [ ] Daily cron fires at 6 AM and processes accumulated observations

### Phase 3 — Must pass before shipping
- [ ] Checked proposals in REVIEW.md are promoted to MEMORY.md by proposal ID
- [ ] Deleted/rejected proposals are archived in daily log with proposal ID
- [ ] 7-day auto-archive works for unreviewed proposals
- [ ] Existing MEMORY.md content is never deleted by promotion

### Phase 4 — Must pass before shipping (gated on 2+ weeks of observation data)
- [ ] Friction cron fires daily and queries Qdrant for 7-day observation window
- [ ] Detected friction patterns include evidence (session IDs, observation count)
- [ ] Proposals in REVIEW.md `## Friction Fixes` section have IDs, target files, and severity
- [ ] Each proposal is actionable (agent can implement without follow-up questions)

## Dependencies and Environment

### Phase 1 new dependencies for system-bus

```bash
# In ~/Code/joelhooks/joelclaw/packages/system-bus/
bun add @qdrant/js-client-rest   # Qdrant client
# LLM calls: via pi -p --no-session (same pattern as summarize.ts, no SDK needed)
# Embedding: local MLX model — invoked via subprocess, no npm dep
```

### LLM execution pattern

The existing `summarize.ts` function already calls pi from the worker:

```typescript
// Proven pattern from summarize.ts (line ~55)
await $`pi -p --no-session "Read the file at ${vaultPath} and enrich it."`.quiet();
```

Observer and Reflector follow the same pattern:

```typescript
// Observer: cheap model, structured extraction
const raw = await $`pi -p --no-session --model "anthropic/claude-haiku-4-5" --system-prompt "${systemPrompt}" "${userPrompt}"`.text();

// Reflector: stronger model, judgment-intensive condensation
const raw = await $`pi -p --no-session --model "anthropic/claude-sonnet-4-5" --system-prompt "${systemPrompt}" "${userPrompt}"`.text();
```

**Spike-verified**: Haiku 4.5 produces clean XML output with `<observations>`, `<current-task>`, `<suggested-response>` tags from the Observer prompt. Parser extracts all three sections. `--model` requires full `provider/model` format — bare `haiku` resolves to wrong provider.

Pi handles provider routing, API keys, rate limiting, and retries. The worker has zero LLM configuration — it delegates entirely to pi. Model choice is a `--model` flag, not a dependency.

### Environment variables (add to worker .env)

```
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=memory_observations
OBSERVER_MODEL=anthropic/claude-haiku-4-5
REFLECTOR_MODEL=anthropic/claude-sonnet-4-5
EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5
MEMORY_WORKSPACE=~/.joelclaw/workspace
```

### Cross-harness integrity (preserved from ADR-0014)

All harnesses must resolve to the same memory and identity files via symlinks:

| Symlink | Target | Validates |
|---------|--------|-----------|
| `~/.agents/AGENTS.md` | `~/Code/joelhooks/joelclaw/.agents/AGENTS.md` | Identity |
| `~/.pi/agent/AGENTS.md` | `~/Code/joelhooks/joelclaw/.agents/AGENTS.md` | Identity |
| `~/.claude/AGENTS.md` | `~/Code/joelhooks/joelclaw/.agents/AGENTS.md` | Identity |

Session-start read order (all harnesses): SOUL.md → USER.md → MEMORY.md → today's daily log. This is enforced by the session-lifecycle extension for pi; Claude Code reads AGENTS.md which references the same files.

Integrity check: `ls -la ~/.agents/AGENTS.md ~/.pi/agent/AGENTS.md ~/.claude/AGENTS.md` should all point to the same inode.

## More Information

### Event Naming Convention (local policy)

ADR-0019 proposes past-tense naming system-wide but is still `proposed`. Regardless of ADR-0019's status, this ADR establishes the following naming convention for memory events as local policy: event names describe facts or pending states, not imperative commands. `memory/session.compaction.pending` (state), `memory/session.ended` (fact), `memory/observations.accumulated` (fact), `memory/observations.reflected` (fact).

### Items Preserved from Superseded ADRs

From ADR-0014:
- Cross-harness symlink integrity verification → Dependencies and Environment section
- Session-start read order (SOUL → USER → MEMORY → daily) → Dependencies and Environment section
- All 5 implementation stories (A–E) addressed: A (integrity) in Dependencies, B (compaction flush) in Phase 1, C (compaction pipeline) in Phase 1-2, D (search) in Phase 1 (Qdrant), E (heartbeat) deferred to Phase 5

From ADR-0020:
- Observation injection into session briefing with ~2k token budget and 🔴-only optimization → Phase 3 Story 5 (`optimizeForContext()` strips 🟡/🟢)
- Explicit fallback testing for malformed LLM output and sink failures → Phase 1 test strategy
- All Codex review fixes (transport, idempotency, schemas, registration) incorporated

### Why This Supersedes ADR-0014 and ADR-0020

**ADR-0014** established the workspace layout and identified 5 stories (A–E). Status:
- Story A (integrity checks): addressed by session-lifecycle extension validation
- Story B (pre-compaction flush): implemented in session-lifecycle, enhanced here with observation extraction
- Story C (compaction pipeline): implemented here as Observer + Reflector
- Story D (search): implemented here as Qdrant dual-write + Redis LRANGE
- Story E (heartbeat maintenance): deferred to Phase 4 (not critical path)

All of ADR-0014's verification criteria are either met or addressed by this ADR. It should be marked `superseded`.

**ADR-0020** detailed the Observer/Reflector design but had gaps identified by Codex review (transport conflict, missing idempotency, incomplete schemas). All fixes from that review are incorporated here. It was never accepted and should be marked `superseded`.

### Mastra OM Source File Map

For implementors who want to reference the original patterns:

| Concept | Mastra Source File | Key Lines | Our Adaptation |
|---------|-------------------|-----------|----------------|
| Observer prompt | `observer-agent.ts` | ~100-340 | `observe-prompt.ts` — rewritten for system-engineering context |
| Observer output format | `observer-agent.ts` | ~290-340 | Same XML structure: `<observations>`, `<current-task>`, `<suggested-response>` |
| Message serialization | `observer-agent.ts` | ~480-530 | Use pi's `serializeConversation()` instead |
| Output parser | `observer-agent.ts` | ~560-580 | `observe-parser.ts` — XML + list-item fallback |
| Context optimization | `observer-agent.ts` | ~630-660 | `optimizeForContext()` — strip 🟡/🟢 for briefing |
| Reflector prompt | `reflector-agent.ts` | ~20-110 | `reflect-prompt.ts` — includes Observer instructions as context |
| Compression guidance | `reflector-agent.ts` | ~115-160 | Same 3 levels (none, gentle 8/10, aggressive 6/10) |
| Compression validation | `reflector-agent.ts` | ~230-235 | `validateCompression()` — output < input |
| Token counting | `observational-memory.ts` | ~20 | Use pi's `estimateTokens()` from compaction utils |
| Operation mutex | `observational-memory.ts` | ~45-70 | Inngest concurrency key + Redis SETNX |
| Continuation hint | `observational-memory.ts` | ~420-430 | Session-lifecycle system prompt already handles this |
| Async buffering | `observational-memory.ts` | ~480-580 | Inngest IS the async buffer — events fire, functions run when ready |

All source is MIT licensed. Patterns adapted, not copied.

### Project 08 Update Required

Project 08 (memory system) should be updated to:
1. Reference ADR-0021 as the canonical memory system spec
2. Replace the 5-layer model with the 3-tier architecture
3. Update the "Inngest Functions Needed" table to match ADR-0021's function names
4. Update the "Reality Check" section with current implementation status
5. Remove stale `~/Vault/MEMORY.md` path reference
