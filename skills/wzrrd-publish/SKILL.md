---
name: wzrrd-publish
description: Publish static files, directories, or quick review pages to wzrrd.sh. Use when the user asks for a wzrrd link/share link/review link, or wants to share plans, work, demos, receipts, docs, diagrams, or static artifacts at https://<slug>.wzrrd.sh/.
---

# wzrrd publish

Use `wzrrd` to publish static files and directories to `https://<slug>.wzrrd.sh/`.

Public CLI and skill distribution repo: `wzrrd-sh/wzrrd-cli`.

## Install

If `wzrrd` is missing:

```bash
curl -fsSL https://wzrrd.sh/install.sh | bash
```

If `~/.local/bin` is not on PATH, add it or call `~/.local/bin/wzrrd` directly.

## Publish immediately

```bash
wzrrd publish --file ./site --slug demo
```

- `--file` can be a single HTML file or a directory with `index.html` at the root.
- Anonymous publishes work without login.
- Anonymous publishes are ephemeral and expire after 24 hours.
- Anonymous responses include `claimUrl`; share/open it if the user wants the URL to become permanent.

## Publish a review link for a plan or assistant response

When the user says "give me a wzrrd link", "publish this plan", "make a share link", or wants another machine to review work:

1. Publish only the specific plan/work artifact, not raw chat history.
2. Redact secrets, private transcript snippets, customer data, and machine-only credentials before publishing.
3. Prefer a small temp directory with an `index.html` review page.
4. Pick a readable slug, e.g. `pi-plan-review`, `support-flow-review`, or `<project>-<topic>-review`.
5. Return the live URL; if anonymous, include the `claimUrl` and expiry note.

Quick static review page pattern:

```bash
site="$(mktemp -d -t wzrrd-review.XXXXXX)"
cat > "$site/index.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Review</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 860px; margin: 3rem auto; padding: 0 1rem; }
    pre { white-space: pre-wrap; background: #f6f6f6; padding: 1rem; border-radius: 8px; }
    textarea { width: 100%; min-height: 12rem; font: inherit; padding: 0.75rem; }
  </style>
</head>
<body>
  <h1>Agent Review</h1>
  <p>Review this plan/work, type feedback below, then paste it back into the agent session.</p>
  <pre>
PASTE_ESCAPED_PLAN_OR_WORK_HERE
  </pre>
  <h2>Feedback</h2>
  <textarea id="feedback" placeholder="Type feedback here..."></textarea>
  <p><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('feedback').value)">Copy feedback</button></p>
</body>
</html>
EOF
wzrrd publish --file "$site" --slug demo-review
```

For polished plans, write semantic HTML instead of dumping into `<pre>`.

## Expiring publishes

CLI `0.3.5` supports expiring publishes:

```bash
wzrrd publish --file ./site --slug demo --expires-in 7d
```

Duration aliases include `1h`, `24h`, `7d`, and `month` (30 days). If a future machine has an older CLI, only use `--expires-in` after `wzrrd publish --help` lists it.

## Permanent publishing

```bash
wzrrd login
wzrrd publish --file ./site --slug demo
```

`wzrrd login` runs a device approval flow and stores a scoped agent token at `~/.config/wzrrd/auth.json`.

## Configured publishing

Projects can add `wzrrd.config.json` with `site.slug` and `publish.source` so agents can run `wzrrd publish` without guessing. Schema: `https://wzrrd.sh/schema/config.json`.

## Safety defaults

- The CLI is non-interactive by default for agents.
- Published sites are `noindex` by default.
- Only add `--index` when the user explicitly wants search indexing.
- Prefer small static artifacts. Current anonymous limits are aggressive: 5 MB total, 1 MB per file, 50 files, 10 anonymous publishes per IP/hour.

## Diagnostics

Before debugging, run:

```bash
wzrrd doctor && wzrrd auth-status
```

Verify a published site with:

```bash
wzrrd site get --slug <slug>
```

## Return format

Always give the user the live URL. If the publish was anonymous, also include the `claimUrl` and remind them it expires in 24 hours unless claimed.

## Current joelclaw compatibility notes

- As of 2026-06-02, local `wzrrd --version` reports `0.3.5`.
- Local CLI `0.3.5` supports `--expires-in` on `wzrrd publish`.
- The live site exposes machine-readable discovery at:
  - `https://wzrrd.sh/llms.txt`
  - `https://wzrrd.sh/index.md`
  - `https://wzrrd.sh/.well-known/agent-configuration`
  - `https://wzrrd.sh/.well-known/api-catalog`
  - `https://wzrrd.sh/.well-known/agent-skills/index.json`
  - `https://wzrrd.sh/.well-known/mcp/server-card.json`
  - `https://wzrrd.sh/.well-known/agent-card.json`
