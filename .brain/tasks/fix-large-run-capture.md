# Fix run-captured for large payloads: stop passing content through step outputs

Read first: `.brain/projects/memory-system-repair/drain-capture-outbox.svx`
(context) — you own only your DONE summary, not that file.

## Problem (hit live 2026-07-17 20:35Z)

`memory-run-captured-v3` fails on large runs: Inngest run
`01KXRWNW7FTQMX3ES89BS6XZGA` (event `01KXRWNW3T7K5YVJN2K6MJJJY1`,
run_id `a24498b9c50348b1998700e2fb`, 4,199,209-byte jsonl) died with
"step output size is greater than the limit" after retries. Cause: the
function returns the full jsonl from the `load-jsonl` step and the full
turns/candidates arrays from the `chunk` step — step outputs are
persisted by Inngest and size-capped. Live turn-end deltas are small;
outbox replays and long sessions are not. 14 of 167 outbox replay
requests are blocked on this.

## Task (in ~/Code/joelhooks/joelclaw)

1. Refactor `packages/system-bus/src/inngest/functions/memory/run-captured.ts`
   so no step output carries transcript-scale content: read from
   `jsonl_path` on disk INSIDE each step that needs it (the file is
   local); if `jsonl_inline` was provided, write it to a temp spool in
   an early small-output step and pass the path. Steps should return
   counts/hashes/ids only. Preserve: idempotent runs_dev upsert
   (including the empty-candidates path added today in `6877dab1`),
   chunk indexing behavior, OTel events, retries/concurrency config.
   Bump the function version comment if you create a new concurrency
   bucket (follow the v3 comment's reasoning).
2. Extend `run-captured.test.ts` with a large-payload case proving no
   step output scales with transcript size (assert on the step return
   shapes, not actual 4MB fixtures).
3. Gates: `bunx tsc --noEmit`; `bun test` the function's test file;
   focused biome on changed files.

## Rules

- Only touch run-captured.ts + its test (+ tiny shared helpers if
  unavoidable — name them in the summary).
- Do NOT commit, restart services, or resend events — steering owns
  deploy, the re-emit of `a24498b9...`, and the drain resume.
- Print a DONE summary: what step outputs contain now, gates, deploy +
  unstick sequence for steering.
