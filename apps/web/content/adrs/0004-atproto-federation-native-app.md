---
type: adr
status: accepted
tags:
  - adr
  - atproto
  - architecture
  - federation
created: 2026-02-14
updated: 2026-02-19
---

# 0004 — AT Protocol as Bedrock

**Status**: accepted
**Date**: 2026-02-14
**Updated**: 2026-02-19 — Trimmed native app scope to ADR-0054. This ADR now covers AT Protocol as the data/identity layer only.
**Deciders**: Joel
**Relates to**: [0003 — joelclaw over OpenClaw](0003-joelclaw-over-openclaw.md), [0044 — Private-first PDS with Bento bridge](0044-pds-private-first-with-bento-bridge.md), [0054 — joelclaw native app](0054-joelclaw-native-app.md)

## Context

joelclaw needs a foundational data layer — a substrate that every component builds on. Not a database. An identity and data ownership protocol.

Requirements:

1. **Data sovereignty** — each person owns their data, portable across hosts
2. **Federation** — agents communicate across people (shared lists, cross-agent messaging)
3. **Typed schemas** — every record type has a machine-readable contract
4. **Multiple clients** — CLI, web, native app, watch, car all read/write the same data

## Decision

**AT Protocol is the bedrock of joelclaw.** Not a feature. Phase 0.

Every record in the system — agent messages, memory entries, system logs, coding loop state, health checks — is a PDS record with a typed Lexicon schema under `dev.joelclaw.*`.

Each person in the network gets their own PDS (Personal Data Server). Data stored on three-body NAS. A family relay aggregates events across all PDSs.

Inngest stays as the compute/orchestration layer. It subscribes to PDS firehose, processes events, writes results back. Inngest = nervous system. PDS = skeleton.

Obsidian Vault remains as the human knowledge layer (prose, wikilinks, browseable). PDS = agent data (structured, typed, federated). Qdrant indexes both.

### Custom Lexicons (dev.joelclaw.*)

#### Agent Communication
```
dev.joelclaw.agent.message     — role, text, threadId, tools[], model
dev.joelclaw.agent.thread      — title, participants[], status
```

#### Memory
```
dev.joelclaw.memory.session    — summary, source, filesModified[], decisions[]
dev.joelclaw.memory.playbook   — pattern, context, confidence, source
dev.joelclaw.memory.timeline   — period, narrative, highlights[]
```

#### System
```
dev.joelclaw.system.event      — type, data, source (mirrors Inngest events)
dev.joelclaw.system.health     — service, status, lastCheck, details
dev.joelclaw.system.log        — action, tool, detail, reason (mirrors slog)
```

#### Coding Loops
```
dev.joelclaw.loop.run          — loopId, project, status, toolAssignments
dev.joelclaw.loop.iteration    — loopId, storyId, role, tool, status, commitSha
```

#### Tasks
```
dev.joelclaw.task.item         — title, status, project, priority, due, assignee
dev.joelclaw.task.list         — title, items[], sharedWith[]
```

#### Family / Shared
```
dev.joelclaw.family.list       — title, items[], sharedWith[]
dev.joelclaw.family.reminder   — text, due, assignee
dev.joelclaw.family.automation — trigger, action, enabled
```

### Federation Model

Each person gets a DID via PLC directory:
- `did:plc:joel` → custom domain handle
- Family members get their own DIDs, own PDS, own agents

Permissions are role-based:
- **Operator** (Joel): Full system access, all lexicons
- **Family** (trusted): Own PDS + shared family lexicons
- **Friends** (limited): Own PDS + explicitly shared data

### Implementation Phases

**Phase 0**: PDS running, Lexicons defined, XRPC verified ← PDS is live (ADR-0044)
**Phase 1**: Inngest ↔ PDS bridge (firehose → events, responses → records)
**Phase 2**: Family expansion (partner/kid PDS instances)
**Phase 3**: Full federation (relay, cross-agent communication)

## Consequences

- Every client (CLI, app, web, watch, car) reads/writes the same PDS records
- Data is portable — move your PDS, your identity follows
- Adding a person = spinning up a PDS container
- slog, igs, and all system tools write PDS records alongside current behavior
- The native app (ADR-0054) is the primary human interface to this data layer

## Credits

- Bluesky / AT Protocol team — protocol design, PDS implementation, Lexicon schema language
- Paul Frazee — AT Protocol architecture decisions
