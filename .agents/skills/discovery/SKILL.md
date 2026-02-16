---
name: discovery
description: "Capture interesting finds to the Vault via Inngest. Triggers when the user shares a URL, repo, or idea with signal words like \"interesting\", \"cool\", \"neat\", \"check this out\", \"look at this\", \"came across\", or when sharing content with minimal context that implies it should be remembered. Also triggers on bare URL drops with no explicit ask. Fires a discovery/noted event and continues the conversation — the pipeline handles everything else."
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

### 1. Fire `igs discover`

```bash
igs discover <url>
# or with context if Joel said something specific:
igs discover <url> -c "what Joel said about it"
```

That's it. The pipeline handles investigation, titling, tagging, writing, and slogging.

### 2. Continue conversation

Don't wait. Joel flagged something and moved on — match that energy.

## What the Pipeline Does (background, in system-bus worker)

1. **Investigate** — clone repos, extract articles via defuddle, read content
2. **Analyze via pi** — decides title, tags, relevance, writes summary in Joel's voice
3. **Write** — vault note to `~/Vault/Resources/discoveries/{slug}.md`
4. **Log** — `slog write --action noted --tool discovery`
