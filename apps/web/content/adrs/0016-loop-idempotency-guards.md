---
status: shipped
date: 2026-02-14
implemented: 2026-02-15
decision-makers: Joel Hooks
---

# ADR-0016: Idempotency Guards for Loop Event Chain

## Context and Problem Statement

The agent loop event chain (ADR-0015) has no protection against parallel execution. Duplicate `agent/loop.start` events — from accidental double-fires, CLI retries, or stale Inngest replays — create two independent chains that race against the same git branch and Redis PRD.

**Observed live** in `loop-tdd-v1`: Chain A reached LOOP-3 review while Chain B was still writing LOOP-3 tests. Neither chain knew the other existed. They shared the same Redis PRD key, same git branch, same working directory.

### Root causes (5 gaps)

1. **No atomic story claim.** `plan.ts` does read-filter-dispatch with no lock. Two plan functions read "pending" simultaneously and both dispatch the same story.
2. **`seedPrd()` clobbers on duplicate start.** A second `agent/loop.start` for the same loopId unconditionally overwrites Redis from disk, destroying passed/skipped state from the first chain.
3. **No ownership token.** Story status has no `claimedBy` field — an `in_progress` status alone is ambiguous (which chain owns it?).
4. **Entry-only guards are insufficient.** `implement.ts` has a `commitExists()` check, but side effects (tool spawn, git commit, event emit) can still land after a parallel chain already passed the story.
5. **Review/judge diff from HEAD, not commitSha.** Under parallel chains, the reviewer can evaluate the wrong commit.

## Decision

Add a Redis lease-based idempotency system with guards at every side-effect boundary. Two layers:

### Layer 1: Atomic story claim via Redis lease

A separate Redis key per story acts as an exclusive lease:

```
agent-loop:claim:{loopId}:{storyId} = {runToken}
```

Set with `SET NX EX` (atomic create-if-not-exists with TTL). The `runToken` is the Inngest run ID or a generated ULID — it acts as a fencing token. Only the holder of the matching token may proceed.

- **TTL**: 30 minutes (longer than any single step). Renewed by each step in the chain.
- **Crash recovery**: If the claiming chain dies, the lease expires. A parallel or retried chain can then claim.
- **No PRD schema change required** for the claim itself — the lease is a separate key, not embedded in the PRD JSON.

### Layer 2: Guard at every side-effect boundary

A shared `guardStory(loopId, storyId, runToken)` helper, called:

- **Before dispatching** (plan.ts) — `claimStory()` via SETNX. Bail if already claimed.
- **Before spawning tool** (test-writer.ts, implement.ts) — verify lease is still ours. Bail if stolen or story already passed.
- **Before committing** (implement.ts) — re-verify lease. Prevents late commits after parallel pass.
- **Before emitting next event** (all functions) — re-verify lease. Prevents orphaned chain from spawning downstream work.
- **Before writing verdict** (judge.ts) — re-verify lease and use compare-and-set on the story status.

Each guard reads the PRD from Redis to check `passes` status AND verifies the lease key matches our token. If either check fails, return `{ status: "already_claimed" | "already_passed" | "lease_expired" }` and stop.

### Layer 3: Start deduplication

`seedPrd()` must not clobber existing state. On `agent/loop.start`:

```typescript
// Only seed if key doesn't exist
const didSet = await redis.set(prdKey(loopId), json, "NX", "EX", 7 * 24 * 60 * 60);
if (!didSet) {
  // PRD already seeded — this is a duplicate start. Read existing.
  return readPrd(project, prdPath, loopId);
}
```

### Non-goals

- **Full distributed locking** — overkill for single-machine. Redis SETNX is sufficient.
- **Event deduplication at Inngest level** — would require Inngest config changes; the data-layer guard is more reliable.
- **Preventing duplicate CLI fires** — that's a UX guard in `igs loop start`, orthogonal to this ADR.

## Consequences

* Good, because parallel chains bail early instead of silently colliding
* Good, because lease TTL handles crash recovery without manual cleanup
* Good, because `seedPrd` NX prevents the most dangerous failure (state clobber)
* Good, because fencing token distinguishes "my in_progress" from "someone else's in_progress"
* Bad, because every function needs guard calls at 2-3 points — boilerplate risk
* Bad, because 30-minute lease TTL is a guess; too short = premature expiry during slow codex runs, too long = blocked retries after crash
* Neutral: the `commitSha`-based diff fix (review/judge should diff the emitted sha, not HEAD) is related but can ship independently

## Implementation Plan

* **Affected paths**: `utils.ts` (new helpers), `plan.ts`, `test-writer.ts`, `implement.ts`, `review.ts`, `judge.ts`
* **Dependencies**: None new — uses existing `ioredis` client
* **Patterns to follow**: Existing `isCancelled()` check pattern — guards are early-return checks at the top of steps
* **Patterns to avoid**: Don't embed claim state in the PRD JSON — keep it as a separate Redis key. Don't copy-paste guard logic into each function — use the shared helper.

### New helpers in `utils.ts`

```typescript
// Atomic claim — returns token if claimed, null if already claimed
async function claimStory(loopId: string, storyId: string, runToken: string): Promise<string | null>

// Verify we still hold the lease and story isn't passed
async function guardStory(loopId: string, storyId: string, runToken: string): Promise<
  { ok: true } | { ok: false; reason: "already_claimed" | "already_passed" | "lease_expired" }
>

// Renew lease TTL (call from each step to prevent expiry during long runs)
async function renewLease(loopId: string, storyId: string, runToken: string): Promise<boolean>

// Release lease (call on story pass/skip)
async function releaseClaim(loopId: string, storyId: string): Promise<void>
```

### Redis key schema

```
agent-loop:claim:{loopId}:{storyId}  →  {runToken}   NX EX 1800
agent-loop:prd:{loopId}              →  {PRD JSON}    EX 604800  (existing, add NX to seedPrd)
```

### Verification

- [ ] Fire two `agent/loop.start` events for same loopId — only one chain executes each story
- [ ] Second chain returns `{ status: "already_claimed" }` at plan step
- [ ] Duplicate `agent/loop.start` does not clobber existing PRD state in Redis
- [ ] Kill a claiming chain mid-implement — lease expires after TTL, retry chain can claim
- [ ] Review/judge use emitted `commitSha` for diff, not `HEAD~1..HEAD`
- [ ] `guardStory` prevents late commit after parallel chain passes the story
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`

## Alternatives Considered

* **Status field in PRD only** (`in_progress` enum): Race-prone — PRD read-modify-write is not atomic. Two chains read "pending" simultaneously and both write "in_progress". No fencing token to distinguish owners.
* **Inngest concurrency keys**: Already set per-function (`key: event.data.project, limit: 1`), but this only serializes within a single function type. Cross-function overlap still happens — plan for story N+1 can run while review for story N is still in flight. Doesn't prevent parallel chains.
* **Guard at entry only**: Insufficient. `implement.ts` can spawn a tool, run for 10 minutes, then commit — but during those 10 minutes the parallel chain already passed the story. Need guards at side-effect boundaries, not just entry.

## More Information

- [ADR-0005](0005-durable-multi-agent-coding-loops.md) — original loop architecture
- [ADR-0011](0011-redis-backed-loop-state.md) — Redis-backed PRD state (this ADR extends the Redis key schema)
- [ADR-0015](0015-loop-architecture-tdd-roles.md) — TDD role separation (the event chain this guards)
- Codex review identified: `seedPrd` clobber risk, need for fencing token, HEAD-based diff vulnerability, and recommended lease-based approach over PRD status enum
- `commitSha` diff fix for review/judge can ship as a separate PR — it's good hygiene regardless of idempotency
