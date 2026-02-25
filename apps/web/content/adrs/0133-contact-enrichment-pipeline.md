---
status: proposed
date: 2026-02-24
decision-makers: joel
---

# ADR-0133: Contact Enrichment Pipeline

## Context

Recent contact-prep work exposed the problem: creating a useful contact dossier requires searching 5+ data sources (Slack channels, Slack DMs, Roam archive, web/GitHub, Granola meetings, memory/Qdrant) and synthesizing results into a Vault contact file. Done manually, this is slow, inconsistent, and incomplete.

Contact enrichment should be a durable Inngest pipeline that fans out across all available sources, synthesizes results, and writes/updates the Vault contact file.

## Decision

### Event: `contact/enrich.requested`

```typescript
{
  name: "contact/enrich.requested",
  data: {
    name: string,              // "Sample Contact"
    vault_path?: string,       // "Contacts/Sample Contact.md" (if exists)
    hints?: {                  // Optional known identifiers to seed search
      slack_user_id?: string,
      github?: string,
      twitter?: string,
      email?: string,
      website?: string,
    },
    depth?: "quick" | "full",  // quick = Slack + memory only, full = all sources
  }
}
```

### Inngest Function: `contact-enrich`

Fan-out steps, each independent and failure-isolated:

1. **`search-slack`** — Find user in workspace, map all channels (cc-*, lc-*, dd-*, brain-*, DMs), pull recent DM history (last 30 messages)
2. **`search-slack-connect`** — Check external/Slack Connect users if not found in workspace
3. **`search-roam`** — Query Roam EDN archive for person pages, block mentions, relationship tags (collaborator/, client/, staff/)
4. **`search-web`** — Web search for name + known identifiers. GitHub profile, personal site, social presence, public projects
5. **`search-granola`** — Query Granola MCP for meetings involving this person (by name search)
6. **`search-memory`** — Qdrant semantic search for observations mentioning this person
7. **`search-typesense`** — Search indexed content (vault notes, channel messages, transcripts) for mentions
8. **`synthesize`** — Sonnet 4.6 takes all source results + existing contact file (if any), produces updated Vault contact markdown with:
   - Frontmatter (name, aliases, role, organizations, vip, channel IDs, tags)
   - Narrative summary
   - Contact channels (all discovered)
   - Projects (cross-referenced with ADRs and active work)
   - Key context (personality, working style, relationship history)
   - Recent activity timeline
9. **`write-vault`** — Write/update `~/Vault/Contacts/{name}.md`
10. **`notify`** — If VIP, push summary to Joel via gateway

### Flow Control

- Concurrency: 3 (don't overwhelm APIs)
- Steps 1-7 run in parallel (independent sources)
- Step 8 waits for all source steps
- Throttle Slack API calls (rate limits)
- Throttle Granola transcript fetches (aggressive rate limiting)

### Depth Modes

**quick** (~10s, ~$0.01): Slack + memory only. Good for real-time VIP detection.
**full** (~60s, ~$0.05): All 7 sources + web search + Sonnet synthesis. Good for new contacts or periodic refresh.

### Triggers

- Manual: `joelclaw enrich "<contact-name>"` (CLI command)
- Automatic: When a new VIP DM is detected from an unknown user (ADR-0132)
- Automatic: When `contact/enrich.requested` is fired from any pipeline
- Scheduled: Weekly refresh of all VIP contacts (cron)

### Skills Required

- `inngest-durable-functions` — function definition, step isolation
- `inngest-steps` — parallel fan-out with step.run per source
- `inngest-flow-control` — concurrency limits, throttling
- `inngest-events` — event schema, fan-out pattern

## Consequences

- New contacts go from "who is this?" to full dossier in ~60 seconds
- VIP contacts stay current via weekly refresh cron
- Enrichment quality is consistent — every contact gets the same source coverage
- Each source step can fail independently without blocking others
- Cost is bounded: ~$0.05/full enrichment, ~$3/month for weekly VIP refresh of 15 contacts
- Builds on ADR-0131 (channel intelligence) and ADR-0132 (VIP escalation)
- Person dossier skill (`person-dossier`) becomes the manual fallback / template reference
