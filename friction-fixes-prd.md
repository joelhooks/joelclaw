# Friction Fixes: Daily Log Bloat + Reflect Dedup + Backfill Guards

## Context

A session backfill run on 2026-02-17 at ~06:08 processed hundreds of historical sessions, which caused:
1. **Daily log explosion**: 70k lines / 2.9MB in one day's log (manually cleaned to 660KB)
2. **1,404 duplicate `🔭 Reflected` entries** in the daily log — reflect has no dedup guard
3. **Cascading reflect triggers**: each batch of observations triggered a reflect, each reflect appended to the log

Root causes identified:
- `reflect.ts` appends `### 🔭 Reflected` to the daily log every time it runs, with no dedup. The 6 AM cron + observation threshold trigger can fire multiple times per day.
- `observe.ts` daily log append has no dedup — if the same session is observed twice (e.g., backfill retry), it appends again.
- `backfill-observe.ts` has throttling (sleepSeconds) but each observation triggers reflect's token threshold check, causing a reflect cascade.
- The reflect function loads 7 days of observations, which during backfill means hundreds of observations → huge LLM call → proposals → daily log spam.

Also found during friction audit:
- Qdrant `indexed_vectors_count: 0` was reported as "zero vectors" in ADR-0021 — actually just means HNSW index hasn't built (needs ~20k points). Vectors are real. ADR already corrected.
- Pi sessions at 45MB with no rotation policy.

## Stories

### FRIC-1: Add dedup guard to observe.ts daily log append

**What**: Before appending an observation block to the daily log, check if that session ID + trigger combo already exists in the file.

**Files to modify**:
- `packages/system-bus/src/inngest/functions/observe.ts`

**Changes**:
- In the `append-daily-log` step, before writing:
  - Read the target daily log file
  - Check if a `### 🔭 Observations (session: {sessionId}` line already exists for this trigger
  - If it does, skip the append and return `{ appended: false, reason: "duplicate" }`
  - If it doesn't, append as normal
- This is a simple substring check, not regex — look for `session: {sessionId}` in the existing content

**Acceptance criteria**:
- Running observe twice for the same session+trigger only produces one daily log entry
- `bun test` passes
- `bunx tsc --noEmit` passes

### FRIC-2: Add dedup guard to reflect.ts daily log append

**What**: reflect.ts appends `### 🔭 Reflected` every time it runs. During backfill, this produced 1,404 entries in one day. Add a once-per-day guard.

**Files to modify**:
- `packages/system-bus/src/inngest/functions/reflect.ts`

**Changes**:
- In the `append-daily-log` step, before writing:
  - Read the target daily log file
  - Check if `### 🔭 Reflected` already exists for today's date in the file
  - If it does, skip the append and return `{ appended: false, reason: "already reflected today" }`
  - Alternative: use the existing Redis `memory:reflect:triggered:{date}` SETNX guard (24h TTL) that already exists for the reflect function itself — if that key exists, skip the daily log write too
- The reflect function already has a once-per-day intent — the daily log write should respect it

**Acceptance criteria**:
- Running reflect multiple times on the same day produces at most one `### 🔭 Reflected` entry in the daily log
- `bun test` passes
- `bunx tsc --noEmit` passes

### FRIC-3: Add reflect throttle during backfill

**What**: During backfill, every batch of observations that crosses the 40k token threshold triggers a reflect. This creates a cascade of reflect runs. The backfill should suppress reflect triggers.

**Files to modify**:
- `packages/system-bus/src/inngest/functions/observe.ts`

**Changes**:
- In the `check-threshold` step (step 7), add a check: if `event.data.trigger === "backfill"`, do NOT emit `memory/observations.accumulated` 
- This means backfill observations accumulate in Redis without triggering reflect mid-backfill
- The daily 6 AM reflect cron will pick them up naturally
- Also: add `"backfill"` as a valid trigger value in the event schema types if not already present

**Also modify**:
- `packages/system-bus/src/inngest/functions/backfill-observe.ts`
- Ensure backfill events include `trigger: "backfill"` in the event data (check if this is already the case)

**Acceptance criteria**:
- Backfill observations don't trigger mid-run reflect cascades
- `memory/observations.accumulated` is NOT emitted when trigger is `"backfill"`
- The 6 AM cron still reflects accumulated backfill observations normally
- `bun test` passes
- `bunx tsc --noEmit` passes

### FRIC-4: Add pi session rotation (prune sessions older than 30 days)

**What**: `~/.pi/agent/sessions/` is 45MB and growing. Add a cleanup step to the system heartbeat that prunes session JSONL files older than 30 days.

**Files to modify**:
- `packages/system-bus/src/inngest/functions/heartbeat.ts` (or whichever function runs the system heartbeat cron)

**Check**: First look at how the heartbeat function is structured. The cleanup should be a new step in the existing heartbeat function, NOT a separate function.

**Changes**:
- Add a step `prune-old-sessions` to the heartbeat function
- Find all `.jsonl` files in `~/.pi/agent/sessions/` (recursively)
- Delete any file with mtime older than 30 days
- Log the count of deleted files
- Also prune `~/.claude/debug/` files older than 30 days (currently 526 files)

**Acceptance criteria**:
- Heartbeat prunes sessions older than 30 days
- Count of pruned files logged in step output
- Does NOT delete files newer than 30 days
- `bunx tsc --noEmit` passes

### FRIC-5: Delete stale REVIEW.md file

**What**: `~/.joelclaw/workspace/REVIEW.md` is 19k lines of garbage from the old reflect→REVIEW.md pipeline. The Phase 3 loop is removing REVIEW.md from the code. This story just deletes the file itself. 

NOTE: Only delete this if the Phase 3 loop (loop-mlr8oxtg-b68bp4) has already completed and removed REVIEW.md references from the code. Check `git log --oneline -5` in the monorepo to verify Phase 3 merged. If it hasn't merged yet, skip this story.

**Changes**:
- Delete `~/.joelclaw/workspace/REVIEW.md`
- Verify no active code references it (grep the system-bus source)

**Acceptance criteria**:
- `~/.joelclaw/workspace/REVIEW.md` does not exist
- No runtime code in system-bus references REVIEW.md (test files referencing it are OK)
- `bunx tsc --noEmit` passes
