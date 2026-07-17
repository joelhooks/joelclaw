# Park Chorus (rhizomatic claims service)

Read first: `.brain/projects/memory-system-cleanup/park-chorus.svx` (your
step file — you own it), the decision
`.brain/projects/memory-system-repair/decide-chorus-fate.svx`, and the
evidence in `.brain/projects/memory-system-review/periphery-survey.svx`
("Rhizomatic / Chorus claims" section — it has the paths/ports).

## Task

1. **Locate everything**: the service process (launchd label, port,
   repo/dir), the session-start briefing injection point (a SessionStart
   hook in Claude settings and/or pi/codex equivalents — the injected
   block is titled "Rhizomatic briefing"), and the 13-mutation outbox.
2. **Snapshot the outbox** to
   `.brain/data/memory-system-cleanup/chorus-outbox-snapshot-2026-07-17.json`
   (verbatim contents + file listing + sha256). Nothing from it becomes
   a live claim.
3. **Prepare the parking**: write the exact commands to (a) remove/disable
   the briefing injection from the hook config, (b) stop and disable the
   service (launchctl bootout/disable or equivalent), and (c) the restart
   path to un-park it later. Put these in your step file's Result section.
4. **Execute the reversible parts you can do safely**: editing hook config
   files to remove the injection is in scope. Stopping the service is
   steering's — hand over the exact commands instead.

## Rules

- Nothing gets deleted — snapshot, disable, park.
- Do NOT stop/bootout services yourself; prepare exact commands.
- If hook config lives in `~/.claude/settings.json` or fleet-grafted
  files, note whether the edit is machine-local or dark-wizard-synced —
  dark-wizard edits need steering's commit.
- Record results + receipts in your step file. Print a DONE summary.
