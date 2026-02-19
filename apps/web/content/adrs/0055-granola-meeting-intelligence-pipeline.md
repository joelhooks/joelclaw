---
status: proposed
date: 2026-02-19
deciders: Joel
tags:
  - architecture
  - granola
  - meetings
  - tasks
  - joelclaw
---

# ADR-0055: Granola Meeting Intelligence Pipeline

## Context

Joel uses Granola for meeting transcription and notes. Granola exposes an MCP server (`https://mcp.granola.ai/mcp`) with tools for listing meetings, querying notes, and pulling transcripts. A `granola-cli` (v0.1.0) wraps this via mcporter for agent-friendly HATEOAS JSON access.

Today, meeting notes sit passive in Granola — Joel has to manually extract action items, decisions, and follow-ups. The agent system should actively monitor for new meetings, analyze transcripts, and surface actionable items into Todoist (ADR-0045) without Joel lifting a finger.

### Why Now

- Granola MCP auth is working (OAuth via mcporter, enterprise enabled)
- `granola-cli` is deployed and tested against live data (5 meetings, search works)
- Todoist integration exists (ADR-0045, ADR-0047 async conversation channel)
- Heartbeat cron runs every 15 minutes — natural polling interval

### Requirements

1. Detect new/updated meetings since last check
2. Pull transcripts and summaries
3. Extract action items, decisions, follow-ups via LLM analysis
4. Create/update Todoist tasks with meeting context and links
5. Notify Joel via gateway when significant items are found
6. Don't re-process meetings already analyzed

## Decision

Add a **Granola check step** to the existing heartbeat cron that polls for new meetings, then fans out to a dedicated `meeting/analyze` Inngest function for transcript analysis and task creation.

### Architecture

```
heartbeat (every 15min)
  └─ step: granola-check
       ├─ granola meetings --range this_week
       ├─ compare against Redis set `granola:processed`
       └─ for each new meeting → emit meeting/noted event

meeting/noted (Inngest function)
  ├─ step: pull-details    → granola meeting <id>
  ├─ step: pull-transcript → granola meeting <id> --transcript
  ├─ step: analyze         → LLM extracts action items, decisions, follow-ups
  ├─ step: create-tasks    → todoist-cli add (with meeting link, context)
  ├─ step: mark-processed  → Redis SADD granola:processed <id>
  └─ step: notify-gateway  → pushGatewayEvent with summary
```

### State Management

- **Redis set `granola:processed`**: meeting IDs already analyzed. TTL 90 days.
- **Redis hash `granola:last_check`**: timestamp of last successful poll. Heartbeat uses this for `--updated-after` on next check.

### Analysis Prompt

The LLM analysis step extracts structured data from the transcript:

```json
{
  "action_items": [
    { "task": "Run Amex statements through AI analysis", "owner": "Joel", "deadline": "today", "context": "..." }
  ],
  "decisions": [
    { "decision": "Merge Egghead into Code TV", "rationale": "...", "meeting_link": "..." }
  ],
  "follow_ups": [
    { "item": "Monthly check-ins for expense monitoring", "frequency": "monthly" }
  ]
}
```

### Todoist Task Format

```
Title: [Granola] Run Amex statements through AI analysis
Description:
  From: "Egghead business wind-down" (Feb 5, 2026)
  Owner: Joel
  Link: https://notes.granola.ai/d/<id>
  Context: Accountant requested expense analysis for tax filing
Project: Inbox (agent captures, Joel triages)
```

## Alternatives Considered

### Granola webhook/push (rejected)
Granola has no webhook or push notification API. Polling via MCP is the only option.

### Enterprise API instead of MCP (rejected)
Enterprise API only returns workspace-shared notes. MCP returns all personal notes. Since Joel is the only user, MCP is the right access pattern.

### Dedicated cron instead of heartbeat step (rejected)
Adding a step to the existing 15-min heartbeat keeps the cron surface small. If Granola checks become heavy, split to a dedicated cron later.

## Consequences

### Positive
- Action items from meetings automatically appear in Todoist within 15 minutes
- Decisions are captured as structured records, not buried in transcripts
- Meeting intelligence is searchable via Todoist and Qdrant (if observations are emitted)

### Negative
- mcporter OAuth tokens expire — needs refresh handling or re-auth flow
- LLM analysis costs per meeting (mitigated: only new meetings, ~5/week)
- Granola MCP may change — adapter boundary absorbs this

### Follow-up Tasks
- [ ] Add `granola-check` step to heartbeat function
- [ ] Create `meeting/noted` Inngest function
- [ ] Add `granola:processed` Redis set management
- [ ] Handle mcporter OAuth token refresh in CLI
- [ ] Add Granola connection health to system-check skill

## Implementation Plan

### Affected Paths
- `packages/system-bus/src/inngest/functions/heartbeat.ts` — add granola-check step
- `packages/system-bus/src/inngest/functions/meeting-analyze.ts` — new function
- `packages/system-bus/src/inngest/functions/index.ts` — register new function
- `packages/system-bus/src/inngest/serve.ts` — add to function array

### Pattern
- Shell out to `granola` CLI (compiled binary at `~/.local/bin/granola`)
- Parse HATEOAS JSON response
- Fan-out via Inngest events (one per new meeting)
- Todoist tasks via `todoist-cli` (ADR-0045 adapter)
- Gateway notifications via `pushGatewayEvent` (ADR-0018)

### Verification
- [ ] `granola meetings` returns data in heartbeat step
- [ ] New meetings emit `meeting/noted` events
- [ ] Previously processed meetings are skipped (Redis SISMEMBER)
- [ ] Todoist tasks created with meeting link and context
- [ ] Gateway receives notification with meeting summary
