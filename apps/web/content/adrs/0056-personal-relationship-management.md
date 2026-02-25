---
status: superseded
date: 2026-02-19
deciders: Joel
tags:
  - architecture
  - people
  - relationships
  - joelclaw
  - ports-and-adapters
---

# ADR-0056: Personal Relationship Management — People as First-Class Entities

## Context

joelclaw interacts with people across many channels: Granola meetings, Gmail, Google Calendar, Telegram, and eventually SMS/iMessage, LinkedIn, AT Proto social graph. Today, knowledge about people is scattered — meeting notes in Granola, email threads in Gmail, contact info in Google Contacts, chat history in Telegram. There's no unified view of a relationship.

The Granola meeting intelligence pipeline (ADR-0055) surfaces meeting participants and action items, but there's nowhere to accumulate knowledge about a person across channels. When Joel gets an email from someone he met last week, the agent has no memory of what was discussed in the meeting, what was promised, or what the relationship context is.

### Why Now

- Granola pipeline (ADR-0055) is the first channel adapter that surfaces people
- Gmail/Calendar/Contacts already accessible via `gog` CLI (ADR-0040)
- Telegram chat history is available via gateway
- The hexagonal architecture (ADR-0003, ADR-0045) gives us the pattern for multi-source integration
- Joel explicitly wants dossier-building and active relationship management

### What This Is NOT

- **Not a CRM with deals/pipelines.** This is personal relationship management, not sales.
- **Not outbound automation.** No auto-follow-ups or drip campaigns. Joel decides when to reach out.
- **Not social media monitoring.** No scraping LinkedIn or Twitter. Only channels joelclaw has authenticated access to.
- **Not a contact database.** Google Contacts already does that. This is the intelligence layer on top.

## Decision

Introduce **People** as a first-class entity in joelclaw with a hexagonal port/adapter architecture. Each communication channel feeds interactions into a unified person profile (dossier). Storage starts with Vault markdown notes + Qdrant semantic search, with a clear path to Postgres when relational queries demand it.

### Architecture

```
                    ┌─────────────────────┐
                    │   People Port        │
                    │   (interface)        │
                    │                     │
                    │  resolve(email)     │
                    │  upsert(person)     │
                    │  addInteraction()   │
                    │  getDossier(id)     │
                    │  search(query)      │
                    └──────┬──────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼───┐  ┌────▼───┐  ┌────▼───┐
         │ Vault   │  │ Qdrant │  │Postgres│
         │Adapter  │  │Adapter │  │Adapter │
         │ (v1)    │  │(search)│  │ (v2)   │
         └─────────┘  └────────┘  └────────┘
```

### Channel Adapters (Feeders)

Each channel adapter watches for interactions and feeds them into the People port:

| Channel | Adapter | Trigger | What It Captures |
|---------|---------|---------|------------------|
| Granola | `granola-cli` | `meeting/noted` event (ADR-0055) | Attendees, topics, action items, decisions, relationship dynamics |
| Gmail | `gog gmail` | Email check / `email/received` event | Correspondents, thread topics, commitments, tone |
| Calendar | `gog calendar` | Calendar sync / heartbeat | Meeting frequency, recurring 1:1s, who initiates |
| Contacts | `gog contacts` | Bootstrap / periodic sync | Base identity: name, email, phone, company, role |
| Telegram | Gateway messages | Inbound messages | Chat context, requests, shared links |
| Future | SMS, LinkedIn, AT Proto | TBD | TBD |

### Person Data Model

```typescript
interface Person {
  id: string;                    // deterministic from primary email
  name: string;
  emails: string[];              // all known emails
  phones?: string[];
  company?: string;
  role?: string;
  tags: string[];                // e.g. "accountant", "collaborator", "friend"
  first_seen: string;            // ISO date
  last_interaction: string;      // ISO date
  interaction_count: number;
  notes: string;                 // free-form relationship notes (agent + Joel)
}

interface Interaction {
  person_id: string;
  channel: "granola" | "email" | "calendar" | "telegram" | "sms" | string;
  timestamp: string;
  summary: string;               // 1-3 sentence summary
  topics: string[];
  action_items?: string[];       // things promised or assigned
  sentiment?: "positive" | "neutral" | "difficult";
  source_link?: string;          // link back to Granola note, email thread, etc.
}
```

### Identity Resolution

The hard problem. People appear as different identities across channels:
- `<redacted-email>` in email, `Joel Hooks` in Granola, `@joelhooks` in Telegram

Resolution strategy (ordered):
1. **Email exact match** — primary key, most reliable
2. **Email domain + name fuzzy match** — same company, similar name
3. **Google Contacts enrichment** — `gog contacts search` for phone/email cross-ref
4. **Manual linking** — agent proposes, Joel confirms via Todoist async channel (ADR-0047)

Unresolved identities go to a review queue, not auto-merged. False merges are worse than duplicates.

### Storage: Phase 1 (Vault + Qdrant)

**Vault notes** (`~/Vault/Resources/people/`):
- One markdown note per person with YAML frontmatter
- Interaction log as append-only sections
- Obsidian-searchable, human-readable, iCloud-synced

```markdown
---
type: person
name: Deborah Chen
emails:
  - <redacted-email>
company: Chen Accounting
role: Accountant
tags: [accountant, business]
first_seen: 2025-06-15
last_interaction: 2026-02-05
interaction_count: 12
---

# Deborah Chen

Joel's accountant. Handles egghead/Skill Recordings taxes and bookkeeping.

## Interactions

### 2026-02-05 — Granola
Egghead business wind-down and skill recordings strategy.
Action items: Run Amex through AI analysis, call JustWorks about API.
[Meeting link](https://notes.granola.ai/d/84a43303-...)
```

**Qdrant**: Interaction summaries embedded for semantic search ("who did I talk to about JustWorks?", "when did we last discuss pricing?").

**Vault needs git**: People dossiers contain relationship intelligence that must be version-controlled and backed up beyond iCloud sync. Vault should be initialized as a private git repo (separate concern, not blocked by this ADR).

### Storage: Phase 2 (Postgres)

When relational queries outgrow markdown:
- "Who haven't I talked to in 30 days?"
- "Who do I owe a follow-up?"
- "Show me everyone at Company X I've interacted with"
- Interaction frequency trends, relationship health scores

Postgres with full-text search + Qdrant for semantic. Vault notes become a read-only view generated from the database. The port interface stays the same — only the adapter changes.

## Alternatives Considered

### Use Google Contacts as the people store (rejected)
Google Contacts is a phone book, not a relationship intelligence system. No interaction history, no semantic search, no structured notes. It's a source adapter, not the store.

### Use Obsidian Dataview as the query engine (rejected)
Dataview is powerful for simple queries but can't do fuzzy identity resolution, cross-channel correlation, or semantic search. It's a nice UI layer on top of Vault notes but not the intelligence engine.

### Build on an existing CRM (rejected)
Personal CRM tools (Monica, Clay, Dex) are SaaS products that own the data. joelclaw's philosophy is local-first, agent-operated. The data lives in the Vault and Qdrant, not a third-party service.

## Consequences

### Positive
- Joel has a unified view of every relationship across all channels
- Agent can provide context before meetings ("last time you talked to X, you discussed Y")
- Action items and commitments are tracked per-person, not per-channel
- Semantic search across all interactions ("who mentioned Kubernetes?")

### Negative
- Identity resolution is hard — expect manual review queue early on
- Storage migration from Vault to Postgres is a future cost
- Privacy: dossiers contain sensitive relationship data — Vault must not be public
- Multiple channel adapters to build and maintain

### Follow-up Tasks
- [ ] Accept ADR-0055 and update it to feed into People port
- [ ] Define People port interface in TypeScript
- [ ] Build Vault adapter (v1 storage)
- [ ] Build Google Contacts bootstrap adapter
- [ ] Build Granola channel adapter (extends ADR-0055 pipeline)
- [ ] Build Gmail channel adapter
- [ ] Add identity resolution logic
- [ ] Initialize Vault as private git repo
- [ ] Add interaction embeddings to Qdrant
- [ ] Create `joelclaw people` CLI commands (search, dossier, interactions)

## Implementation Plan

### Affected Paths
- `packages/system-bus/src/inngest/functions/meeting-analyze.ts` — add person upsert after analysis
- `packages/system-bus/src/people/` — new directory for port + adapters
- `packages/system-bus/src/people/port.ts` — People port interface
- `packages/system-bus/src/people/vault-adapter.ts` — Vault markdown storage
- `packages/system-bus/src/people/qdrant-adapter.ts` — semantic search over interactions
- `packages/system-bus/src/people/identity.ts` — resolution logic
- `packages/cli/src/commands/people.ts` — CLI commands
- `~/Vault/Resources/people/` — dossier notes

### Pattern
- Hexagonal: port interface owned by the domain, adapters per storage/channel
- Channel adapters are Inngest function steps, not standalone services
- Identity resolution is a utility consumed by all channel adapters
- Vault notes follow Obsidian conventions (ADR-0003, obsidian-markdown skill)

### Verification
- [ ] `joelclaw people search "accountant"` returns Deborah's dossier
- [ ] Granola meeting creates/updates person records for all attendees
- [ ] Same person from email and meeting resolves to single dossier
- [ ] Interaction history spans channels chronologically
- [ ] Qdrant semantic search returns relevant interactions
- [ ] Vault notes render correctly in Obsidian
