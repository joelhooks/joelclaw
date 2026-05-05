# deepsec

This directory holds the [deepsec](https://www.npmjs.com/package/deepsec)
config for the parent repo. Checked into git so teammates inherit
project context (auth shape, threat model, custom matchers); generated
scan output is gitignored.

Currently configured project: `joelclaw` (target: `..`).

## Setup

1. `pnpm install` — installs deepsec.
2. Add an AI Gateway / Anthropic / OpenAI token to `.env.local`. If
   you already have `claude` or `codex` CLI logged in on this
   machine, you can skip the token for non-sandbox runs (`process` /
   `revalidate` / `triage`); deepsec auto-detects and reuses the
   subscription. See
   `node_modules/deepsec/dist/docs/vercel-setup.md` after install.
3. Open the parent repo in your coding agent (Claude Code, Cursor, …)
   and have it follow `data/joelclaw/SETUP.md` to fill in
   `data/joelclaw/INFO.md`.

## Canary commands

Start with a narrow matcher set. Do **not** run broad `process` until
candidate volume has been reviewed; AI processing is the paid stage.

```bash
pnpm deepsec scan --project-id joelclaw --matchers webhook-handler,slack-signing-verification,secret-in-log,secret-in-fallback,secrets-plaintext-exposure,rce,ssrf,git-provider-url-injection,untrusted-redirect-following,all-route-handlers,catch-all-route-auth,test-header-bypass,fs-write-symlink-boundary
pnpm deepsec status --project-id joelclaw
```

Only after reviewing candidate volume:

```bash
pnpm deepsec process --project-id joelclaw
pnpm deepsec revalidate --project-id joelclaw
pnpm deepsec export --project-id joelclaw --format md-dir --out ./findings
```

`--project-id` is auto-resolved while there's only one project in
`deepsec.config.ts`. Once you've added a second project, pass
`--project-id joelclaw` (or whichever id you want) explicitly.

`scan` is free (regex only). `process` is the AI stage and can get
expensive on large repos. Run state goes to `data/joelclaw/` and is
gitignored.

## Adding another project

To scan another codebase from this same `.deepsec/`:

```bash
pnpm deepsec init-project ../some-other-package   # path relative to .deepsec/
```

Appends an entry to `deepsec.config.ts` and writes
`data/<id>/{INFO.md,SETUP.md,project.json}`. Open the new SETUP.md
in your agent to fill in INFO.md.

## Layout

```
deepsec.config.ts        Project list (one entry per scanned repo)
data/joelclaw/
  INFO.md                Repo context — checked into git, hand-curated
  SETUP.md               Agent setup prompt — checked in, deletable
  project.json           Generated (gitignored)
  files/                 One JSON per scanned source file (gitignored)
  runs/                  Run metadata (gitignored)
  reports/               Generated markdown reports (gitignored)
AGENTS.md                Pointer for coding agents
.env.local               Tokens (gitignored)
```

## Docs

After `pnpm install`:

- Skill: `node_modules/deepsec/SKILL.md`
- Full docs: `node_modules/deepsec/dist/docs/{getting-started,configuration,models,writing-matchers,plugins,architecture,data-layout,vercel-setup,faq}.md`

Or browse on
[GitHub](https://github.com/vercel/deepsec/tree/main/docs).
