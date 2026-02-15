---
type: adr
status: accepted
tags:
  - adr
  - atproto
  - architecture
created: 2026-02-14
---

# 0004 — AT Protocol as Bedrock + Native iPhone App

**Status**: accepted  
**Date**: 2026-02-14  
**Deciders**: Joel  
**Relates to**: [0003 — joelclaw over OpenClaw](0003-joelclaw-over-openclaw.md)

## Context

joelclaw needs a foundational data layer. Not just a client interface — a substrate that every component builds on. The system has CLI tools (pi, igs, slog) for operator use, but needs:

1. **A mobile interface** — interact with the agent from anywhere, not just at a terminal
2. **Family access** — partner, kids, and eventually friends should have their own agents
3. **Data sovereignty** — each person should own their data, not have it trapped in a single service
4. **Federation** — agents should communicate across people (shared lists, cross-agent messaging)

Options considered:

### Option A: Custom API + React Native
Build custom REST/WebSocket API, React Native cross-platform app.
- Pro: Full control, cross-platform from day one
- Con: Custom auth, custom sync, custom identity — rebuilding what protocols already solve. No federation model.

### Option B: Custom API + SwiftUI
Build custom REST/WebSocket API, native SwiftUI iPhone app.
- Pro: Best native feel, full iOS integration (widgets, shortcuts, Keychain)
- Con: Still custom everything for federation, identity, data portability.

### Option C: AT Protocol as bedrock + SwiftUI ← **CHOSEN**
Use AT Protocol as the foundational data layer — not just for federation, but as the substrate everything builds on. PDS is the database. Every record (messages, memory, logs, events) is a PDS record. SwiftUI native app as the primary client AppView.
- Pro: Standardized identity (DIDs), data portability, federation baked in, custom Lexicons for every data type, PDS per person, typed schemas, firehose for real-time, community ecosystem
- Con: Larger upfront investment (PDS setup, Lexicon design, relay). AT Proto ecosystem is social-media-oriented — we're repurposing it as a personal OS data layer. That's a bet.

## Decision

**AT Protocol is the bedrock of joelclaw.** Not a feature. Not Phase 4. Phase 0.

Every record in the system — agent messages, memory entries, system logs, coding loop state, health checks — is a PDS record with a typed Lexicon schema under `dev.joelclaw.*`.

Each person in the network gets their own PDS (Personal Data Server) running as a Docker container on the Mac Mini, with data stored on three-body (Asustor 70TB NAS). A family relay aggregates events across all PDSs.

The existing Inngest infrastructure stays as the compute/orchestration layer. It subscribes to the PDS firehose, processes events, and writes results back to the PDS. Inngest is the nervous system; the PDS is the skeleton.

Obsidian Vault remains as the human knowledge layer — markdown notes, ADRs, project docs. It is NOT replaced by the PDS. The two halves: PDS = agent data (structured, typed, federated). Vault = human knowledge (prose, wikilinks, browseable). Qdrant indexes both.

SwiftUI native iPhone app is the primary human interface. CLI tools (pi, igs, slog) are the primary agent/operator interface. Both speak XRPC to the PDS.

## Consequences

### Must Do
- Define `dev.joelclaw.*` Lexicon schemas (agent, memory, system, family)
- Stand up PDS Docker containers with data volumes on three-body
- Register DIDs via PLC directory for each person
- Build Inngest ↔ AT Protocol bridge (firehose → events, responses → records)
- Build SwiftUI app (auth, chat, dashboard)
- Set up family relay
- Configure Tailscale ACLs for per-person PDS access

### Enables
- **Data portability** — anyone can move their PDS to different hardware, their identity follows
- **Open-ended growth** — adding a friend is just spinning up another PDS container
- **Standard protocol** — any AT Protocol client could interact with the system, not just our app
- **Multiple AppViews** — web dashboard, CLI tools, and iPhone app all read from the same PDS
- **slog/igs integration** — system logs and run traces become PDS records, visible in the app

### Risks
- AT Protocol is designed for social media, not agent systems. Custom Lexicons may hit edge cases.
- Swift AT Protocol client ecosystem is immature. May need to build thin XRPC client.
- Running multiple PDS instances + relay on one Mac Mini needs memory/CPU monitoring.
- PLC directory dependency for DID registration (could self-host if needed).

## Implementation Plan

See `~/Vault/Projects/09-joelclaw/native-app-atproto.md` for full architecture, Lexicon schemas, app tab structure, data flow diagrams, and phased build order.

**Phase 0**: AT Protocol foundation (PDS, Lexicons, relay)  
**Phase 1**: Inngest ↔ PDS bridge  
**Phase 2**: iPhone app MVP (chat + dashboard)  
**Phase 3**: Family expansion (partner/kid PDS + simplified agents)  
**Phase 4**: Full dashboard + widgets + Siri shortcuts  

## Verification

- [ ] Joel PDS running, reachable via XRPC, DID resolvable
- [ ] Custom Lexicon records can be created and read via curl
- [ ] Inngest function successfully receives firehose events and writes responses
- [ ] iPhone app authenticates via DID, sends message, receives agent response
- [ ] Second PDS (family member) federates with Joel's PDS via relay
- [ ] Data on three-body survives PDS container restart

## Notes

- NAS hostname: `three-body` (Asustor, 70TB)
- All PDS data stored on NAS, not Mac Mini SSD (durability + space)
- AT Protocol docs: https://atproto.com/specs/atp
- Lexicon spec: https://atproto.com/specs/lexicon
- PDS self-hosting: https://github.com/bluesky-social/pds
