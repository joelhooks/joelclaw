---
status: proposed
date: 2026-02-26
decision-makers: [Joel Hooks]
tags: [discovery, inngest, enrichment, vault]
---

# ADR-0150: Discovery Enrichment Pipeline

## Context

When Joel flags something as "interesting" (a URL, repo, tweet), the discovery pipeline captures it to Vault. Currently, enrichment happens ad-hoc in the agent session — manually fetching tweet content, pulling repos, profiling posters. This is slow, inconsistent, and wastes session context.

Some discoveries touch projects we actively track (opencode, opentui, course-builder). These deserve deeper investigation: recent commits, PRs, issues, contributor profiles. This enrichment should be durable, automatic, and event-driven.

## Decision

Build a durable Inngest enrichment pipeline triggered by `discovery/noted` events. The pipeline fans out based on URL type and topic relevance, running enrichment steps that write back to the Vault note.

### Event Flow

```
discovery/noted
  → discovery/enrich (fan-out coordinator)
    → step: classify URL type (tweet, repo, article, video)
    → step: fetch content (X API, defuddle, repo clone)
    → step: match tracked projects (opencode, opentui, course-builder, etc.)
    → step: if matched → deep dig (recent commits, PRs, issues)
    → step: profile poster/author (git authors, web search, contact lookup)
    → step: write enriched vault note
    → step: fire discovery/enriched
```

### URL Type Handlers

| URL Pattern | Handler | Tool |
|---|---|---|
| `x.com/*/status/*` | X API v2 tweet fetch | OAuth 1.0a via agent-secrets |
| `github.com/*/*` | Repo clone + analysis | repo_clone, git log |
| `youtube.com/*`, `youtu.be/*` | Video ingest pipeline | Existing video/download event |
| `*.md`, articles | Defuddle extraction | defuddle CLI |
| Everything else | Web search + extract | web_search |

### Tracked Projects Registry

A config file (`packages/system-bus/src/config/tracked-projects.ts`) maps keywords/repos to local paths and upstream remotes:

```typescript
export const TRACKED_PROJECTS = [
  { keywords: ["opencode"], repo: "anomalyco/opencode", upstream: "sst/opencode", local: "~/Code/anomalyco/opencode" },
  { keywords: ["opentui"], repo: "anomalyco/opentui", upstream: "sst/opentui" },
  { keywords: ["course-builder"], repo: "badass-courses/course-builder" },
  { keywords: ["pi-tools"], repo: "joelhooks/pi-tools" },
] as const;
```

### Poster/Author Profiling

When a discovery has an identifiable author:
1. Check `~/Vault/Contacts/` for existing contact
2. If found → link in vault note
3. If not found but appears relevant (core contributor, >10 commits) → fire `contact/enrich` event (ADR-0133)
4. Include author context in the enriched vault note

### Privilege Rules (ADR-0131)

- Discoveries from Slack → `privileged: true`, no auto-publish
- Discoveries from Telegram/direct → `privileged: false`, pipeline can publish to /cool/
- Enrichment pipeline respects privilege flag throughout

## Implementation

### Phase 1: Core enrichment function
- `discovery/enrich` Inngest function
- URL classification step
- X API tweet fetching step
- Article extraction via defuddle step
- Write enriched vault note

### Phase 2: Deep dig for tracked projects
- Tracked projects registry
- Repo fetch + recent commit/PR analysis
- Author profiling + contact lookup

### Phase 3: Feedback loop
- `discovery/enriched` event triggers downstream (publish to /cool/, notify gateway)
- Quality scoring — did the enrichment add meaningful context?

## Consequences

- Discoveries arrive in Vault fully enriched, not as bare URLs
- Agent sessions don't burn context on manual enrichment
- Tracked project awareness is centralized and maintainable
- Author profiling feeds the contact enrichment pipeline (ADR-0133)
- X API usage is metered — watch rate limits (300 reads/15min on app-level)
