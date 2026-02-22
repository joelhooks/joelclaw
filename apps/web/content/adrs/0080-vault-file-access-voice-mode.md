---
status: implemented
date: 2026-02-20
decision-makers: joel
consulted: agent
tags: [gateway, voice, vault, telegram, file-access]
---

# ADR-0080: Vault File Access from Voice Mode

## Context

When Joel used Telegram voice to ask "read ADR-0077" or "what's in my vault note about memory system," the agent couldn't comply. Investigation revealed:

1. The gateway pi session **has full tool access** — `createAgentSession()` in `packages/gateway/src/daemon.ts` does not disable tools
2. The problem was **message shaping**: voice transcripts were sent as status-like prompts (`"transcribing..."`) plus `media.processed` notifications, not direct user prompts
3. Redis `buildPrompt()` didn't prioritize `payload.prompt` events, so voice transcripts weren't treated as first-class requests

The tools existed. The prompts weren't shaped to use them.

## Decision

Fix the message pipeline so voice transcripts arrive as actionable user prompts, and add a vault resolver for common reference patterns.

### Changes

| File | Change |
|------|--------|
| `packages/gateway/src/vault-read.ts` | New vault resolver utility |
| `packages/gateway/src/channels/telegram.ts` | Text messages pass through vault resolver before enqueue |
| `packages/gateway/src/channels/redis.ts` | `buildPrompt()` handles `payload.prompt` events first |
| `packages/system-bus/src/inngest/functions/media-process.ts` | Voice transcripts emit `telegram.message.received` with `prompt: transcript` |

### Vault Resolver

Resolves three reference patterns:

1. **ADR partial**: `ADR-0077` → `~/Vault/docs/decisions/0077-*.md`
2. **Exact path**: `~/Vault/Projects/09-joelclaw/index.md`
3. **Fuzzy note**: `"memory system"` → finds matching vault files

When a reference is detected, the resolver reads the file and injects its content into the prompt context — the agent sees both the user's request and the file content.

## Consequences

- Voice mode now has the same file-reading capability as text mode
- Vault resolver adds a small overhead per message (glob + read) but only triggers on detected patterns
- `media-process.ts` now emits two events for voice: the transcript as a user prompt AND the pipeline status — both are useful
- Future: could extend resolver to support `Project 09`, `tool caddy`, or other Vault PARA references
