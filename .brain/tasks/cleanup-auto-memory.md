# Migrate Claude auto-memory to a pointer index

Read first: `.brain/projects/memory-system-cleanup/migrate-claude-auto-memory.svx`
(your step file — you own it) and the decision
`.brain/projects/memory-system-repair/decide-claude-auto-memory.svx`.

## Task

Source: `~/.claude/projects/-Users-joel/memory/` — `MEMORY.md` index +
~18 topic pages.

1. **Disposition every topic page**: for each file decide
   `duplicate` (fact already in `~/.brain`, fleet CLAUDE.md graft
   content, or a repo `.brain` — cite where) or `migrate` (fact is real
   and lives nowhere durable). Write the full disposition table into
   your step file's Result section.
2. **Migrate**: for each `migrate` fact, write a Brain note at
   `~/.brain/resources/<slug>.svx` (MDSvX with small frontmatter —
   title, type: "resource", created_at, privacy: "private"). Group
   related small facts into one note where natural (e.g. herdr
   preferences). Convert relative dates to absolute. `.svx`, never `.md`
   — that is the law.
3. **Rewrite `MEMORY.md`** as: (a) a binding rule block at the top —
   "Do not write topic pages. Durable facts go to Brain `.svx` notes
   (`~/.brain/resources/`). This file holds ONLY one-line pointers." —
   then (b) one line per relevant Brain note:
   `- <title> → ~/.brain/resources/<slug>.svx — <hook>`.
4. **Do NOT delete the topic pages** — steering deletes after review.
   List the exact rm commands in your DONE summary.

## Rules

- Work only in `~/.claude/projects/-Users-joel/memory/` and `~/.brain/`.
- No commits (steering commits dark-wizard), no deletions.
- If a memory contradicts current Brain content, flag it in the
  disposition table — don't guess which is right.
- Record results in your step file. Print a DONE summary.
