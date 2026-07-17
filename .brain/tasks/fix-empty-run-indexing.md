# Fix: empty-candidate runs must still index their metadata row

## Context

`packages/system-bus/src/inngest/functions/memory/run-captured.ts`
(function `memory-run-captured-v3`) currently short-circuits when
`chunkTurns` produces zero candidates: it emits an OTel warn
(`memory.run.captured.empty`) and returns WITHOUT writing the Run
metadata document to Typesense `runs_dev`.

Consequence (hit live 2026-07-17 19:31Z): the capture-outbox replay tool
(`scripts/replay-capture-outbox.ts`) verifies success by polling
`runs_dev` for the run's document with matching `jsonl_sha256`. An
empty-but-valid payload (e.g. a trimmed prefix-suffix from the outbox
disposition, or an old-format fragment with no extractable turns) is
accepted with 202, runs the function, indexes nothing, and the replay
tool times out and halts the drain. Receipt: Inngest event
`01KXRRZ96MW7F4MJXNDNMHY5VN` → run `01KXRRZ9BM0JN3VXY71B0Z6RNN`,
output `{"chunks_indexed":0,"reason":"empty","run_id":"4b275d0b36734a009b7abdcfe7"}`.

## Task

1. In `run-captured.ts`, make the empty-candidates path still upsert the
   Run metadata document into `RUNS_COLLECTION` (`runs_dev`) exactly as
   the non-empty path does (same fields: run_id, user_id, machine_id,
   agent_runtime, jsonl_path/bytes/sha256, started_at, parent/
   conversation ids, tags, format), with whatever chunk-count field the
   schema carries set to 0. Keep the OTel warn. Reuse the existing doc-
   write code — factor it out rather than duplicating it.
2. Check `packages/memory/src/schemas/runs.ts` for required fields so
   the 0-chunk doc validates.
3. Tests: if a test file covers run-captured or the runs schema, extend
   it with the empty-payload case (metadata doc written, zero chunks).
   If none exists, add a focused unit test only if it fits the existing
   test layout under packages/system-bus — do not build new test infra.
4. Gates: `bunx tsc --noEmit` from repo root must pass; run the test
   file(s) you touched with `bun test <path>`.

## Rules

- Work ONLY in `~/Code/joelhooks/joelclaw`.
- Do NOT commit, push, restart services, or touch `~/.joelclaw`.
- Do NOT modify `scripts/replay-capture-outbox.ts` — the fix is
  pipeline-side by decision.
- Print a DONE summary: files changed, gate results, anything you
  noticed but did not touch.
