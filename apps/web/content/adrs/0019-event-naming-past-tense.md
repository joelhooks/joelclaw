---
status: implemented
date: 2026-02-15
decision-makers: Joel
---

# Rename events from imperative commands to past-tense notifications

## Context and Problem Statement

The system-bus event names are a mix of two styles:

**Imperative/RPC ("do this")**: `agent/loop.implement`, `agent/loop.review`, `pipeline/video.download`, `content/summarize`

**Past-tense/notification ("this happened")**: `agent/loop.story.passed`, `pipeline/video.downloaded`, `content/summarized`

The pipeline events already follow both patterns — a command triggers work, a notification announces completion. But the agent loop chain uses only imperative names: `plan` → `test` → `implement` → `review` → `judge`. These read as commands to a subordinate rather than facts about what occurred.

Events should describe what happened, not issue orders. This is a core event-driven architecture principle: the emitter announces a fact, and any number of consumers can react to it. RPC-style names couple the emitter to the consumer — "implement" implies a specific handler must exist. Past-tense names decouple: "tests.written" is a fact that implement, metrics, logging, or a dashboard could all independently consume.

The pipeline already proved this: `pipeline/video.downloaded` triggers both `transcript.process` AND `system/log` — multiple consumers of one fact. The agent loop should follow the same pattern.

Related: ADR-0015 (TDD loop architecture), ADR-0005 (durable multi-agent coding loops).

## Decision

Rename all imperative event names to past-tense notification style. The emitter describes what just completed; the next function triggers on that fact.

### Current → New mapping

| Current (imperative) | New (past-tense) | Emitted by | Consumed by |
|---|---|---|---|
| `agent/loop.start` | `agent/loop.started` | igs CLI | plan |
| `agent/loop.plan` | `agent/loop.planned` | judge (next story) | plan (re-entry) |
| `agent/loop.test` | `agent/loop.tests.written` | plan (dispatch) | test-writer |
| `agent/loop.implement` | `agent/loop.implemented` | test-writer, judge (retry) | implement |
| `agent/loop.review` | `agent/loop.reviewed` | implement | review |
| `agent/loop.judge` | `agent/loop.judged` | review | judge |
| `agent/loop.complete` | `agent/loop.completed` | plan (all done) | complete, retro |
| `agent/loop.cancel` | `agent/loop.cancelled` | igs CLI | all (check step) |
| `pipeline/video.download` | `pipeline/video.requested` | external | video-download |
| `pipeline/video.ingest` | _(remove, legacy alias)_ | — | — |
| `pipeline/transcript.process` | `pipeline/transcript.requested` | video-download | transcript-process |
| `pipeline/book.download` | `pipeline/book.requested` | external | book-download |
| `content/summarize` | `content/summarize.requested` | transcript-process | summarize |
| `system/log` | `system/log.written` | any | system-logger |

**Wait — that's wrong for the chain.**

The chain events describe what JUST HAPPENED, and the next function triggers on that fact:

| Fact (new event name) | What happened | Who triggers on it |
|---|---|---|
| `agent/loop.started` | CLI started a loop | planner |
| `agent/loop.story.dispatched` | planner picked next story | test-writer |
| `agent/loop.tests.written` | test-writer committed tests | implementor |
| `agent/loop.code.committed` | implementor committed code | reviewer |
| `agent/loop.checks.completed` | reviewer ran checks + eval | judge |
| `agent/loop.story.passed` | judge approved | planner (next) |
| `agent/loop.story.failed` | judge rejected (max retries) | planner (next) |
| `agent/loop.story.retried` | judge wants retry | implementor |
| `agent/loop.completed` | all stories done | complete, retro |
| `agent/loop.cancelled` | user cancelled | all (check step) |

### Non-goals

- Not renaming pipeline notification events that are already past-tense (`*.downloaded`, `*.processed`, `*.summarized`)
- Not changing Redis key schemas or PRD structure
- Not changing the igs CLI command interface (still `igs loop start`)

## Consequences

- Good, because events read as facts about the system, enabling multiple consumers per event
- Good, because naming is consistent across pipeline and agent-loop subsystems
- Good, because new events like `agent/loop.story.dispatched` are self-documenting — you can read the event stream as a narrative
- Bad, because every emit and every trigger annotation must be updated (coordinated change across 8 files + igs CLI)
- Bad, because Inngest function IDs change if we rename function slugs (need to ensure no in-flight runs)

## Implementation Plan

- **Affected paths**:
  - `src/inngest/functions/agent-loop/plan.ts` — emit names
  - `src/inngest/functions/agent-loop/test-writer.ts` — trigger + emit
  - `src/inngest/functions/agent-loop/implement.ts` — trigger + emit
  - `src/inngest/functions/agent-loop/review.ts` — trigger + emit
  - `src/inngest/functions/agent-loop/judge.ts` — trigger + emit
  - `src/inngest/functions/agent-loop/complete.ts` — trigger
  - `src/inngest/functions/agent-loop/retro.ts` — trigger
  - `src/inngest/functions/agent-loop/utils.ts` — `isCancelled` key check
  - `~/Code/joelhooks/igs/src/commands/loop.ts` — emit `agent/loop.started` and `agent/loop.cancelled`
- **Dependencies**: none
- **Patterns to follow**: pipeline events already use past-tense (`pipeline/video.downloaded`). Match that grammar.
- **Patterns to avoid**: Don't use gerunds (`implementing`, `reviewing`) — use past participles or result nouns (`implemented`, `checks.completed`). Don't rename function IDs (keep `agent-loop-judge` etc.) — only event names change.

### Migration steps

1. Create a constant map of old → new event names in `utils.ts`
2. Update all `inngest.send({ name: ... })` calls in all 7 function files
3. Update all trigger annotations `[{ event: "agent/loop.X" }]`
4. Update `igs` CLI to emit `agent/loop.started` and `agent/loop.cancelled`
5. Update `isCancelled()` to check for new cancel key name
6. Update all tests that reference event names
7. Ensure no in-flight loops before deploying (cancel + nuke)

### Verification

- [ ] `grep -r '"agent/loop\.' src/ | grep -v '\.test\.'` shows only past-tense event names
- [ ] `grep -r '"pipeline/' src/ | grep -v '\.test\.'` shows no imperative names (except legacy aliases if kept)
- [ ] All tests pass: `bun test`
- [ ] TypeScript compiles: `bunx tsc --noEmit`
- [ ] Fire a loop end-to-end and verify all steps execute (plan → test → implement → review → judge → pass)
- [ ] Inngest dashboard shows new event names in run traces

## More Information

- ADR-0015: Loop architecture TDD roles (defines the chain)
- ADR-0005: Durable multi-agent coding loops (original event design)
- Principle: "Events describe what happened, not commands" — Joel's standing rule
