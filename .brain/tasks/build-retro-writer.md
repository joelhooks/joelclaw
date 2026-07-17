# Build the retro writer: hook-fired Inngest event → condenser → retro .svx

Read first: `.brain/projects/memory-system-cleanup/build-retro-writer.svx`
(your step file — you own it) and the decision
`.brain/projects/memory-system-repair/decide-retro-writer.svx`.

## Task (in ~/Code/joelhooks/joelclaw)

1. **Event + function**: new Inngest function `memory-retro-writer` on
   event `memory/retro.requested` with data `{ brief_path, session_id?,
   repo?, requested_by? }`. It reads the closed brief + its step files'
   Result sections (resolve relative step links from the brief's
   decision ledger), condenses via `pi` inference (repo rule: use pi,
   no paid API keys — follow an existing function's inference pattern),
   and writes one retro `.svx` to
   `~/Code/joelhooks/dark-wizard/.brain/resources/retros/<slug>-<yyyy-mm>.svx`.
2. **Noise bar enforced in the prompt + a guard**: skip (with an OTel
   warn) if the brief has fewer than 3 steps AND no decision ledger
   entries. The retro must say what changed durable behavior — not
   re-narrate the ledger. Template: frontmatter (title, type
   "resource", created_at, privacy private) + sections: What happened /
   What it means / What changed durable behavior / Receipts (links).
3. **Fire surface**: add `joelclaw retro <brief-path>` CLI command that
   sends the event (agents and hooks call this one-liner at effort
   close).
4. **Proof**: dry-run the condenser path with
   `.brain/projects/memory-system-review/memory-system-review-brief.svx`
   as input — write the generated retro to a scratch path, do NOT
   deliver to the retros store; include the generated text in your step
   file Result for steering review.

## Rules

- Do NOT touch `packages/system-bus/src/inngest/functions/memory/run-captured.ts`
  (another worker owns it).
- Do NOT commit, restart services, or write into
  dark-wizard/.brain/resources/retros/ (scratch output only this pass).
- Gates: `bunx tsc --noEmit`; focused biome on changed files; tests for
  the guard logic if a test pattern exists nearby.
- Record results in your step file. Print a DONE summary with the
  steering deploy sequence.
