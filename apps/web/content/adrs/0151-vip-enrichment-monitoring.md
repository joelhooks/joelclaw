---
status: proposed
date: 2026-02-26
decision-makers: [Joel Hooks]
tags: [contacts, vip, enrichment, monitoring, inngest]
---

# ADR-0151: VIP Contact Enrichment & Monitoring

## Context

We have 13+ contacts in `~/Vault/Contacts/`, several marked `vip: true`. The manual enrichment of Kent C. Dodds (Feb 26, 2026) took ~15 minutes of agent time and produced a comprehensive dossier: career timeline, teaching philosophy, podcast appearances with Joel, key relationships, audience reach, personal background. This level of depth is valuable for every VIP — it informs how Joel communicates, collaborates, and makes business decisions.

Currently, enrichment is either:
- **One-shot**: ADR-0133's `contact/enrich` event writes basic metadata (GitHub, Twitter, website, org) and stops
- **Manual**: Agent does deep research in-session (wasteful of session context)

Neither provides **ongoing monitoring** — we don't know when a VIP publishes a new course, gives a talk, gets mentioned in press, or changes roles.

## Decision

### 1. Deep Enrichment (one-time, per VIP)

Extend ADR-0133's contact enrichment pipeline with a `depth: "full"` option that runs the expanded playbook:

**Enrichment Steps** (documented from Kent C. Dodds process):

| Step | Source | What We Capture |
|---|---|---|
| 1. Web presence | `{name} + {org}` web search | Bio, role, location, personal details |
| 2. Podcast/interviews | `{name} podcast interview` web search | Appearance list, own podcasts, audiences |
| 3. Appearances with Joel | `kentcdodds.com/appearances` or equivalent | Direct collaboration history |
| 4. Career timeline | Interview transcripts (defuddle) | Origin story, career arc, key decisions |
| 5. GitHub profile | GitHub API | Repos, followers, orgs, contribution patterns |
| 6. X/Twitter profile | X API v2 | Bio, followers, recent tweets, engagement |
| 7. Podcast transcripts | defuddle on 2-3 key interviews | Teaching philosophy, values, personality |
| 8. Key relationships | Cross-reference contacts + transcripts | Who they work with, who they mention |
| 9. Content catalog | Website crawl | Courses, blog posts, open source projects |

**Output**: Enriched `~/Vault/Contacts/{name}.md` with sections:
- Background & Story (origin, career timeline)
- Teaching/Work Philosophy
- Key Relationships (cross-linked to other contacts)
- Audience & Reach (podcast count, social followers, conference circuit)
- Content/Products
- Podcast Appearances with Joel
- Recent Activity (timestamped)

### 2. Ongoing Monitoring (continuous, per VIP)

Set up persistent monitoring channels for each VIP:

| Channel | Tool | Signal |
|---|---|---|
| Google Alerts | joelclawbot Google account | Name mentions in news, blogs, press |
| X/Twitter list | joelclaw X account | Tweets, replies, engagement |
| GitHub activity | GitHub API (webhook or polling) | New repos, releases, major commits |
| Podcast feeds | RSS monitoring | New episodes (own podcast + appearances) |
| Website changes | Periodic defuddle + diff | New blog posts, course launches, bio changes |

**Delivery**: Monitoring signals fire Inngest events → `vip/activity` → gateway summarizes and surfaces to Joel when relevant (not every tweet — batched daily or on high-signal triggers like course launches, role changes, public statements).

**High-signal triggers** (immediate notification):
- New course or product launch
- Role change or job move
- Public mention of Joel, egghead, Skill, or partnership
- Fundraising/acquisition news
- Conference talk announcement

**Low-signal** (daily digest or weekly):
- Regular tweets
- Blog posts
- Open source activity
- Podcast appearances (unless mentioning Joel/egghead)

### 3. VIP Roster

VIPs are contacts with `vip: true` in frontmatter. Current VIPs:
- Kent C. Dodds
- (others TBD — review all contacts for VIP designation)

## Implementation

### Phase 1: Deep enrichment Inngest function
- Extend `contact/enrich` with `depth: "full"` parameter
- Implement the 9-step enrichment playbook as durable steps
- Write comprehensive vault note

### Phase 2: Google Alerts setup
- Use joelclawbot Google account to create alerts for each VIP name
- Forward alerts to a monitored inbox or webhook
- Inngest function to process alert emails → `vip/activity` events

### Phase 3: X/Twitter monitoring
- Create a private X list of VIP accounts
- Poll list timeline periodically (or use filtered stream if available)
- Classify tweets by signal level

### Phase 4: RSS + website monitoring
- Subscribe to VIP podcast RSS feeds
- Periodic defuddle of VIP websites → diff against last snapshot
- Fire events on changes

## Consequences

- Joel has deep context on every VIP before any interaction
- Business-relevant changes (launches, role moves) surface automatically
- Cross-referencing contacts reveals relationship patterns
- Monitoring cost is minimal (Google Alerts free, X API basic tier, GitHub free)
- Agent sessions don't burn context on manual research
- Privacy: monitoring only public information, no scraping private accounts
