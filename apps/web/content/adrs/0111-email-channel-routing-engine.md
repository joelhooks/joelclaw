---
status: proposed
date: 2026-02-22
decision-makers: joel
tags:
  - email
  - channels
  - inngest
  - front
  - convex
  - automation
---

# ADR-0111: Email Channel Routing Engine

## Context

The system currently has two hardcoded email processing paths:

1. **VIP pipeline** (`vip-email-received.ts`) — matches sender names from a hardcoded list + env var, runs Opus analysis, creates todos, searches Granola/memory/GitHub, notifies gateway. Single pipeline, no configurability.

2. **Email triage** (`check-email.ts`) — batch polling (2h cooldown), LLM-classifies all unread into archive/label/escalate. No project awareness, no doc extraction, no vault integration.

Joel needs a third behavior: emails tagged `[aih]` or addressed to `bricks@aihero.dev` should get priority processing — extracting Google Doc/Sheet links, downloading them, correlating with the `~/Vault/Resources/ai-hero/` folder, creating todos, tracking deadlines, and sending nudges. This is a **pattern** that will repeat for every active project (AI Hero today, future Badass Courses partnerships, egghead operations).

Hardcoding another special case is the wrong move. The VIP pipeline is already 600+ lines of bespoke code. A third copy would be unmaintainable.

## Decision

Build a **channel routing engine** that replaces both the VIP pipeline and adds project-aware email processing. Channels are the single mechanism for email → action routing.

### Channel Model (Convex)

```typescript
// convex/schema.ts addition
emailChannels: defineTable({
  name: v.string(),           // "ai-hero", "vip-people", "egghead-ops"
  displayName: v.string(),    // "AI Hero Launch"
  enabled: v.boolean(),
  priority: v.number(),       // 1=highest, lower numbers evaluated first

  // Matchers (OR logic — any match triggers the channel)
  matchers: v.object({
    tags: v.optional(v.array(v.string())),            // Front tags
    subjectPatterns: v.optional(v.array(v.string())), // regex patterns
    senderPatterns: v.optional(v.array(v.string())),  // name or email substring matches
    toAddresses: v.optional(v.array(v.string())),     // recipient address matches
  }),

  // Actions (ordered pipeline)
  actions: v.array(v.object({
    type: v.string(),         // action type identifier
    config: v.optional(v.any()),  // action-specific config
    enabled: v.boolean(),
  })),

  // Channel-specific config
  vaultFolder: v.optional(v.string()),    // "Resources/ai-hero"
  todoistProject: v.optional(v.string()), // project ID or name
  notifyGateway: v.boolean(),
  llmModel: v.optional(v.string()),       // override model per channel

  // Metadata
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_enabled", ["enabled", "priority"])
  .index("by_name", ["name"]),
```

### Action Types (v1)

| Action | What it does | Config |
|--------|-------------|--------|
| `extract-google-links` | Scan message body for Google Doc/Sheet/Drive links | — |
| `download-gdocs` | Export linked docs via `gog` CLI, store in vault folder | `{ format: "txt" }` |
| `vault-sync` | Write extracted content as Vault notes, update index | `{ folder: "Resources/ai-hero" }` |
| `correlate-vault` | Semantic search existing vault notes for related content | `{ folder, limit }` |
| `llm-triage` | Sonnet classifies urgency, extracts decisions/blockers/asks | `{ model }` |
| `create-todos` | Generate and create Todoist tasks from LLM analysis | `{ project, labels }` |
| `notify-gateway` | Push summary to gateway for Telegram delivery | — |
| `search-granola` | Find related meeting notes by sender/subject | `{ ranges }` |
| `search-memory` | Recall related observations from semantic memory | `{ limit }` |
| `nudge-schedule` | Track deadlines mentioned in thread, schedule reminder events | `{ defaultLeadDays }` |
| `deadline-track` | Extract dates/deadlines, store in channel state | — |
| `draft-reply` | Generate reply draft, store for Joel's review | `{ model, tone }` |

### Routing Flow

```
Front webhook
  → front/message.received (existing)
  → channel-router function (NEW)
    → query Convex for enabled channels, ordered by priority
    → for each channel, evaluate matchers against message
    → first match wins (or: all matches fire, configurable)
    → emit channel-specific event: email/channel.matched
      { channelName, channelId, messageData, matchedBy }
  → channel-processor function (NEW)
    → triggered by email/channel.matched
    → execute action pipeline in order
    → each action is a step (durable, retryable)
    → emit email/channel.processed when done
```

### Migration Path

1. Existing VIP pipeline becomes a channel with sender-name matchers and the current Opus escalation flow preserved as action config.

2. AI Hero becomes a channel with tag, subject-pattern, and to-address matchers. Full action pipeline: extract links → download docs → vault sync → correlate → triage → todos → nudges → deadlines → notify.

3. Old `vip-email-received.ts` gets deprecated after channel equivalence is verified.

(Specific matcher values — email addresses, names, tag strings — live in Convex only, not in this document or the public repo.)

### CLI Surface

```bash
joelclaw channels list                    # show all channels
joelclaw channels show ai-hero            # detail view
joelclaw channels add <name>              # interactive create
joelclaw channels edit <name>             # modify
joelclaw channels disable <name>          # soft disable
joelclaw channels test <name> <conv-id>   # dry-run against a real conversation
joelclaw channels history <name>          # recent matches + actions taken
```

## Privacy Constraints

This system routes real business email — names, addresses, financial discussions, partnership terms, customer data. Privacy is a first-class design constraint, not an afterthought.

### Hard Rules

1. **No PII in the public repo.** Channel config lives in Convex (private). No email addresses, sender names, project identifiers, or matcher patterns in `joelclaw` source code. The worker code is generic — it reads config at runtime.

2. **No email content in OTEL/telemetry.** Trace metadata can include: channel name, action type, step duration, success/failure. It MUST NOT include: message body, subject lines, sender addresses, extracted doc content. Redact before emitting.

3. **No email content in system logs.** `slog` entries reference channel name + conversation ID only. The conversation ID is an opaque Front reference — useless without Front API access.

4. **Vault notes are local-only.** Downloaded docs and vault-sync output go to `~/Vault` which is not version-controlled or synced to any public surface. The Convex `vaultFolder` field stores a relative path, not content.

5. **Convex access control.** Channel table is internal-only — no public queries. Only the worker (authenticated) and joelclaw.com (authenticated admin routes) can read/write channels. No anonymous access.

6. **Gateway notifications are private.** Telegram delivery is Joel-only. Gateway summaries can include sender names and subjects since the delivery channel is private. But gateway payloads should still avoid dumping full message bodies — summarize, don't forward.

7. **Google Doc downloads use Joel's auth.** `gog` CLI runs as `joelhooks@gmail.com`. Downloaded docs are stored in Vault, not cached in Redis or Convex. Doc IDs for dedup can be stored in Redis (opaque hashes, not titles).

### Action-Level Privacy

| Action | What's stored | What's NOT stored |
|--------|--------------|-------------------|
| `extract-google-links` | Doc IDs (for dedup) | Link URLs, doc titles |
| `download-gdocs` | Files in ~/Vault only | Nothing in Convex/Redis/OTEL |
| `vault-sync` | Local .md files | Content never leaves machine |
| `llm-triage` | Trace: model, duration, token count | Trace: NOT prompt, NOT response |
| `create-todos` | Task in Todoist (private) | Task content not in OTEL |
| `notify-gateway` | Telegram message (private) | Not logged to OTEL |
| `correlate-vault` | Match scores only | Not matched content |

## Consequences

### Good
- One routing mechanism instead of N hardcoded pipelines
- New project channels in minutes (Convex insert), not code deploys
- Action composition — mix and match per channel
- Web UI for channel management from day one (Convex dashboard + joelclaw.com/system)
- Existing VIP logic preserved as config, not lost

### Bad
- Convex query on every inbound email (should be fast, but adds a dependency)
- Action implementations need to be modular — refactoring 600 lines of VIP into pluggable steps is real work
- Google Doc download requires `gog` CLI + auth — worker environment needs access

### Risks
- Matcher overlap: two channels match the same email. Mitigation: priority ordering + "first match wins" default, with option for "all matches fire" per channel.
- Action failures: one step fails, rest of pipeline stalls. Mitigation: Inngest step retries + `continueOnError` flag per action.
- Rate limits: aggressive doc downloading on every email. Mitigation: dedup by doc ID (Redis set of recently-downloaded doc IDs).

## Implementation Order

1. Convex schema + seed `ai-hero` and `vip-people` channels
2. Channel router Inngest function (matcher evaluation)
3. Channel processor Inngest function (action pipeline executor)
4. Port VIP actions into modular action implementations
5. Add new actions: `extract-google-links`, `download-gdocs`, `vault-sync`
6. CLI commands: `joelclaw channels list/show/add/edit/disable`
7. Wire into `front-message-received-notify` (replace hardcoded VIP check)
8. Deprecate `vip-email-received.ts`
9. Web UI surface on joelclaw.com/system/channels
