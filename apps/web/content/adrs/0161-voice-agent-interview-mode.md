---
status: accepted
date: 2026-02-27
tags: [voice, livekit, content, tooling]
---

# ADR-0161: Voice Agent Interview Mode

## Context

The voice agent (ADR-0043) handles phone calls via Telnyx SIP → LiveKit → Python agent. It has tools for calendar, tasks, system health, vault search, email, events, and loops. But it lacks:

1. **Work context tools** — no access to recent commits, slog entries, ADR changes, or running work status
2. **Mode awareness** — every call is the same generic conversation
3. **Article drafting** — no way to turn a voice conversation into structured content
4. **Work item selection** — no menu of "what's next" to pick from and execute

Joel wants an "interview mode" where the agent leads a structured conversation to develop article ideas, with full visibility into recent system activity.

## Decision

### 1. New Tools (CLI wrappers)

Add tools to `infra/voice-agent/main.py`:

| Tool | Source | Purpose |
|------|--------|---------|
| `recent_commits(hours)` | `git log --since` on monorepo | What code changed |
| `recent_slog(hours)` | `slog tail --count N` | What ops happened |
| `recent_adrs()` | `ls + head` on Vault/docs/decisions | ADR activity |
| `work_items()` | MEMORY.md "Next Steps" + Todoist | Actionable menu |
| `running_work()` | `joelclaw runs` + `joelclaw loop status` | In-flight work |
| `draft_article(topic, outline, key_points)` | Write to Vault + fire Inngest event | Capture interview output |

All tools shell to existing CLIs — no new infrastructure.

### 2. Mode System

Modes are declared by Joel at call start or detected from greeting:

- **default** — reactive, current behavior
- **interview** — agent leads with questions, probes for depth, captures structured notes. Post-call: transcript → article draft pipeline
- **standup** — agent briefs recent activity, asks for priorities, captures decisions

Mode affects:
- System instructions (appended mode-specific prompt section)
- Greeting behavior (interview: "What are we writing about?", standup: brief + ask)
- Post-call processing (interview → article draft, standup → daily log entry)

Mode is set via a `set_mode` tool or detected from Joel's opening statement.

### 3. Post-Call Pipeline

On `voice/call.completed` Inngest event (already fired):
- If mode was `interview`: extract article draft from transcript, save to `~/Vault/drafts/`
- If mode was `standup`: extract decisions and action items, update daily log
- Default: save transcript only (current behavior)

The `voice/call.completed` event payload gains a `mode` field.

### 4. Work Context Briefing

When entering interview or standup mode, agent auto-loads:
- Last 24h commits (summarized)
- Recent slog entries
- Open work items from MEMORY.md
- Running Inngest work
- Recent ADR changes

This supplements the existing `_gather_context()` which already loads MEMORY.md, calendar, and system health.

## Consequences

- Voice agent becomes a content creation tool, not just a phone assistant
- Article drafts flow through existing Vault → publish pipeline
- Mode-specific prompts keep the agent focused without Joel having to direct every turn
- All new tools are CLI wrappers — zero new infrastructure dependencies
