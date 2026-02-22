---
status: implemented
date: 2026-02-16
---

# ADR-0028: Align Inngest Rig with SDK Best Practices

## Context

Installed the official [Inngest agent skills](https://github.com/inngest/inngest-skills) into joelclaw:

```bash
cd ~/Code/joelhooks/joelclaw
npx skills add inngest/inngest-skills --yes
```

Six skills covering setup, events, durable functions, steps, flow control, and middleware. Reviewed the entire system-bus worker (14 functions, ~7200 lines, inngest@3.52.0) against these skills. The rig works — loops complete end-to-end, pipelines chain correctly, events are typed. But the review surfaced patterns where we're working around the SDK instead of using it.

Related: ADR-0005 (adopted Inngest), ADR-0019 (event naming — already aligned).

## Decision

Fix the gaps the skills identified. Ordered by impact.

### 1. Replace `inngest.send()` with `step.sendEvent()` inside functions

Every function wraps `inngest.send()` inside a `step.run()`:

```typescript
// Current — 14 call sites across all functions
await step.run("emit-events", async () => {
  await inngest.send({ name: "pipeline/transcript.requested", data: {...} });
});
```

The inngest-steps skill says: use `step.sendEvent()` instead of `inngest.send()` in functions. `step.sendEvent()` is the durable primitive — memoized as part of the step DAG, one fewer HTTP round-trip per emit. The `step.run()` wrapper is a workaround that mostly works (step memoization protects against re-sends on replay), but it's not what the SDK is designed for.

Replace all 14 sites:

```typescript
// After
await step.sendEvent("emit-events", {
  name: "pipeline/transcript.requested",
  data: {...}
});
```

For batch sends (video-download, transcript-process), `step.sendEvent()` accepts an array.

### 2. Use `NonRetriableError` for validation failures

Zero usage of `NonRetriableError` anywhere. Several functions throw plain `Error` for conditions that won't fix themselves on retry:

| Function | Error | Why non-retriable |
|----------|-------|--------------------|
| `observe.ts` | "Missing required session field" | Input validation — event payload is malformed |
| `transcript-process.ts` | "requires either audioPath or text" | Schema violation |
| `plan.ts` | "Worktree missing" | Infrastructure state — worktree was cleaned |
| `plan.ts` | "Generated PRD has no stories" | LLM output issue — same prompt likely same result |
| `video-download.ts` | "No .info.json found" | Download produced nothing usable |

These burn through all retry attempts, delay the next story in a loop, and waste compute. Import from `"inngest"` and throw for non-transient failures.

### 3. Add `cancelOn` to agent loop functions

Currently, loop functions poll `isCancelled(loopId)` by checking a flag file on disk at explicit checkpoints:

```typescript
const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
if (cancelled) return { status: "cancelled", loopId };
```

The inngest-durable-functions skill documents native cancellation:

```typescript
cancelOn: [{
  event: "agent/loop.cancelled",
  if: "event.data.loopId == async.data.loopId"
}]
```

This cancels running functions immediately when the cancel event fires instead of waiting for the next poll. A function in a 5-minute `step.run()` (implement.ts spawning codex) won't see the poll-based cancel until that step finishes. Add `cancelOn` to: `plan`, `test-writer`, `implement`, `review`, `judge`, `complete`, `retro`.

The `isCancelled()` polling can stay as a belt-and-suspenders check inside long steps, but Inngest-native cancellation should be the primary mechanism.

### 4. Add `step.run()` to `systemLogger`

The function does file I/O with no steps at all — reads and writes `system-log.jsonl` directly in the handler. If the write fails, the entire function retries from scratch with no memoization. Wrap in a single `step.run("write-log", ...)`.

### 5. Consolidate duplicate schema fields

`memory/observations.accumulated` has both `session_id`/`sessionId` and `observation_count`/`observationCount`. Pick camelCase (matches the rest of the codebase) and drop the snake_case duplicates. One migration: update any Redis consumers reading the old keys.

### 6. Extract shared Redis module

Both `observe.ts` and `agent-loop/utils.ts` maintain separate `getRedisClient()`/`getRedis()` singletons. Extract to `src/inngest/redis.ts`.

### 7. Externalize `serveHost`

```typescript
// Current
serveHost: "http://host.docker.internal:3111",

// After
serveHost: process.env.INNGEST_SERVE_HOST ?? "http://host.docker.internal:3111",
```

Matters when the Pi joins the cluster — worker won't always be on the Docker host.

### 8. Clean up dead event

`pipeline/video.ingested` is registered in Events and systemLogger's trigger list but nothing produces it. Remove.

## What's Already Right

The skills confirmed several patterns are correct:

- **Event naming** follows Object-Action past-tense (`pipeline/video.requested`, `agent/loop.story.dispatched`). ADR-0019 nailed this.
- **Event schemas** are comprehensive with typed data payloads via `EventSchemas().fromRecord<Events>()`.
- **Side effects live inside steps** — no naked I/O outside `step.run()` (except systemLogger).
- **Concurrency limits** protect external resources: video-download (1), transcript-process (1), content-sync (1 keyed), plan (1 per project).
- **Fan-out event chains** are the right pattern — functions emit events, don't call each other.
- **Hono serve at `/api/inngest`** matches the skill's recommended endpoint path.

## Not Now

- **Middleware** (logging, metrics, error tracking) — valuable but not blocking. The systemLogger fan-out pattern covers pipeline completion events. Add middleware when we have enough functions that per-step debugging becomes painful. The inngest-middleware skill has the patterns ready.
- **Event `id` for deduplication** — the Redis NX lock in observe.ts works. Pipeline events (video, transcript) have natural idempotency from slug uniqueness. Could add `id` fields later for belt-and-suspenders.
- **Event schema `v` field** — single-consumer system, not worth the overhead yet.
- **Splitting content-sync into per-directory steps** — only two directories today. Split when a third arrives.

## Consequences

- All event emission inside functions becomes durable via `step.sendEvent()`
- Validation errors stop burning retries
- Loop cancellation becomes responsive instead of polled
- Shared Redis module reduces drift between observe and agent-loop
- `serveHost` env var unblocks multi-machine deployment (ADR-0025)

## Verification

- [x] `grep -r "inngest.send" src/inngest/functions/ --include="*.ts" | grep -v test` returns 0 matches
- [x] `grep -r "NonRetriableError" src/inngest/functions/ --include="*.ts"` returns matches in observe, transcript-process, plan, video-download
- [x] `grep -r "cancelOn" src/inngest/functions/agent-loop/ --include="*.ts"` returns matches in all 7 loop functions
- [x] `systemLogger` function body contains `step.run`
- [x] `pipeline/video.ingested` removed from Events type and systemLogger triggers
- [x] `bunx tsc --noEmit` passes
- [ ] `bun test` passes (full suite currently has unrelated pre-existing failures; ADR-critical tests pass as of last targeted run)
