---
status: proposed
date: 2026-02-24
decision-makers: joel
---

# ADR-0132: VIP DM Escalated Handling

## Context

The Unified Channel Intelligence Pipeline (ADR-0131) classifies all Slack messages with Haiku (~$0.001/msg) for signal/noise routing. However, DMs from VIP contacts (tagged `vip: true` in Vault contacts) carry significantly higher signal density and relationship stakes. A message from Kent about MEGA content alignment or Grzegorz about cohort scheduling needs richer understanding than a channel noise classifier provides.

## Decision

VIP DMs receive escalated classification:

### 1. VIP Detection
- On ingest, check if the Slack user ID maps to a Vault contact with `vip: true`
- VIP contacts store `slack_user_id` and `slack_dm_channel` in frontmatter
- Bot DMs with Joel are always VIP (Joel is always VIP to himself)

### 2. Escalated Classification (Sonnet 4.6 via OpenRouter)
- VIP messages skip Haiku classification
- Classified by **Sonnet 4.6** with enriched context window:
  - Full Vault contact dossier (projects, recent activity, key context)
  - Related project state (e.g., MEGA status, agreements, open threads)
  - Recent DM history (last 20 messages for thread continuity)
  - Active Granola meeting summaries if recent (<24h)
- Classification output:
  - `urgency`: immediate / today / this_week / fyi
  - `topics`: array of topic tags
  - `action_required`: boolean — does Joel need to respond/act?
  - `suggested_context`: what Joel should know before responding
  - `related_contacts`: other VIPs involved in the thread
  - `project_refs`: linked projects/ADRs

### 3. Routing
- `immediate` + `action_required` → Push to active channel (Telegram/Discord) with full context brief
- `today` → Include in next digest with priority placement
- `this_week` / `fyi` → Index and surface in daily briefing

### 4. Cost Model
- Sonnet 4.6 via OpenRouter: ~$0.01-0.03 per VIP message (vs $0.001 Haiku)
- Expected VIP volume: <50 messages/day across all VIPs
- Monthly cost ceiling: ~$30-45 for VIP classification
- Worth it: one missed VIP message costs more than a year of classification

## VIP Contact Registry

Initial VIPs (from Vault contacts with `vip: true`):
- Kent C. Dodds (`U030CU0CN`) — MEGA instructor, EpicWeb
- Grzegorz Róg (`U03G1P81FBJ`) — MEGA producer, Brave Courses

Registry grows as contacts are tagged VIP. No hard limit.

## Implementation

### Inngest Function: `slack-vip-dm-classify`
- Trigger: `channel/slack.message.received` where `data.is_vip == true`
- Steps:
  1. `load-contact` — Read Vault contact markdown
  2. `load-project-context` — Query Typesense for related project docs
  3. `load-dm-history` — Fetch last 20 messages from Slack API
  4. `classify` — Sonnet 4.6 via OpenRouter with assembled context
  5. `route` — Push/digest/index based on classification
  6. `update-contact` — Append to contact's recent activity

### Pre-requisites
- ADR-0131 message ingest pipeline (provides the trigger event)
- Vault contacts with `vip: true` and `slack_user_id`
- OpenRouter API access (already available via `openrouter_api_key`)

## Consequences

- VIP messages get 10-30x richer classification than standard channels
- Joel gets contextual briefs ("Kent is asking about X, which relates to the MEGA timeline you discussed yesterday")
- Cost is bounded and proportional to relationship value
- Non-VIP messages continue on Haiku path unchanged
- Contact dossiers become living documents updated by the pipeline
