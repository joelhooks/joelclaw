# Fleet skills/prompts sweep: no standing rule references the dead

Read first: `.brain/projects/memory-system-cleanup/update-fleet-skills-prompts.svx`
(in ~/Code/joelhooks/joelclaw — your step file, you own it) and the five
decision files in `.brain/projects/memory-system-repair/decide-*.svx`.

## What changed today (document what IS)

- Legacy memory stack RETIRED: `joelclaw recall` now answers from
  Brain/observation stores; `memory_observations` archived+dropped;
  reflect/promote/proposal/batch-review functions and MEM/FRIC suites
  deleted (joelclaw `a673d5c1`).
- System log RETIRED: `slog`/`joelclaw log write` gone, system-logger
  deleted, panda copy archived to NAS. Telemetry = OTel events
  (Typesense/ClickHouse); receipts = Brain `.svx`.
- Chorus/rhizomatic PARKED: no session briefing injection; service stop
  pending steering sudo.
- Claude auto-memory = POINTER INDEX (rule + pointers to ~/.brain).
- Retros: hook-fired Inngest event + condenser (being built now).

## Task

Work in `~/Code/joelhooks/dark-wizard` (primary) and `~/.claude/skills/`:

1. Sweep for live references to: `slog`, `system-log.jsonl`,
   `joelclaw log write`, `memory_observations`, old `joelclaw recall`
   semantics, rhizomatic/Chorus briefings as live, Claude auto-memory
   as a content store. Cover `scripts/fleet/*.block.md`, `TOOLS.md`,
   `STACK.md`, dark-wizard skills, and `~/.claude/skills/*/SKILL.md`
   (flagg-local copies of fleet skills).
2. Update each to current reality or mark clearly historical. Keep
   edits surgical — do not rewrite docs wholesale.
3. Run `~/Code/joelhooks/dark-wizard/scripts/fleet-graft.sh install`
   and verify the graft blocks refresh cleanly (no marker corruption).
4. List every file changed with a one-line why.

## Rules

- Do NOT commit or push (steering commits dark-wizard; fleet doctrine:
  no `git add -A`, no force-push).
- Do NOT edit content outside marker blocks in machine-local prompt
  files; canonical edits go in `scripts/fleet/` sources.
- Other sessions have uncommitted changes in dark-wizard — touch only
  files your sweep requires.
- Record results in your step file. Print a DONE summary.
