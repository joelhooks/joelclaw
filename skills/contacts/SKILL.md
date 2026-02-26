---
name: contacts
displayName: Contacts
description: "Add, enrich, and manage contacts in Joel's Vault. Fire the Inngest enrichment pipeline for full multi-source dossiers, or create quick contacts manually. Use when: 'add a contact', 'enrich this person', 'who is X', 'VIP contact', 'update contact', or any task involving the Vault/Contacts directory."
version: 1.0.0
author: joel
tags: [joelclaw, contacts, vault, enrichment, people]
---

# Contacts

Manage contacts in `~/Vault/Contacts/`. Each contact is a markdown file with YAML frontmatter.

## Contact File Location

```
~/Vault/Contacts/<Name>.md
```

Index file: `~/Vault/Contacts/index.md` — wikilink list of all contacts.

## Frontmatter Schema

```yaml
---
name: Full Name
aliases: [nickname, handle]
role: Current Role / Title
organizations: [Org1, Org2]
vip: true  # or false
slack_user_id: U0XXXXXXX
slack_dm_channel: D0XXXXXXX  # null if unknown
website: https://example.com
github: username
twitter: handle
email: user@example.com
tags: [vip, instructor, creator, family, employee]
---
```

## Sections

```markdown
# Name

## Contact Channels
- Slack, email, social handles, website

## Projects
- Active projects, courses, collaborations

## Key Context
- Relationship notes, working style, history

## Recent Activity
- YYYY-MM-DD | channel | summary
```

See `~/Vault/Contacts/Matt Pocock.md` for a fully enriched example.

## Adding a Contact

### Option 1: Fire the Enrichment Pipeline (preferred)

Send an Inngest event. The `contact-enrich` function fans out across 7 sources (Slack, Roam, web/GitHub, Granola, Qdrant memory, Typesense), synthesizes with LLM, and writes the Vault file.

```bash
# Via curl (CLI has OTEL import bug under Bun v1.3.9)
curl -s -X POST http://localhost:8288/e/37aa349b89692d657d276a40e0e47a15 \
  -H "Content-Type: application/json" \
  -d '[{
    "name": "contact/enrich.requested",
    "data": {
      "name": "Person Name",
      "depth": "full",
      "hints": {
        "slack_user_id": "U0XXXXXXX",
        "github": "username",
        "twitter": "handle",
        "email": "user@example.com",
        "website": "https://example.com"
      }
    },
    "ts": EPOCH_MS
  }]'
```

**Depth modes:**
- `full` (~60s, ~$0.05): All 7 sources + LLM synthesis. Use for new contacts or periodic refresh.
- `quick` (~10s, ~$0.01): Slack + memory only. Good for real-time VIP detection.

**Hints are optional but help:** Any known identifiers (Slack ID, GitHub, email, Twitter, website) seed the search and improve results.

### Option 2: Quick Manual Create

For simple contacts where enrichment is overkill:

```markdown
---
name: Person Name
aliases: []
role: Role
organizations: [Org]
vip: false
slack_user_id: null
website: null
github: null
twitter: null
email: null
tags: [tag1]
---

# Person Name

## Contact Channels
- ...

## Key Context
- ...
```

Write to `~/Vault/Contacts/Person Name.md` and add `[[Person Name]]` to `index.md`.

## Updating Contacts

Re-run enrichment with the existing vault path:

```json
{
  "name": "contact/enrich.requested",
  "data": {
    "name": "Person Name",
    "vault_path": "Contacts/Person Name.md",
    "depth": "full"
  }
}
```

The synthesizer merges new data with existing content — it won't discard existing facts unless contradicted.

## VIP Contacts

Mark `vip: true` in frontmatter. VIPs:
- Get notified to Joel via gateway after enrichment
- Are refreshed weekly via scheduled cron
- Have priority in channel intelligence pipeline (ADR-0131, ADR-0132)

## Resolving Unknown People

When you encounter a Slack user ID (`<@U0XXXXXXX>`):

```bash
# Lease token and look up profile
SLACK_USER=$(secrets lease slack_user_token --ttl 5m)
curl -s "https://slack.com/api/users.info?user=U0XXXXXXX" \
  -H "Authorization: Bearer $SLACK_USER" | jq '.user.real_name, .user.profile.email'
secrets revoke --all
```

Then fire enrichment with the resolved name and hints.

## Inngest Function

- Function: `contact-enrich` (`packages/system-bus/src/inngest/functions/contact-enrich.ts`)
- Event: `contact/enrich.requested`
- ADR: `~/Vault/docs/decisions/0133-contact-enrichment-pipeline.md`
- Concurrency: 3 max
- Sources: Slack, Slack Connect, Roam archive, GitHub/web, Granola meetings, Qdrant memory, Typesense

## Privacy

- Contact files are in Vault (private, not in public repos)
- Slack data stays private — never surface in public content
- Email/phone are stored for Joel's reference only
