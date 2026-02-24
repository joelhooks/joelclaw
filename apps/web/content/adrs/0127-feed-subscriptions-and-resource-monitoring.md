# ADR-0127: Feed Subscriptions & Resource Monitoring

- **Status**: proposed
- **Date**: 2026-02-24
- **Related**: ADR-0087 (observability pipeline), ADR-0112 (caching layer)

## Context

Joel wants to "subscribe" to external resources — blogs, repos, guides — and get periodic summaries of changes. The first concrete case: Simon Willison's agentic engineering patterns guide and his blog in general.

Currently joelclaw has no mechanism to monitor external content for changes and surface updates. Discovery captures are one-shot — fire and forget.

## Decision

Build a **feed subscription system** as an Inngest cron that:

1. **Checks subscribed resources** on a schedule (hourly for RSS, daily for scraped pages)
2. **Detects changes** via content hash diff or feed entry timestamps
3. **Summarizes updates** via LLM when changes are detected
4. **Publishes to `/cool`** on joelclaw.com (discovery pipeline)
5. **Notifies Joel** with a brief review summary via gateway

### Feed Types (efficiency-first)

| Type | Method | Frequency | Example |
|------|--------|-----------|---------|
| **Atom/RSS** | Standard feed parse | Hourly | Simon Willison's blog |
| **GitHub repo** | GitHub API releases/commits | Hourly | frontman-ai/frontman |
| **Living page** | Content hash diff (defuddle) | Daily | Simon's agentic patterns guide |
| **Substack** | RSS feed | Hourly | simonw.substack.com |
| **Bluesky** | AT Protocol firehose/feed | Hourly | simonwillison.net on bsky |

### Subscription Schema

```typescript
interface Subscription {
  id: string
  name: string                    // "Simon Willison"
  feedUrl: string                 // Atom/RSS URL or GitHub API URL
  type: "atom" | "rss" | "github" | "page" | "bluesky"
  checkInterval: "hourly" | "daily" | "weekly"
  lastChecked: number
  lastContentHash: string         // For page-type change detection
  lastEntryId: string             // For feed-type dedup
  filters?: string[]              // Tag/topic filters (e.g., ["ai", "agents", "llm"])
  publishToCool: false             // Default OFF — /cool is curated, not a firehose
  notify: boolean                 // Send gateway notification with approve/dismiss
  summarize: boolean              // LLM summarize changes
  active: boolean
}
```

### Storage

Redis sorted set `subscriptions:feeds` with subscription metadata as JSON values. Content hashes and last-seen entry IDs for dedup.

### Inngest Functions

1. **`subscription/check-feeds`** — Cron (hourly). Fans out per subscription.
2. **`subscription/check-single`** — Per-subscription: fetch, diff, detect changes.
3. **`subscription/summarize`** — LLM summarize new entries/changes.
4. **`subscription/publish`** — Fire `discovery/noted` for new items, notify gateway.

### CLI

```bash
joelclaw subscribe add <url> [--name "Simon Willison"] [--filter ai,agents] [--interval hourly]
joelclaw subscribe list
joelclaw subscribe remove <id>
joelclaw subscribe check [--id <id>]   # Manual trigger
joelclaw subscribe summary             # What's new across all subscriptions
```

## Initial Subscriptions

| Name | URL | Type | Filter |
|------|-----|------|--------|
| Simon Willison (all) | `https://simonwillison.net/atom/everything/` | atom | — |
| Simon Willison (agentic guide) | `https://simonwillison.net/guides/agentic-engineering-patterns/` | page | — |
| Frontman AI | `https://github.com/frontman-ai/frontman` | github | releases |
| Kimaki | `https://github.com/remorses/kimaki` | github | releases |
| OpenClaw | `https://github.com/openclaw/openclaw` | github | releases |

## Consequences

- External content monitoring becomes a first-class capability
- RSS/Atom preferred over scraping (efficient, polite, stable)
- GitHub API for repos (rate-limited but reliable)
- Page hash diff as fallback for non-feed content
- LLM summarization costs per update (~$0.01-0.05 per summary)
- `/cool` stays curated — nothing auto-publishes. Joel approves via gateway notification button.
- Joel gets brief notification summaries with [Publish to /cool] [Dismiss] buttons
- Only items Joel explicitly approves reach `/cool` — quality over quantity

## Publishing Flow

```
Feed update detected
  → LLM summarizes (brief, relevant-to-joelclaw filter)
  → Gateway notification with summary + [Publish to /cool] [Dismiss]
  → Joel taps Publish → fires discovery/noted → appears on /cool
  → Joel taps Dismiss → logged, not published
```

The LLM summary step should also assess **relevance to joelclaw** (agents, personal infra, BEAM/Elixir, developer tools, agentic patterns). Low-relevance items get a shorter notification without the publish button — just "FYI: Simon posted about Django migrations" vs a full card for "Simon published new agentic engineering patterns."

## Non-Goals (v1)

- No auto-publishing to /cool — ever. Joel curates.
- No full-text indexing of subscribed content (just summaries)
- No social media monitoring beyond Bluesky (Twitter API too expensive)
- No comment/reply tracking
- No real-time (webhook) — polling only
