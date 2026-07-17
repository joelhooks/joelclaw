# Build the legacy + system-log retirement migration

Read first: `.brain/projects/memory-system-cleanup/execute-legacy-retirement.svx`
(your step file — you own it), the decisions
`.brain/projects/memory-system-repair/decide-legacy-memory-retirement.svx` and
`.brain/projects/memory-system-repair/decide-system-log-home.svx`, and the
evidence in `.brain/projects/memory-system-review/periphery-survey.svx`.

## Build (in ~/Code/joelhooks/joelclaw)

1. **Retarget `joelclaw recall`** (`packages/cli/src/commands/`) and the
   generic voice recall tool to query the Brain/observation Typesense
   collections instead of `memory_observations`. Match the existing
   result envelope so callers don't break. Same for any voice tool
   reading the stale index.
2. **Archive script** `scripts/archive-memory-observations.ts`: export all
   `memory_observations` docs to a JSONL snapshot with doc count +
   sha256 receipt, targeted at the NAS path used by existing backups
   (see `nas-backup.ts` for conventions). Dry-run by default; `--execute`
   to write; NEVER drops the collection itself — print the exact curl
   for steering to run after verifying the receipt.
3. **Unregister the zombies**: remove the reflect/promote/proposal
   functions (the ones pointed at `~/.joelclaw/workspace/MEMORY.md` —
   memory/reflect, memory/review-promote, memory/proposal-triage, verify
   against the survey) from the function indexes. Delete their source
   files and the MEM/FRIC suites that protect them.
4. **System-log retirement**: remove the slog write path,
   `system-logger.ts` (and `systemId: panda` default), the system-log
   JSONL Typesense sync + NAS backup hooks, and the PDS mirror write.
   Write `scripts/snapshot-panda-system-log.sh` that scp's
   `panda:~/Vault/system/system-log.jsonl` to the NAS archive location
   with a sha256 receipt (do not run it — panda access is steering's).
   Update joelclaw `CLAUDE.md` / `AGENTS.md` references (key-paths table
   lists the system log).

Order matters for reviewability: one coherent change, but keep commits-
worth of separation in your DONE summary (recall retarget / archive
tooling / zombie removal / syslog removal).

## Rules

- Do NOT commit, push, restart services, drop collections, delete NAS
  data, or touch panda. Build + local gates only.
- Do NOT touch `packages/system-bus/src/inngest/functions/memory/run-captured.ts`
  (another worker owns it right now).
- Gates: `bunx tsc --noEmit` from root; `pnpm biome check packages/ apps/`;
  run any test files you touched.
- Record your results in your step file's `## Result` section.
- Print a DONE summary: files changed/deleted, gates, the exact steering
  commands (archive execute, collection drop curl, panda snapshot,
  worker restart).
