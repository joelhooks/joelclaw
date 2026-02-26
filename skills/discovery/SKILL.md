---
name: discovery
displayName: Discovery
description: "Capture interesting finds to the Vault via Inngest. Triggers when the user shares a URL, repo, or idea with signal words like \"interesting\", \"cool\", \"neat\", \"check this out\", \"look at this\", \"came across\", or when sharing content with minimal context that implies it should be remembered. Also triggers on bare URL drops with no explicit ask. Fires a discovery/noted event and continues the conversation — the pipeline handles everything else."
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, discovery, vault, inngest, capture]
---

# Discovery — Capture What's Interesting

When Joel flags something as interesting, fire it into the pipeline and keep moving.

## Trigger Detection

Signal words/patterns (case-insensitive):
- "interesting", "cool", "neat", "nice", "wild", "clever"
- "check this out", "look at this", "came across", "found this"
- "bookmarking", "save this", "remember this"
- Bare URL/repo link with minimal context (1-2 words + link)
- Sharing a link then immediately moving on

**When NOT to trigger**: If Joel is asking for help with the thing (debugging, implementing, reviewing), that's a task — not a discovery.

## Workflow

### 1. Fire `joelclaw discover`

```bash
joelclaw discover <url>
# or with context if Joel said something specific:
joelclaw discover <url> -c "what Joel said about it"
```

That's it. The pipeline handles investigation, titling, tagging, writing, and slogging.

### 2. Continue conversation

Don't wait. Joel flagged something and moved on — match that energy.

## What the Pipeline Does (background, in system-bus worker)

1. **Investigate** — clone repos, extract articles via defuddle, read content
2. **Analyze via pi** — decides title, tags, relevance, writes summary in Joel's voice
3. **Embed media** — if source is a video (YouTube, etc.), auto-embeds `<YouTubeEmbed url="..." />` in the note
4. **Write** — vault note to `~/Vault/Resources/discoveries/{slug}.md`
5. **Sync** — fires `discovery/captured` event which syncs to joelclaw.com/cool/
6. **Log** — `slog write --action noted --tool discovery`

## X/Twitter URL Enrichment

When the source URL is an X/Twitter post (`x.com/*/status/*` or `twitter.com/*/status/*`):
- X blocks web scraping — **do NOT use url_to_markdown or web_search** for tweet content
- Instead, use the **x-api skill** to fetch tweet text, author, and metrics via the Twitter API v2
- Extract the tweet ID from the URL and call `GET /2/tweets/:id?tweet.fields=text,author_id,created_at,public_metrics&expansions=author_id&user.fields=name,username`
- Include tweet text, author handle, and engagement metrics in the discovery note
- See `x-api` skill for OAuth 1.0a signing details

## Deep Dig — Contextual Escalation

Not all discoveries are equal. When a flagged URL/topic **maps to a project or repo we actively track**, escalate from "fire and forget" to a deep dig before sending the discovery event.

### When to deep dig
- The URL references a repo we have cloned locally (opencode, opentui, course-builder, etc.)
- The topic relates to active work (TUI frameworks, agent tooling, course platforms)
- The poster appears to be a core contributor to something we use

### What a deep dig looks like
1. **Fetch the content** — use X API for tweets, defuddle for articles, repo_clone for repos
2. **Pull the repo** — `git fetch upstream`, check recent commits/PRs related to the topic
3. **Profile the poster** — check git authors, search web for who they are, their role in the project
4. **Check our fork** — is our local clone up to date? Does the change affect us?
5. **Enrich the discovery event** — include all context in the `note` field so the pipeline writes a rich vault note

### Tracked repos/projects (update as needed)
- `anomalyco/opencode` (fork of `sst/opencode`) — local at `~/Code/anomalyco/opencode`
- `anomalyco/opentui` (fork of `sst/opentui`) — TUI framework
- `badass-courses/course-builder` — course platform
- `joelhooks/pi-tools` — pi extensions
- `joelhooks/joelclaw` — this system

### Example: X post about opencode feature
1. Fetch tweet via X API → get text, author, metrics
2. `cd ~/Code/anomalyco/opencode && git fetch upstream` → check related commits
3. Search opentui repo for the feature → identify PRs and authors
4. Web search author → build profile (commits, role, background)
5. Fire enriched `discovery/noted` with full context

## Video/Media Handling

When the source URL is a YouTube video (youtube.com or youtu.be):
- The discovery note gets a `<YouTubeEmbed url="..." />` component right after the title
- This renders an embedded video player on the cool page at joelclaw.com
- The note body still includes analysis/summary — the embed is supplemental, not a replacement for writing about it
