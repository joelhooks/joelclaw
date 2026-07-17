---
name: recall
displayName: Recall
description: "Fan-out search across all memory sources when context is unclear or vaguely referenced. Triggers on: 'from earlier', 'remember when', 'what we discussed', 'that thing with', 'the conversation about', 'did we ever', 'what happened with', 'you mentioned', 'we talked about', 'earlier today', 'last session', 'the other day', or any vague reference to past context that needs resolution before the agent can act."
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, memory, recall, context, retrieval]
---

# Recall — Find What Was Said

When Joel references something vaguely, don't guess — fan out across all memory sources and find it.

## Trigger Detection

Phrases that indicate a recall is needed (case-insensitive):
- "from earlier", "earlier today", "earlier this week"
- "remember when", "remember that", "you mentioned"
- "what we discussed", "what we talked about", "the conversation about"
- "that thing with", "the thing about", "what was that"
- "did we ever", "have we", "wasn't there"
- "last session", "the other day", "yesterday"
- "correlate with", "connect to what we"
- Any vague pronoun reference to past context ("those photos", "that idea", "the notes")

**Key principle**: If you'd have to guess what "earlier" or "that" refers to, you need recall.

## Fan-Out Search Pattern

Search these sources **in parallel** where possible, with timeouts on each:

### 1. Brain-backed recall (fastest broad cut)
```bash
joelclaw recall "<keywords>" --limit 10
```
`joelclaw recall` queries disposable `observations` and `brain_graph_nodes` projections. Brain `.svx` is canonical; the retired `memory_observations` collection is not a source.

### 2. Session transcripts
```bash
joelclaw sessions search "<keywords>" --source both --limit 10 --extract
```
Use raw local/SSH fallback when the derived Typesense session index is stale.

### 3. Brain notes
```bash
rg -l -i "<keywords>" ~/.brain --glob '*.svx' | head -20
```
Read the strongest matching pages, not the whole Brain.

### 4. Vault notes
```bash
timeout 5 grep -ri "<keywords>" ~/Vault/ --include="*.md" -l | head -10
```

### 5. Runtime telemetry and events
```bash
joelclaw otel search "<keywords>" --hours 24
joelclaw events --hours 24 --count 100
```
The former `slog`/system-log JSONL journal is retired.

### 6. Processed media
```bash
ls /tmp/joelclaw-media/ 2>/dev/null
```

### 7. Active runtime state (only when the reference is about live work)
```bash
joelclaw loop list
joelclaw runs --count 20 --hours 24
```
Do not query retired memory-proposal Redis queues.

## Workflow

1. **Extract keywords** from the vague reference. "Those photos from earlier" → keywords: photos, images, media, telegram.
2. **Fan out** across the relevant sources above. Use `timeout 5` on any command that might hang.
3. **Synthesize** — combine findings into a coherent summary of what was found.
4. **Present context** — show Joel what you found, then continue with the original task.
5. **If nothing found** — say so honestly. Don't fabricate. Ask Joel to clarify.

## Timeouts Are Mandatory

Every external call (Redis, grep over large dirs, session reads) MUST have a timeout. The gateway session cannot hang on a recall operation.

```bash
# Good
timeout 5 grep -ri "keyword" ~/Vault/ --include="*.md" -l | head -10

# Bad — can hang indefinitely
grep -ri "keyword" ~/Vault/ --include="*.md"
```

## Anti-Patterns

- **Don't grep one file and call it done.** The whole point is fan-out.
- **Don't guess when recall fails.** Say "I couldn't find it" and ask.
- **Don't read entire session transcripts.** Use `session_context` with a focused query.
- **Don't skip media.** Photos, audio, processed images in `/tmp/joelclaw-media/` are often what "from earlier" refers to.
