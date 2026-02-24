---
status: proposed
date: 2026-02-24
deciders: joel
tags:
  - social
  - automation
  - x-api
related:
  - 0127-feed-subscriptions-and-resource-monitoring
  - 0070-telegram-rich-notifications
---

# ADR-0129: Automated X Posting Strategy

## Context

@joelclaw has an active X account with OAuth 1.0a API access. The system produces public content (blog posts, ADRs, discoveries) and internal operational data (deploys, health, friction fixes). We need guidance for what triggers a tweet, what the voice sounds like, and what the approval flow is.

## Decision

### Tweet Triggers

Three categories, each with a different automation level:

**Auto-post (notify Joel after):**
- New blog post published → tweet with title + link
- ADR status changes to `shipped` → tweet with ADR number + one-line summary + link
- New discovery captured (if `public: true` tag) → tweet with title + source link
- Daily digest — "what shipped in joelclaw today" if ≥2 meaningful changes
- Weekly recap — aggregate of the week's public content

All posts are autonomous. Gateway notifies Joel via Telegram after each tweet (silent notification with tweet text + link). No approval flow needed.

**Never auto-post:**
- Replies to other accounts (Joel says when to engage)
- Opinions, hot takes, anything that could be misattributed to Joel
- Anything touching other people's work without Joel's explicit ask

### Voice

- Terse, technical, slightly dry
- No emoji spam (one max, if any)
- No hashtags
- No "excited to announce" energy
- State what's new and link to it. That's it.
- Match the swarm-tools tweet prompt style: factual, cheeky, developer-facing

### Tweet Templates

**New post:**
```
New: {title}
{url}
```

**ADR shipped:**
```
ADR-{number} shipped: {one-line summary}
{url}
```

**Discovery:**
```
Interesting: {title} — {one-line-why}
{source_url}
```

**Daily digest (if ≥2 items):**
```
Today in joelclaw:
• {item1}
• {item2}
{joelclaw.com link}
```

### Implementation

#### Inngest Functions

1. **`x/post.requested`** — generic tweet event. Payload: `{ text }`. Posts immediately, then notifies gateway.

2. **Content publish hook** — listens for `content/published` events (blog post deploy, ADR status change). Generates tweet text from template, fires `x/post.requested`.

3. **Discovery hook** — listens for `discovery/noted` completion. If discovery has `public` tag, fires `x/post.requested`.

4. **Daily digest cron** — runs at 6pm PST. Aggregates day's public changes from slog + git. If ≥2 items, fires `x/post.requested`.

#### X Posting Function

Single Inngest function handles all posting:
- Leases OAuth 1.0a secrets
- Signs with `requests-oauthlib` (or port to Node `oauth-1.0a` package)
- Posts via Twitter API v2
- Emits `x/post.completed` event with tweet ID
- Rate limit: max 5 tweets/day hard cap

### Guardrails

- **Daily cap**: 5 tweets max (hard limit in function)
- **Dedup**: Don't tweet the same URL twice (check Redis set)
- **Cooldown**: Minimum 30 minutes between tweets
- **Kill switch**: `joelclaw x pause` / `joelclaw x resume` CLI commands
- **Dry run**: All functions respect `dryRun` flag in event payload

## Consequences

- **Positive**: joelclaw.com content gets automatic distribution
- **Positive**: Joel doesn't have to remember to tweet about new posts
- **Positive**: Consistent voice and formatting
- **Negative**: Risk of posting something Joel wouldn't want public
- **Mitigation**: Never auto-post opinions/replies. Daily cap + dedup + kill switch.
- **Mitigation**: All tweets are template-driven content announcements, not generated opinions. Joel notified after each post.
