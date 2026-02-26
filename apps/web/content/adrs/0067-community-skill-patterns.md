---
status: shipped
date: 2026-02-19
deciders: joel, agent
tags: [memory, approvals, imessage, knowledge-graph, skills]
---

# ADR-0067: Integrate Community Skill Patterns

## Context

Reviewed 3002 OpenClaw community skills (VoltAgent/awesome-openclaw-skills) against joelclaw's capabilities. Identified patterns from 4 skills worth integrating — not as direct installs but as adapted implementations wired into the Inngest event bus.

## Decision

Adopt the following patterns with full attribution:

### 1. Daily Digest (from `memory-curator` by 77darius77)
- Inngest cron function at 23:55 PST daily
- Reads today's daily log from `~/.joelclaw/workspace/memory/YYYY-MM-DD.md`
- Generates structured digest: Summary, Key Events, Learnings, Connections, Open Questions, Tomorrow
- Writes to `~/Vault/Daily/digests/YYYY-MM-DD-digest.md`
- Emits `memory/digest.created` for downstream consumers

### 2. iMessage Channel (from `imsg` by steipete)
- Install `imsg` CLI via `brew install steipete/tap/imsg`
- Create pi skill at `~/.agents/skills/imsg/SKILL.md` wrapping the CLI
- Wire as communication channel in gateway alongside Telegram
- Read-only by default; send requires explicit task context

### 3. Agent Approval System (from `local-approvals` by shaiss)
- Redis-backed approval state (not JSON files)
- Auto-approve learned categories, prompt for novel actions
- Gateway integration: approval requests delivered as Telegram messages
- `joelclaw approvals` CLI subcommand for list/approve/deny/learn
- Emits `agent/approval.requested` and `agent/approval.resolved` events

### 4. Atomic Fact Pattern (from `knowledge-graph` by safatinaztepe)
- Apply supersede-don't-delete pattern to memory observations
- Each observation gets a versioned fact ID
- Superseded observations keep `superseded_by` reference
- Aligns with existing Qdrant `memory_observations` collection

## Attribution

All patterns sourced from openclaw/skills (MIT licensed). Each implementation credits the original skill author in code comments and this ADR.

| Pattern | Source | Author | License |
|---------|--------|--------|---------|
| Daily Digest | `memory-curator` | 77darius77 | MIT |
| iMessage | `imsg` | steipete | MIT |
| Approvals | `local-approvals` | shaiss | MIT |
| Atomic Facts | `knowledge-graph` | safatinaztepe | MIT |

## Consequences

- Daily digest adds end-of-day synthesis to memory pipeline (fills gap between raw logs and MEMORY.md)
- iMessage adds third communication channel (Telegram, email, iMessage)
- Approval system enables "JFDI with guardrails" — autonomous action with learned permissions
- Atomic facts improve memory quality by tracking provenance and supersession
