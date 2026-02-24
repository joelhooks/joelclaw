---
status: accepted
date: 2026-02-23
deciders: joel, panda
tags: [gateway, discord, ux]
---

# ADR-0120: Discord Thread-Based Conversations

## Context

The Discord channel in the gateway treats every message as a flat prompt to the single gateway pi session. Discord mention syntax (`<@BOT_ID>`) passes through raw, confusing the agent. There's no visual organization — all messages and responses appear in whatever channel the user types in.

[Cord](https://github.com/alexknowshtml/cord) demonstrates the Discord-native pattern: each @mention spawns a thread, follow-ups stay in that thread, and a status message in the parent channel shows progress. This is how Discord users expect bot interactions to work.

## Decision

Upgrade the Discord channel to use thread-based conversations:

1. **@mention in a channel** → bot creates a thread from a status message ("⏳ Processing..."), forwards the cleaned prompt to the gateway session with `source: discord:THREAD_ID`
2. **Message in an existing bot thread** → forwards to gateway session with the same thread source
3. **DMs** → work as before (flat, no threads)
4. **Responses route back to the thread** via the existing outbound router (source prefix matching)
5. **Status message updates** → edited to "✅ Done" when response completes, "❌ Error" on failure
6. **✅ reaction on last thread message** → marks status as done (quick close)

### Constraints

- Single gateway pi session — we don't spawn per-thread sessions like Cord does. All threads feed into the same command queue sequentially. This is fine; the UX improvement is visual organization, not parallelism.
- Thread state is in-memory (Map). Threads are ephemeral — if gateway restarts, existing threads still work for new messages (we re-fetch), but status message tracking is lost. Acceptable.

## Consequences

- Discord UX matches native bot conventions (thread per conversation)
- Parent channels stay clean — just status lines
- Bot mention syntax no longer leaks into agent prompts
- `GuildMessageReactions` intent required for ✅ auto-complete
