---
name: email-triage
description: "Triage Joel's email inboxes via the joelclaw email CLI. Scan, categorize, archive noise, surface actionable items, and draft replies. Use when: 'check my email', 'scan inbox', 'triage email', 'what needs a reply', 'clean up inbox', 'archive junk', 'email summary', 'anything important in email', or any request involving email inbox review or cleanup."
---

# Email Triage

Scan Joel's email inboxes (Front), triage conversations by importance, archive noise, and surface items needing attention. All operations use the `joelclaw email` CLI.

## Triage Workflow

### 1. Load inbox state

```bash
joelclaw email inbox -n 50
```

Parse the JSON result. Each conversation has: `id`, `subject`, `from` (name + email), `date`, `status`, `tags`.

For specific queries:
```bash
joelclaw email inbox -q "is:open is:unread" -n 50
joelclaw email inbox -q "is:open after:2026-02-15" -n 50
```

### 2. Categorize using inference

Read each conversation and **decide** its category based on sender, subject, and context. Do NOT use hardcoded domain lists. Use judgment:

- **Reply needed** — Real people expecting a response. Colleagues, collaborators, friends, business contacts with personal messages. Look for reply threads (`Re:`), questions, invitations to specific meetings, requests.
- **Read later** — Interesting content worth saving. Newsletters Joel subscribes to intentionally (The Information, Astral Codex Ten, Lenny's Newsletter), industry news, technical deep-dives.
- **Actionable** — Requires action but not a reply. Bills, security alerts, expiring trials, tax documents, delivery updates for real orders, calendar invites needing RSVP.
- **Archive** — No value. Marketing spam, promotional offers, cold outreach, duplicate notifications, resolved alerts, automated reports nobody reads, vendor upsells.

### 3. Present triage summary

Organize findings for Joel. Lead with what matters:

```
## 🔴 Reply needed (N)
- **Name** — Subject (why it needs a reply)

## ⚡ Actionable (N)  
- **Sender** — Subject (what action)

## 📖 Read later (N)
- **Source** — Subject

## 🗑️ Archive candidates (N)
- Count by type (e.g., "14 marketing, 8 CI failures, 5 duplicate notifications")
```

### 4. Execute decisions

Archive noise:
```bash
joelclaw email archive --id cnv_xxx
```

Bulk archive with dry-run first:
```bash
joelclaw email archive-bulk -q "is:open before:2026-01-18"        # dry run
joelclaw email archive-bulk -q "is:open before:2026-01-18" --confirm  # execute
```

Read a conversation before deciding:
```bash
joelclaw email read --id cnv_xxx
```

## Key Context

- Joel has 8 Front inboxes across joel@egghead.io, joelhooks@gmail.com, joel@skillrecordings.com, joel@badass.dev, joel.hooks@vercel.com, LinkedIn, DMs, and Inngest
- `joelclaw email inboxes` lists them all
- Front search supports: `is:open`, `is:archived`, `is:unread`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `tag:"name"`, free text
- Joel's teammate ID: `tea_hjx3`
- The CLI handles Front API auth automatically via `secrets lease front_api_token`
- Draft-then-approve for replies — never send directly

## Signals for "Reply Needed"

These are heuristics, not rules. Use judgment for each:

- `Re:` prefix + real person sender (not a bot/noreply)
- `[aih]` prefix — AI Hero collaboration (Matt Pocock, Alex Hillman)
- Direct questions in subject line
- Meeting invitations from known contacts
- Threads where Joel was the last sender and someone replied
- Slack notification summaries (may indicate missed conversations worth checking)

## Signals for "Archive"

- `noreply@`, `no-reply@`, `notifications@` senders with no actionable content
- Marketing subject patterns: "LAST chance", "% off", "deal", "unlock", "limited time"
- Duplicate conversations (same subject from same sender — archive all but most recent)
- Resolved monitoring alerts (`RESOLVED` in subject)
- CI failure notifications older than 24h (stale — either fixed or won't be)
- Cold outreach from unknown senders with sales language
