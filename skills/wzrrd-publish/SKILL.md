---
name: wzrrd-publish
description: Publish static files or directories to wzrrd.sh. Use for sharing agent-built pages, demos, receipts, docs, diagrams, or static artifacts at https://<slug>.wzrrd.sh/.
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

## Expiring authenticated publishes

The live site advertises expiring authenticated publishes:

```bash
wzrrd publish --file ./site --slug demo --expires-in 7d
```

Duration aliases include `1h`, `24h`, `7d`, and `month` (30 days).

For review or feedback URLs, default to `--expires-in 3h` unless the user specifies another expiry or asks for permanence.

Compatibility check: only use `--expires-in` after `wzrrd publish --help` lists it. Local CLI `0.3.0` currently rejects this flag.

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

## Review page and diagram defaults

- Default to black text on white or near-white paper, compact hero, modest H1, sane letter spacing, and paragraphs over card grids.
- Use boxes sparingly. Reserve them for receipts, controls, and data that truly needs a boundary.
- For workflow, lifecycle, triage, approval, runtime, or operator-report graphics, prefer tall vertical D2 flowcharts rendered as static SVG. Use `direction: down` and let labels breathe.
- Avoid crushed wide diagrams. If the chart explains how work moves, vertical flow is usually more readable on wzrrd pages and pi-notes surfaces.
- Add cache-busting query params to regenerated SVGs when republishing a wzrrd page so stale browser cache does not show the old chart.
- For reusable report pages, prefer SvelteKit rendering MDSvX with reusable components for flowcharts, marginalia, stat lines, paragraph lists, tables, and receipts.
- Prefer Tufte-style marginalia for footnotes, source notes, privacy notes, and link context. Collapse marginalia into a left-rule note on mobile.
- Use Shiki with a Catppuccin theme for code blocks when the page includes source snippets.

## Diagnostics

Before debugging, run:

```bash
wzrrd doctor && wzrrd auth-status
```

## Return format

Always give the user the live URL. For review or feedback URLs, state the configured expiry, defaulting to 3 hours unless otherwise specified. If the publish was anonymous, also include the `claimUrl` and remind them it expires in 24 hours unless claimed.

## Current joelclaw compatibility notes

- As of 2026-05-19, local `wzrrd --version` reports `0.3.0`.
- The live site skill advertises `--expires-in`, but local CLI `0.3.0` rejects it with `Received unknown argument: '--expires-in'`.
- The live site exposes machine-readable discovery at:
  - `https://wzrrd.sh/llms.txt`
  - `https://wzrrd.sh/index.md`
  - `https://wzrrd.sh/.well-known/agent-configuration`
  - `https://wzrrd.sh/.well-known/api-catalog`
  - `https://wzrrd.sh/.well-known/agent-skills/index.json`
  - `https://wzrrd.sh/.well-known/mcp/server-card.json`
  - `https://wzrrd.sh/.well-known/agent-card.json`
