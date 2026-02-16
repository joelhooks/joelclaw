---
name: discovery
description: "Capture interesting finds (repos, articles, tools, ideas, papers) to the Vault via Inngest. Triggers when the user shares a URL, repo, or idea with signal words like \"interesting\", \"cool\", \"neat\", \"check this out\", \"look at this\", \"came across\", or when sharing content with minimal context that implies it should be remembered. Also triggers on bare URL drops with no explicit ask. Fires a discovery/noted event and continues the conversation — the system-bus worker handles investigation and vault note creation in the background."
---

# Discovery — Capture What's Interesting

When Joel flags something as interesting, fire an Inngest event and keep moving. The system-bus worker investigates and writes the vault note in the background.

## Trigger Detection

Signal words/patterns (case-insensitive):
- "interesting", "cool", "neat", "nice", "wild", "clever"
- "check this out", "look at this", "came across", "found this"
- "bookmarking", "save this", "remember this"
- Bare URL/repo link with minimal context (1-2 words + link)
- Sharing a link then immediately moving on

**When NOT to trigger**: If Joel is asking for help with the thing (debugging, implementing, reviewing), that's a task — not a discovery.

## Workflow

### 1. Quick investigation in main thread

Do a brief scan so you can respond intelligently — clone the repo/read the page, give Joel the gist. This is the natural conversation part.

### 2. Fire the Inngest event

```bash
curl -s -X POST "http://localhost:8288/e/37aa349b89692d657d276a40e0e47a15" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "discovery/noted",
    "data": {
      "url": "https://github.com/simonw/showboat",
      "topic": "showboat — executable demo documents for agents",
      "context": "Simon Willison tool. CLI for agents to build markdown docs with executed code blocks and captured output. Verify re-runs all blocks and diffs. Relevant to agent loop proof-of-work.",
      "depth": "medium",
      "tags": ["repo", "cli", "ai", "agent-tooling"]
    }
  }'
```

### 3. Continue conversation

Don't wait for the background task. Joel flagged something and moved on — match that energy.

## Event Schema

```typescript
"discovery/noted": {
  data: {
    url?: string;          // URL to investigate (repo, article, etc.)
    topic: string;         // Short title/description
    context?: string;      // What Joel said / agent's quick take
    depth?: "quick" | "medium" | "deep";  // Default: medium
    tags?: string[];       // Source type + domain tags
  };
};
```

## What the Worker Does

The `discovery-capture` Inngest function:

1. **Investigate** — clone repos (git), extract articles (defuddle-cli), or use provided context
2. **Summarize** — generate vault note via pi (joel-writing-style voice)
3. **Write** — save to `~/Vault/Resources/discoveries/{slug}.md`
4. **Log** — `slog write --action noted --tool discovery --detail "{topic}" --reason "vault:Resources/discoveries/{slug}.md"`

## Vault Note Format

```markdown
---
type: discovery
source: {url}
discovered: {ISO date}
tags: [{tags}]
relevance: {one-line on why this matters}
---

# {Title}

{2-4 paragraph summary — direct, connect to Joel's system where relevant}

## Key Ideas

- {Notable concepts, patterns, features}

## Links

- {Source URL}
- {Related references}
```

## Depth Levels

- **quick**: Use provided context only, minimal note
- **medium** (default): Clone/read, summarize key ideas, note relevance to Joel's system
- **deep**: Cross-reference active Vault projects, check ADRs, note integration points, suggest next steps
