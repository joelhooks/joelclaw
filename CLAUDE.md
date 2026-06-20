<!-- pi-notes-claude:start -->
## pi-notes Brain workflow

This repo has pi-notes installed. Use the repo Brain as the durable source of project knowledge.

Before substantial work:

1. Read `BRAIN.md`.
2. Inspect the relevant `.brain/**/*.svx` notes.
3. Preserve user work and source-ground claims in files, commands, logs, or docs.

When editing notes:

- Write `.svx`, not raw app dumps.
- Keep prose readable and put large source data in `.brain/data/**`.
- Use `.brain/components/**/*.svelte` for reusable local MDSvX components.
- Prefer existing pi-notes standard components before inventing one-off markup.
- Leave a receipt for Review Batches and meaningful decisions.

After changes, run `pi-notes brain check` or the repo-local Brain check command.
<!-- pi-notes-claude:end -->
