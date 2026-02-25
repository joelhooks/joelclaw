---
title: Observational memory pipeline
status: superseded
superseded-by: "[ADR-0021 — Comprehensive agent memory system](0021-agent-memory-system.md)"
date: 2026-02-15
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-15)
informed: All agents operating on this machine
related:
  - "[ADR-0014 — Agent memory workspace](0014-agent-memory-workspace.md)"
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)"
credits:
  - "Mastra AI ([@maaboroshi](https://github.com/mastra-ai/mastra)) — Observational Memory pattern, Observer/Reflector agent architecture, async buffering design. MIT licensed. Source: packages/memory/src/processors/observational-memory/"
  - "Alex Hillman ([@alexknowshtml](https://github.com/alexknowshtml)) — kuato (session recall), andy-timeline (narrative memory)"
  - "John Lindquist ([@johnlindquist](https://github.com/johnlindquist)) — lamarck (reflection → playbook → MEMORY.md pipeline)"
---

# ADR-0020: Observational Memory Pipeline

## Context and Problem Statement

Agents on this system lose conversational nuance between sessions. ADR-0014 established the memory workspace (`MEMORY.md` + daily logs), and the session-lifecycle pi extension (pi-tools v0.3.0) automates briefing injection, compaction flush, and shutdown handoff. But the current compaction flush only records **metadata** (file counts, token counts) — it does not extract **structured observations** from the conversation before it's summarized away.

Pi's built-in compaction (see `pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`) generates a structured summary with Goal/Progress/Decisions/Next Steps, which is good for session continuity. But it's optimized for the current session, not for long-term memory. Key information — user preferences, hard-won debugging insights, architecture decisions, system state changes — gets compressed into a generic summary and eventually lost across multiple compaction cycles.

Mastra AI's Observational Memory (OM) solves this with a two-agent architecture: an **Observer** that extracts prioritized, timestamped observations from conversations, and a **Reflector** that condenses observations when they grow too large. The result is a three-tier context: recent messages → observations → reflections. This is the missing layer between raw session messages and curated `MEMORY.md`.

### What exists today

| Layer | State | Location |
|-------|-------|----------|
| Raw sessions | Working | `~/.pi/agent/sessions/` (JSONL, tree-structured) |
| Compaction summaries | Working | Inline in session JSONL (`CompactionEntry`) |
| Session briefing | Working | pi-tools session-lifecycle extension (injects MEMORY.md + system state on first turn) |
| Pre-compaction flush | Working, metadata only | pi-tools session-lifecycle extension (writes file ops to daily log) |
| Daily logs | Working, manual | `~/.joelclaw/workspace/memory/YYYY-MM-DD.md` |
| Curated memory | Working, manual | `~/.joelclaw/workspace/MEMORY.md` |
| Observation extraction | **Missing** | — |
| Automated reflection → MEMORY.md | **Missing** | — |

### Session data (2026-02-14 through 2026-02-15)

- 23 sessions in ~24 hours, 18M total session data
- 4 sessions hit compaction (17%) — these lose the most nuance
- 39% of sessions started with manual handoff/continuation files (now automated by session-lifecycle)
- 0 sessions used `/resume` or `/tree` branching (all fresh sessions)
- Average session: 5-24 user messages, heavy Vault references (10-220 per session)

## Decision

Adopt the Observer/Reflector pattern from Mastra's Observational Memory, implemented as a pi extension trigger + Inngest pipeline + Redis storage, with no Mastra dependency. The pi extension serializes messages and emits an Inngest event; the Inngest worker runs the Observer LLM and stores results.

### Triggers

1. **`session_before_compact`** — Observe messages about to be compacted (already identified by pi's compaction logic via `preparation.messagesToSummarize`). These are the messages most at risk of information loss.
2. **`session_shutdown`** — If `userMessageCount >= 5`, observe the session's messages. This catches the 83% of sessions that never hit compaction.

### Pipeline

```
Pi Extension (session-lifecycle)
│
├─ session_before_compact:
│   serialize preparation.messagesToSummarize via serializeConversation()
│   shell: igs send "memory/session.compaction.pending" --data '{...}'
│
├─ session_shutdown (if userMsgCount >= 5):
│   serialize recent session entries via sessionManager.getBranch()
│   shell: igs send "memory/session.ended" --data '{...}'
│
└─ (both continue with existing behavior — flush/handoff)

Inngest Worker
│
├─ memory/observe (triggered by memory/session.compaction.pending or memory/session.ended):
│   ① Dedupe check: SETNX memory:observe:lock:{dedupeKey} with 1h TTL
│   ② Call Observer LLM (cheap model: gemini-2.5-flash)
│   ③ Parse output: <observations>, <current-task>, <suggested-response>
│   ④ Store observations in Redis: RPUSH memory:observations:{YYYY-MM-DD} {json}
│   ⑤ Append formatted observations to daily log
│   ⑥ Check total observation tokens for the day
│   ⑦ If > reflection threshold (40k tokens): emit memory/observations.accumulated
│
├─ memory/reflect (triggered by memory/observations.accumulated):
│   ① Load all observations from Redis for current period
│   ② Call Reflector LLM (same model, temperature=0)
│   ③ Validate compression (output < input)
│   ④ Retry with compression guidance if needed (up to 2 retries)
│   ⑤ Merge reflected observations into MEMORY.md
│   ⑥ Archive raw observations to daily log
│
└─ (future: memory/recall — search observations via Redis/Qdrant)
```

### Transport

The pi extension shells out to `igs send` (will become `joelclaw send` per ADR-0009). The CLI owns the Inngest URL, event key, and error handling. If transport changes later (e.g., Redis bridge per ADR-0018 Phase 2), only the CLI changes — the extension is decoupled.

```typescript
// In session-lifecycle extension — event emission
import { exec } from "child_process";
const payload = JSON.stringify({ messages, sessionId, trigger, messageCount, ... });
exec(`igs send "memory/session.compaction.pending" --data '${payload}'`);
```

This aligns with ADR-0018's principle ("pi extension as event emitter") while using the CLI as the transport abstraction rather than coupling the extension to a specific delivery mechanism (HTTP POST, Redis RPUSH, etc.).

### Event schema

Per ADR-0019 (past-tense events), event names describe facts or pending states — not imperative commands.

```typescript
// In ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts
type Events = {
  // ... existing events ...

  // --- Memory pipeline (ADR-0020) ---
  "memory/session.compaction.pending": {
    data: {
      sessionId: string;
      dedupeKey: string;          // sha256(sessionId + firstMessageId + trigger)
      trigger: "compaction";
      messages: string;           // serialized via serializeConversation()
      messageCount: number;
      tokensBefore: number;       // from preparation.tokensBefore
      filesRead: string[];
      filesModified: string[];
      capturedAt: string;         // ISO 8601
      schemaVersion: 1;
    };
  };
  "memory/session.ended": {
    data: {
      sessionId: string;
      dedupeKey: string;          // sha256(sessionId + "shutdown")
      trigger: "shutdown";
      messages: string;           // serialized via serializeConversation()
      messageCount: number;
      userMessageCount: number;
      duration: number;           // session duration in seconds
      sessionName?: string;       // auto-generated name
      filesRead: string[];
      filesModified: string[];
      capturedAt: string;         // ISO 8601
      schemaVersion: 1;
    };
  };
  "memory/observations.accumulated": {
    data: {
      date: string;               // YYYY-MM-DD
      totalTokens: number;
      observationCount: number;
      capturedAt: string;         // ISO 8601
    };
  };
  "memory/observations.reflected": {
    data: {
      date: string;               // YYYY-MM-DD
      inputTokens: number;
      outputTokens: number;
      compressionRatio: number;
      sectionsUpdated: string[];  // MEMORY.md sections modified
      capturedAt: string;         // ISO 8601
    };
  };
};
```

### Idempotency

Dual triggers (compaction + shutdown) can fire for the same session. Inngest retries add further duplication risk. Mitigation:

1. **Dedupe key**: `sha256(sessionId + firstMessageId + trigger)` — unique per session × trigger type.
2. **Redis guard**: `SETNX memory:observe:lock:{dedupeKey}` with 1-hour TTL. If key exists, the Inngest function returns early without calling the Observer LLM.
3. **Observation append is idempotent by design**: Each observation entry includes the dedupeKey. The daily log append includes the session ID header, making duplicate entries visible and skippable.

This matches Mastra's approach with `activeOps` mutex (observational-memory.ts lines ~45-70) but uses Redis instead of an in-process set, which is more appropriate for durable execution across worker restarts.

## Mastra OM Source References

The following files in `mastra-ai/mastra` (MIT licensed) inform this design. Direct code is not copied; patterns and prompts are adapted.

### Observer Agent

**Source**: `packages/memory/src/processors/observational-memory/observer-agent.ts`

Key patterns to adapt:

- **Priority levels** (lines ~300-304 in output format): `🔴 High` (user facts, preferences, goals), `🟡 Medium` (project details, tool results), `🟢 Low` (minor details). Our Observer should use the same levels but weight toward system/infrastructure observations.

- **Temporal anchoring** (lines ~130-180, `CURRENT_OBSERVER_EXTRACTION_INSTRUCTIONS`): Each observation carries two timestamps — when the statement was made and when it references. Pattern: `(09:15) User will visit parents this weekend. (meaning June 17-18, 20XX)`. Adapt for system events: `(14:30) Deployed Caddy config change. (effective after launchctl restart)`

- **Assertions vs questions** (lines ~100-110): User TELLS = 🔴 assertion (authoritative). User ASKS = 🟡 question. In our context: Joel STATES a preference/rule = 🔴, Joel ASKS about an option = 🟡.

- **State change tracking** (lines ~110-125): When something changes, note what replaced what. Pattern: `"User will use the new method (replacing the old approach)"`. Critical for our system: `"Worker now runs from monorepo (replacing standalone ~/Code/system-bus/)"`

- **Output format** (lines ~290-340, `OBSERVER_OUTPUT_FORMAT_BASE`): Three XML sections — `<observations>` (date-grouped, timestamped, prioritized), `<current-task>` (primary + secondary), `<suggested-response>` (continuation hint). We use the same structure.

- **`formatMessagesForObserver()`** (lines ~480-530): Serializes messages with timestamps and role labels. Pi's `serializeConversation()` produces a similar format (`[User]:`, `[Assistant]:`, `[Tool result]:`). We'll use pi's serializer directly.

- **`parseObserverOutput()`** (lines ~560-580): XML parsing with fallback to list-item extraction when the LLM doesn't follow format. We need the same resilience.

- **`optimizeObservationsForContext()`** (lines ~630-660): Strips medium/low priority emojis and semantic tags before injection into context. Reduces token usage by keeping only 🔴 markers. Apply this when injecting into session briefing.

### Reflector Agent

**Source**: `packages/memory/src/processors/observational-memory/reflector-agent.ts`

Key patterns to adapt:

- **System prompt** (`buildReflectorSystemPrompt()`, lines ~20-110): The Reflector sees the full Observer extraction instructions so it understands how observations were created. It then condenses them: "re-organize and streamline... draw connections and conclusions." This two-prompt pattern (teach the reflector HOW observations were made, then ask it to condense) is key to quality.

- **Compression guidance** (lines ~115-160, `COMPRESSION_GUIDANCE`): Three levels — `0` (no guidance, first attempt), `1` (gentle: "aim for 8/10 detail"), `2` (aggressive: "aim for 6/10 detail"). Applied on retry when output ≥ input size. Pattern: try level 0, if `validateCompression()` fails try level 1, then level 2.

- **`validateCompression()`** (lines ~230-235): Simple check: `reflectedTokens < targetThreshold`. If the Reflector output is larger than input, it failed. Retry with next compression level.

- **Temporal preservation** (lines ~65-70): "Condense older observations more aggressively, retain more detail for recent ones." This gradient is critical — don't flatten everything equally.

- **Assertion precedence** (lines ~75-85): "USER ASSERTIONS TAKE PRECEDENCE... the question doesn't invalidate what they told you." In our context: Joel's stated rules/preferences are authoritative even if a later question seems to revisit them.

### Core Processor

**Source**: `packages/memory/src/processors/observational-memory/observational-memory.ts`

Architectural patterns (we use Inngest instead of their in-process pipeline):

- **Token counting** (uses `TokenCounter` class, lines ~20): They use xxhash for dedup and a token counter for threshold checks. We'll use `estimateTokens()` from pi's compaction utils for consistency.

- **Three-tier context injection** (in `processInput` method): The agent sees `[system prompt] → [observations with continuation hint] → [recent messages]`. Our session-lifecycle extension already does `[system prompt with lifecycle awareness] → [session briefing with MEMORY.md] → [user message]`. Observations would slot into the briefing.

- **Continuation hint** (`OBSERVATION_CONTINUATION_HINT`, lines ~420-430): Injected after observations to prevent the agent from awkwardly acknowledging the memory system. Key phrase: "This message is not from the user... Please continue from where the observations left off. Do not refer to your 'memory observations' directly." Our session-lifecycle awareness prompt already does something similar: "Do NOT tell the user to 'read MEMORY.md first'."

- **Operation mutex** (lines ~45-70, `activeOps` set): Process-level lock to prevent concurrent observation/reflection on the same record. In our Inngest-based design, Inngest's concurrency controls (`concurrency: [{ key: "event.data.date", limit: 1 }]`) replace this.

- **Async buffering** (lines ~480-580): Pre-computes observations in background before threshold hit. We don't need this — Inngest IS our async buffering. The event fires, the function runs whenever the worker picks it up.

## Constraints

- **No Mastra dependency.** Patterns and prompts are adapted, not imported.
- **Observer model must be cheap.** `gemini-2.5-flash` or equivalent. Observation is a background cost, not a user-facing latency hit.
- **Inngest is the execution layer.** No in-process LLM calls from the pi extension. The extension emits events; the worker processes them.
- **`igs send` (joelclaw CLI) is the transport abstraction.** The pi extension shells out to `igs send`, not HTTP POST directly. The CLI owns the Inngest URL and event key. This aligns with ADR-0018's event bridge principle while keeping the extension transport-agnostic.
- **Redis for hot storage, daily logs for cold.** Observations live in Redis for fast aggregation and threshold checking. They're also appended to the daily log for human readability and Vault indexing.
- **MEMORY.md canonical path: `~/.joelclaw/workspace/MEMORY.md`**. This is what the session-lifecycle extension reads (session-lifecycle/index.ts line 31). The Vault project doc (Project 08) references the same path. If this moves later, update both.
- **MEMORY.md remains hand-editable.** The Reflector proposes updates; it doesn't blindly overwrite. Append a `## Reflected Observations` section or merge into existing sections with clear attribution.
- **Pi's `serializeConversation()` is the serializer.** Don't reimplement message formatting. Import from `@mariozechner/pi-coding-agent`.
- **Event names follow ADR-0019.** Factual state descriptors: `memory/session.compaction.pending`, `memory/session.ended`.

## Non-goals

- **Real-time observation** (Mastra's async buffering): Inngest provides async execution. No need for in-process background threads.
- **Multi-thread/resource scope** (Mastra's cross-conversation): All sessions are Joel's. The "resource scope" is effectively `MEMORY.md` itself.
- **Semantic search over observations** (Qdrant): File for later. Keyword search over Redis + daily logs is sufficient for Phase 1.
- **Replacing pi's compaction.** Compaction continues as-is. Observations are a parallel output, not a replacement.

## Considered Alternatives

### Alternative A: Enhance pi compaction with custom summary (via `session_before_compact` return)

The pi extension can provide a fully custom compaction summary by returning `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` from the `session_before_compact` handler. This would replace pi's default summary with an observation-enriched one.

**Rejected because:** Compaction serves a different purpose (session continuity for the current model) than observation (long-term memory for future sessions). Coupling them means a regression in compaction quality degrades memory quality. They should be independent pipelines from the same trigger.

### Alternative B: Observer runs inline in pi extension (blocking)

Call the Observer LLM directly from the `session_before_compact` handler before returning.

**Rejected because:** Blocks the compaction. Gemini flash calls take 2-10s. Pi's compaction should not wait for a background memory task. Joel's hard rule: "never block the user for background work."

### Alternative C: Run Observer only on `session_shutdown`

Skip `session_before_compact` entirely. Observe the full session at shutdown.

**Rejected because:** Long sessions that hit compaction 2+ times would have their early context already summarized by the time shutdown fires. The most token-rich, nuance-dense messages are the ones about to be compacted — that's exactly when the Observer should run.

## Consequences

### Positive

- **Knowledge compounds.** Every session ≥5 messages produces structured observations. Over days/weeks, the Reflector distills these into curated memory that improves every future session.
- **Compaction no longer loses nuance.** The Observer extracts key insights before pi's compaction summarizes them away. Two independent preservation paths from the same messages.
- **MEMORY.md gets automated input.** Reflections feed into MEMORY.md, reducing the manual curation burden that ADR-0014 identified as a gap.
- **Observable pipeline.** Inngest provides full run history, retries, and tracing for every observation and reflection. No silent failures.

### Negative

- **LLM cost per session.** Every compaction event and every ≥5-message session triggers a gemini-2.5-flash call. At current pricing (~$0.01-0.03 per observation), this is <$1/day at 20+ sessions/day. Monitor via Inngest run history.
- **Redis dependency for hot observations.** If Redis is down, observations can't be stored or aggregated. Mitigation: daily log append is a fallback write path.
- **Reflection quality is model-dependent.** The Reflector must compress without losing signal. Mastra found Claude 4.5 doesn't work well as reflector. Test with gemini-2.5-flash first; fall back to deepseek-reasoner if quality is insufficient.

### Follow-up tasks

1. Add `memory/session.compaction.pending` and `memory/session.ended` event types to `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` (full typed schema in Event Schema section)
2. Create `observe.ts`, `observe-prompt.ts`, `observe-parser.ts` in `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/`
3. Register observe function in `functions/index.ts` and `serve.ts` (both export array and health endpoint)
4. Create `memory/reflect` Inngest function in `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/reflect.ts` (Phase 2)
5. Update session-lifecycle extension in `~/Code/joelhooks/pi-tools/session-lifecycle/index.ts` to serialize messages and shell out to `igs send`
6. Write Observer system prompt (see Story 3 for full prompt text)
7. Write Reflector system prompt with compression guidance (Phase 2)
8. Update ADR-0014 status to `accepted` and link to this ADR for the compaction/observation/reflection implementation
9. Update Project 08 (memory system) index to reflect observation layer implementation
10. Add `memory:observations:{date}` and `memory:observe:lock:{key}` Redis key patterns to system documentation
11. Write unit tests: `observe-parser.test.ts`, dedupe key generation, compression validation
12. Run golden input/output test with 3 real session transcripts before deploying Observer

## Implementation Plan

### Phase 1: Observer Pipeline (target: first working observation)

**Affected paths:**
- `~/Code/joelhooks/pi-tools/session-lifecycle/index.ts` — add event emission via `igs send`
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` — add event types
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe.ts` — new file
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/index.ts` — register export
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts` — add to serve handler + health list (line ~24, ~55)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-prompt.ts` — Observer system prompt
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/observe-parser.ts` — XML output parser

**Story 1: Event types and Observer function**
- Add `memory/session.compaction.pending` and `memory/session.ended` event types to client.ts (full schema in Event Schema section above)
- Create observe.ts with the Inngest function:
  - Triggered by `memory/session.compaction.pending` OR `memory/session.ended`
  - Step 1: Dedupe check — `SETNX memory:observe:lock:{event.data.dedupeKey}` with `EX 3600`. If key exists, return `{ status: "skipped", reason: "duplicate" }`.
  - Step 2: Call Observer LLM (gemini-2.5-flash via Google AI SDK)
  - Step 3: Parse XML output via observe-parser.ts
  - Step 4: Store in Redis — `RPUSH memory:observations:YYYY-MM-DD` with JSON `{ dedupeKey, sessionId, trigger, observations, currentTask, suggestedResponse, timestamp }`
  - Step 5: Append to daily log `~/.joelclaw/workspace/memory/YYYY-MM-DD.md`
  - Step 6: Check token count — `LRANGE memory:observations:YYYY-MM-DD 0 -1`, sum tokens. If > 40k, emit `memory/observations.accumulated`.
- Concurrency: `{ key: "event.data.sessionId", limit: 1 }`
- Export from functions/index.ts, register in serve.ts

**Story 2: Pi extension event emission**
- In `session_before_compact` handler:
  - Import `serializeConversation` from `@mariozechner/pi-coding-agent`
  - Serialize `preparation.messagesToSummarize` to text
  - Compute dedupeKey: `sha256(sessionId + firstMessageId + "compaction")`
  - Shell out: `igs send "memory/session.compaction.pending" --data '${JSON.stringify(payload)}'`
  - Fire-and-forget (don't await, use `exec` not `execSync`)
  - Continue with existing metadata flush
- In `session_shutdown` handler:
  - Count user messages from session entries
  - If `userMessageCount >= 5`:
    - Get entries via `ctx.sessionManager.getBranch()`
    - Serialize to text via `serializeConversation()`
    - Compute dedupeKey: `sha256(sessionId + "shutdown")`
    - Shell out: `igs send "memory/session.ended" --data '${JSON.stringify(payload)}'`
  - Continue with existing auto-name + handoff

**Story 3: Observer prompt and parser**

Observer system prompt (`observe-prompt.ts`) — adapted from Mastra's `CURRENT_OBSERVER_EXTRACTION_INSTRUCTIONS` for system-engineering context:

```typescript
// observe-prompt.ts
export const OBSERVER_SYSTEM_PROMPT = `You are an observation engine for a personal AI system operated by Joel Hooks.
Your job: extract structured observations from agent session transcripts.

## What to Observe

### 🔴 High Priority (user facts, hard rules, decisions)
- Joel states a preference, rule, or constraint ("always use...", "never do...", "I prefer...")
- Architecture decisions and their rationale
- Debugging root causes (what broke, why, the fix)
- Service/tool state changes (installed, removed, reconfigured)
- Corrections: Joel corrects the agent's understanding

### 🟡 Medium Priority (working context)
- Files modified and why
- Tool configurations and commands run
- Project progress (tasks completed, status changes)
- Patterns discovered (things that worked/didn't)

### 🟢 Low Priority (minor details)
- Questions asked but not definitively answered
- Speculative observations ("might want to...")
- Routine operations without novel insight

## Observation Rules
1. TEMPORAL ANCHORING: Every observation includes when it happened: "(09:15) ..."
2. ASSERTIONS > QUESTIONS: When Joel STATES something, it's 🔴 authoritative. When Joel ASKS, it's 🟡. A question does NOT invalidate a prior assertion.
3. STATE CHANGES: Note what replaced what: "Worker now runs from monorepo (replacing standalone ~/Code/system-bus/)"
4. PRESERVE SPECIFICS: Keep exact paths, versions, error messages, config values. Never generalize "/some/path" — keep "~/Code/joelhooks/joelclaw".
5. QUOTE UNUSUAL PHRASING: If Joel says something distinctive, quote it: Joel stated "slog is for infra changes only, not code edits"
6. NO HALLUCINATION: Only observe what's in the transcript. If uncertain, mark with 🟢 and note uncertainty.

## Output Format

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
{If the session was interrupted by compaction, how should the agent continue? Otherwise "Session completed normally."}
</suggested-response>
`;

export const OBSERVER_USER_PROMPT = (messages: string, trigger: string) =>
  `Extract observations from this ${trigger === "compaction" ? "pre-compaction" : "session"} transcript:\n\n${messages}`;
```

Parser (`observe-parser.ts`):
```typescript
// observe-parser.ts — resilient XML parser with list-item fallback
// Pattern from Mastra's parseObserverOutput() (observer-agent.ts lines ~560-580)
export function parseObserverOutput(raw: string): {
  observations: string;       // raw observation text (date-grouped, prioritized)
  currentTask: string | null; // primary + secondary
  suggestedResponse: string | null;
  parsed: boolean;            // false if fell back to list-item extraction
} {
  // Try XML extraction first
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

  // Fallback: extract any lines starting with emoji priority markers
  const lines = raw.split("\n").filter(l => /^\s*\*?\s*[🔴🟡🟢]/.test(l));
  return {
    observations: lines.join("\n") || raw,  // worst case: return raw output
    currentTask: null,
    suggestedResponse: null,
    parsed: false,
  };
}
```

**Test strategy for Phase 1:**
- Unit test: `observe-parser.test.ts` — XML extraction, fallback to list items, malformed output, empty input
- Unit test: dedupe key generation — deterministic, collision-free
- Integration test: emit event → observe function runs → Redis has observation → daily log has entry
- Failure path test: Redis down → daily log append still works (fallback write path)
- Failure path test: LLM returns malformed output → parser fallback works → observation still stored
- Golden input/output: serialize 3 real session transcripts, run through Observer prompt manually, verify output quality before deploying
- Structural: `bunx tsc --noEmit` in system-bus package confirms type-safe event schemas

### Phase 2: Reflector Pipeline (target: automated MEMORY.md updates)

**Affected paths:**
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/reflect.ts` — new file
- `~/.joelclaw/workspace/MEMORY.md` — automated updates

**Story 4: Reflector function**
- Create reflect.ts with the Inngest function:
  - Triggered by `memory/observations.accumulated` (when daily observation tokens > 40k)
  - Also triggerable by cron (`0 6 * * *` — daily at 6 AM) for end-of-day reflection
  - Loads all observations from Redis for the period
  - Calls Reflector LLM with compression guidance
  - Validates compression (output < input)
  - Retries with escalating compression levels (0 → 1 → 2) per Mastra's `COMPRESSION_GUIDANCE`
  - Appends reflected observations to MEMORY.md under appropriate sections
  - Archives raw observations in daily log with `### 🔭 Reflected` marker

**Story 5: MEMORY.md integration**
- Reflector output maps to MEMORY.md sections:
  - 🔴 user preferences/rules → `## Joel` and `## Hard Rules`
  - 🔴 architecture decisions → `## System Architecture`
  - 🔴 debugging insights → `## Patterns`
  - Observations that don't fit existing sections → new `## Reflected (YYYY-MM-DD)` section
- Dedup: check if observation already exists in MEMORY.md (simple substring match)
- Never delete existing MEMORY.md content — only append or merge

### Phase 3: Session Briefing Integration (target: observations in context)

**Affected paths:**
- `~/Code/joelhooks/pi-tools/session-lifecycle/index.ts` — inject observations into briefing

**Story 6: Inject recent observations into session briefing**
- In `before_agent_start` (first turn):
  - Read recent observations from Redis (`LRANGE memory:observations:YYYY-MM-DD 0 -1`)
  - If observations exist, add `## Recent Observations` section to briefing
  - Apply `optimizeObservationsForContext()` pattern: strip 🟡/🟢 emojis, keep only 🔴 for context efficiency
  - Include `<current-task>` and `<suggested-response>` from most recent observation
- Token budget: observations section capped at ~2k tokens in briefing

## Verification Criteria

### Phase 1 (Observer — must pass before shipping)
- [ ] `bunx tsc --noEmit` passes in system-bus with new event types
- [ ] `observe-parser.test.ts` passes: XML extraction, list-item fallback, malformed input, empty input
- [ ] `memory/session.compaction.pending` event appears in Inngest dashboard when pi compacts
- [ ] `memory/session.ended` event appears when session shuts down with ≥5 user messages
- [ ] Events do NOT fire for sessions with <5 user messages
- [ ] Dedupe works: same session compaction + shutdown → only one observation stored
- [ ] Observer function produces `<observations>` with 🔴/🟡/🟢 markers and timestamps
- [ ] Observations stored in Redis: `LRANGE memory:observations:YYYY-MM-DD 0 -1` returns entries
- [ ] Observations appended to daily log: `~/.joelclaw/workspace/memory/YYYY-MM-DD.md` has `### 🔭 Observations` section
- [ ] No blocking: pi compaction completes in normal time (events are fire-and-forget via `exec`)
- [ ] Full pipeline observable in Inngest dashboard (event received → observe function completed)
- [ ] When Redis is down: function retries via Inngest (not silent failure)
- [ ] Golden test: 3 real session transcripts produce reasonable observations (manual review)

### Phase 2 (Reflector — verified separately)
- [ ] Reflector produces output smaller than input (compression validation)
- [ ] Retry with escalating compression guidance works (level 0 → 1 → 2)
- [ ] MEMORY.md updated with reflected observations under appropriate sections
- [ ] Existing MEMORY.md content is never deleted

### Phase 3 (Briefing — verified separately)
- [ ] Session briefing includes recent observations when available
- [ ] Observation injection stays within ~2k token budget
- [ ] Only 🔴 markers shown in briefing (🟡/🟢 stripped)

## More Information

### Mastra OM License

Mastra is MIT licensed. The Observer/Reflector prompt patterns, output format, and architectural concepts are adapted for this system's context (system engineering on a personal Mac Mini vs consumer chatbot). No code is directly copied; prompts are rewritten for the infrastructure/coding domain.

### Related ADR Updates

- **ADR-0014** (agent memory workspace): This ADR implements Stories B (pre-compaction flush — enhanced with observation extraction), C (compaction pipeline — Observer + Reflector), and partially D (search — Redis keyword lookup over observations). Update ADR-0014 status to `accepted` with link to this ADR.
- **ADR-0018** (pi-native gateway): The session-lifecycle extension is the Phase 1 implementation of ADR-0018's "pi extension as event emitter" pattern. Observation events are the first concrete events flowing through the Redis event bridge.

### Project 08 Update

The memory system project should be updated to reflect:
- Layer 1 (session recall) now has a concrete implementation path via the Observer
- Layer 2 (narrative history) partially addressed by the Reflector's temporal condensation
- Layer 3 (playbook/learned patterns) is the Reflector's output → MEMORY.md
- Priority 0-2 items from the implementation plan are addressed by this ADR
