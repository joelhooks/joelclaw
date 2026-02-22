---
status: implemented
date: 2026-02-18
decision-makers: Joel Hooks
tags: [gateway, events, prompts, soul, agency, todoist, front, cli-design]
---

# ADR-0053: Event-emitter prompts and the Agency triage principle

## Context and Problem Statement

The gateway extension delivers Inngest events to the pi session as user messages. Previously, ALL events were wrapped in a generic template:

```
## 🔔 Gateway — {timestamp}
{N} event(s):
- **[{time}] {type}** ({source})
  {JSON payload}

Take action on anything that needs it, otherwise acknowledge briefly.
```

This caused two problems:

### 1. The gateway doesn't know the intent

A Todoist comment saying "delete all the comments on this task" arrived with the same framing as a content sync notification. The generic "acknowledge briefly" footer actively discouraged the agent from acting. The **event emitter** knows whether something is an instruction, a notification, or noise — but the gateway discarded that knowledge by wrapping everything identically.

### 2. The agent had no triage instinct

When actionable events arrived, the agent would describe what it *could* do instead of doing it. It would list skills, suggest possibilities, and ask for confirmation — putting decisions back on the human. There was no operating principle for how to evaluate inbound work.

## Decision

### Event emitters craft the prompt (CLI-design principle)

Events can now carry a `payload.prompt` field containing an agent-ready prompt crafted by the emitter. The gateway extension respects this:

- **`prompt` present**: use the emitter's prompt directly, no generic wrapper
- **`prompt` absent**: fall back to the existing generic format
- **Mixed batch**: prompted events get their prompts, generic events get the wrapper

This follows the CLI-design skill principle: **the producer knows the intent**. The Todoist function knows a comment is an instruction. The Front function knows an email needs triage. The content-sync function knows it's just FYI. Each emitter crafts the appropriate prompt for its event type.

### SOUL.md § Agency — the triage instinct

Added a new `## Agency` section to SOUL.md (between Values and Boundaries) that defines how the agent evaluates inbound work:

1. **Can I do this right now?** If yes, do it. Don't ask permission for low-risk, reversible actions.
2. **Does this need confirmation?** Only if destructive, irreversible, or genuinely ambiguous.
3. **Am I blocked?** Say exactly what's missing and what would unblock it.
4. **Does this need human hands?** Physical action, browser login, credit card? Say so plainly.
5. **Is this tedious grunt work?** Even better. That's what agents are for.
6. **Is this clearly not actionable?** Acknowledge briefly and move on.

The key line: *"The default posture is act, don't narrate. Don't describe what you could do — do it or say why you can't."*

This is a **soul-level principle**, not a per-event-type procedure. It applies to everything: Todoist comments, emails, heartbeat items, vague asks, event notifications. The Todoist prompt doesn't need to repeat the triage checklist — the agent already has it as a core value.

### Todoist comments are agent instructions

The Todoist comment notify function (`todoist-comment-notify`) now emits:

```
## 📋 Todoist Instruction

**Task**: "Do shoulder warm-up exercises" (Joel's Tasks) [health]
**Instruction**: delete all the comments on this task
Task `6g3VHVVF3gg5PQR3` · Comment `6g3W77gPpVf8696g` · Project `6g3VPpcM3wV42pqg`
```

Just context and instruction. The agent's triage instinct (§ Agency) handles the rest. Task created/completed events get similarly concise, action-oriented prompts.

## Consequences

* Good, because event emitters control how their events are presented to the agent — no lossy generic wrapper
* Good, because the agent has a clear operating principle for evaluating ANY inbound work, not just Todoist
* Good, because the pattern extends naturally — any new event type just adds `prompt` to its payload
* Good, because Todoist comments now actually get executed (proven: "delete all comments" → 8 comments deleted via API)
* Good, because the triage framework surfaces blockers explicitly ("I need X to do this") instead of vague hand-waving
* Bad, because event emitters now have more responsibility — a poorly crafted prompt could mislead the agent
* Neutral, because the generic fallback still works for events that don't need special framing

## Implementation

* **Modified files**:
  - `~/.agents/SOUL.md` — new `## Agency` section
  - `~/.pi/agent/extensions/gateway/index.ts` — `buildPrompt()` respects `payload.prompt`
  - `packages/system-bus/src/inngest/functions/todoist-notify.ts` — all three functions emit `prompt` field
* **Pattern**: any Inngest function can add `prompt: string` to its gateway.notify payload
* **No new dependencies**

### Verification

- [x] Todoist comment arrives with `## 📋 Todoist Instruction` format
- [x] Agent triages and executes instruction (deleted 8 test comments)
- [x] Generic events (content.synced, cron.heartbeat) still use fallback format
- [x] Front emails arrive with emitter-crafted triage prompt
- [x] TypeScript compiles clean

## More Information

- Related: [ADR-0047 — Todoist as async conversation channel](0047-todoist-as-async-conversation-channel.md)
- Related: [ADR-0048 — Webhook gateway for external service integration](0048-webhook-gateway-for-external-service-integration.md)
- Related: CLI-design skill (`~/.agents/skills/cli-design/SKILL.md`) — producer-crafts-the-prompt principle
- Credit: Joel's framing — "can I do some work with this? does it need confirmation? why can't I take action?" — became the triage framework
- Revisit when: adding new event types that need custom prompts, or if prompt quality becomes inconsistent across emitters
