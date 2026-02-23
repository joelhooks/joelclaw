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

# ADR-0111: Channel Routing Engine (Conversations + Events)

## Context

The joelclaw event bus handles 101 event types across 33 source namespaces — Front email, GitHub webhooks, Todoist, Vercel deploys, calendar, voice transcripts, agent loops, memory pipeline, and more. Every event flows through Inngest.

Currently, enhanced processing for specific events is hardcoded:

1. **VIP email pipeline** (`vip-email-received.ts`) — matches sender names from a hardcoded list, runs Opus analysis, creates todos, searches Granola/memory/GitHub. 600+ lines of bespoke code for one use case.

2. **Email triage** (`check-email.ts`) — batch polling, LLM-classifies all unread. No project awareness, no doc extraction, no vault integration.

3. Various other Inngest functions that react to specific events with hardcoded logic.

Joel needs enhanced monitoring for `[aih]` tagged emails — extracting Google Doc/Sheet links, downloading them, correlating with vault, creating todos, tracking deadlines, sending nudges. But this is not email-specific. The same pattern applies to:

- **GitHub**: PRs from a specific repo → run tests, create review todos, notify
- **Todoist**: task completed in a project → update vault status, trigger next action
- **Vercel**: deploy failed for a specific app → diagnose, create fix task, alert
- **Calendar**: meeting with specific attendees → pull prep docs, create agenda todos
- **Agent loops**: story completed → update project tracker, correlate with PRD

Hardcoding another special case per source is the wrong architecture. The system already routes events — it just lacks configurable enhanced processing on top.

## Decision

Build a **channel routing engine** that operates on the existing event bus. Channels define matchers against any event type and trigger configurable action pipelines. This is the single mechanism for "when X happens, do Y" — replacing hardcoded pipelines with composable, runtime-configurable channels.

### Channel Model (Convex)

```typescript
// convex/schema.ts addition
channels: defineTable({
  name: v.string(),           // "ai-hero", "vip-people", "deploys-web"
  displayName: v.string(),    // "AI Hero Launch"
  enabled: v.boolean(),
  priority: v.number(),       // 1=highest, lower numbers evaluated first

  // Event source matching
  eventPatterns: v.array(v.string()),  // glob/prefix: "front/*", "github/pr.*", "vercel/deploy.failed"

  // Data matchers (evaluated against event.data, OR logic)
  matchers: v.optional(v.object({
    // String field matchers — key is the event.data field path, value is pattern
    // e.g. { "subject": "\\[aih\\]", "from": "alex" }
    fieldPatterns: v.optional(v.record(v.string(), v.string())),
    // Exact value matchers
    fieldEquals: v.optional(v.record(v.string(), v.string())),
    // Array-contains matchers (e.g. tags contains "aih")
    fieldContains: v.optional(v.record(v.string(), v.string())),
  })),

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

The key generalization: `eventPatterns` matches against the Inngest event name (e.g. `front/message.received`, `github/pr.opened`, `vercel/deploy.failed`), and `matchers` operates on `event.data` fields regardless of source. Same channel can match multiple event types.

### Event Cache Layer (Typesense + Redis)

Every event that flows through the bus should be indexed locally so we never re-hit external APIs for historical lookups. This is the same pattern as `vault_notes`, `otel_events`, `memory_observations` — Typesense is already the unified search layer (ADR-0082).

**Typesense collections — the conversation index:**

All conversational and event data indexed locally. Query any of it with `joelclaw search`. Never re-hit external APIs for historical lookups.

| Collection | Source | Indexed via | Notes |
|-----------|--------|------------|-------|
| `front_messages` | Front email | `front/message.received` webhook | Full thread history, attachments noted |
| `granola_meetings` | Granola | Nightly sync via `granola meetings` CLI | Transcripts, summaries, participants, action items. Backfill existing. Granola rate-limits aggressively — index once, search forever |
| `voice_transcripts` | System voice | `voice/call.completed` event | Collection exists but empty — wire up |
| `telegram_messages` | Telegram | `telegram/callback.received` webhook | Gateway conversations |
| `imessage_threads` | iMessage | Periodic sync via `imsg` CLI | Opt-in per contact/thread |
| `session_transcripts` | Pi/Claude/Codex sessions | `session/observation.noted` + compaction | Session summaries + key observations (already partially covered by `memory_observations`) |
| `github_events` | GitHub | `github/*` webhooks | PR/issue/deploy history |
| `todoist_events` | Todoist | `todoist/*` webhooks | Task lifecycle |

The shared principle: **every conversation or event is indexed on arrival (or periodic sync for pull-based sources). The channel router matches against Typesense, not external APIs.**

Schema for `front_messages` (example):

```typescript
{
  name: "front_messages",
  fields: [
    { name: "id", type: "string" },                    // Front message ID
    { name: "conversationId", type: "string", facet: true },
    { name: "subject", type: "string" },
    { name: "from", type: "string", facet: true },
    { name: "fromName", type: "string", facet: true },
    { name: "bodyPlain", type: "string" },              // searchable body
    { name: "tags", type: "string[]", facet: true },
    { name: "isInbound", type: "bool", facet: true },
    { name: "timestamp", type: "int64", sort: true },
    { name: "channelsMatched", type: "string[]", facet: true },  // which channels fired
    { name: "embedding", type: "float[]", embed: {      // auto-embed for semantic search
        from: ["subject", "bodyPlain"],
        model_config: { model_name: "ts/all-MiniLM-L12-v2" }
      }
    },
  ],
  default_sorting_field: "timestamp",
}
```

**Redis for hot state:**
- `channel:{name}:last-seen` — timestamp of last matched event (TTL: none)
- `channel:{name}:doc-dedup` — SET of recently-downloaded Google Doc IDs (TTL: 7d)
- `channel:{name}:stats` — HASH with match count, action success/fail counts (TTL: 30d)

**Flow:** webhook → Inngest event → index to Typesense (always, unconditionally) → channel router evaluates → channel processor runs actions. The indexing happens before routing — every event is preserved regardless of whether any channel matches.

This means `joelclaw search "ai hero alex"` finds email threads, meeting transcripts, Telegram conversations, and voice notes — all without touching any external API. Channel actions like `correlate-vault` can query across all conversation collections to find related context.

**Granola-specific notes:** Granola has aggressive rate limits (hourly+ cooldown on transcript pulls). Current state: we hit rate limits today pulling 6 meetings manually. With a nightly sync indexing all new meetings into Typesense, we'd never need to hit Granola's API in real-time again. The `search-granola` channel action becomes a Typesense query against `granola_meetings`, not a CLI call.

### Action Types (v1)

Actions are source-agnostic. They operate on the event data + channel config.

| Action | What it does | Config | Works with |
|--------|-------------|--------|-----------|
| `extract-google-links` | Scan event data for Google Doc/Sheet/Drive URLs | — | any event with body/text fields |
| `download-gdocs` | Export linked docs via `gog` CLI, store in vault folder | `{ format }` | follows extract-google-links |
| `vault-sync` | Write/update Vault notes from extracted content | `{ folder }` | any event with content |
| `correlate-vault` | Semantic search existing vault notes for related content | `{ folder, limit }` | any event |
| `llm-triage` | LLM classifies urgency, extracts decisions/blockers/asks | `{ model }` | any event |
| `create-todos` | Generate Todoist tasks from LLM analysis | `{ project, labels }` | follows llm-triage |
| `notify-gateway` | Push summary to gateway for Telegram delivery | `{ template }` | any event |
| `search-granola` | Find related meeting notes by entity/topic extraction | `{ ranges }` | any event |
| `search-memory` | Recall related observations from semantic memory | `{ limit }` | any event |
| `nudge-schedule` | Track deadlines, schedule Inngest reminder events | `{ leadDays }` | any event with dates |
| `deadline-track` | Extract dates/deadlines, store in channel state | — | any event |
| `draft-reply` | Generate reply draft, store for review | `{ model, tone }` | email events |
| `run-command` | Execute a CLI command with event data interpolation | `{ command, args }` | any event |
| `emit-event` | Emit a new Inngest event (fan-out/chaining) | `{ eventName }` | any event |

### Routing Flow

```
Any Inngest event (front/*, github/*, todoist/*, vercel/*, etc.)
  → channel-router function (NEW, triggered by wildcard or explicit list)
    → query Convex for enabled channels, ordered by priority
    → for each channel:
      1. does event name match any eventPattern? (glob match)
      2. does event.data satisfy matchers? (field patterns/equals/contains)
    → all matching channels fire (not first-match-wins — events can be relevant to multiple projects)
    → emit per-match: channel/event.matched
      { channelName, channelId, originalEvent, matchedBy }
  → channel-processor function (NEW)
    → triggered by channel/event.matched
    → load channel config from Convex
    → execute action pipeline in order
    → each action is an Inngest step (durable, retryable, individually timed)
    → emit channel/event.processed when done
```

The router is a single function that evaluates all channels against every event. Convex query is cached per invocation (channels change rarely). The processor is generic — it doesn't know or care whether the source was email, GitHub, or a cron job.

### Migration Path

1. **VIP email** → channel matching `front/message.received` with sender-pattern matchers. Actions: search-granola, search-memory, llm-triage (with Opus escalation config), create-todos, notify-gateway. Replaces `vip-email-received.ts`.

2. **AI Hero** → channel matching `front/message.received` with tag + subject + to-address matchers. Actions: extract-google-links, download-gdocs, vault-sync, correlate-vault, llm-triage, create-todos, nudge-schedule, deadline-track, notify-gateway.

3. **Future channels** (examples, not commitments):
   - GitHub PRs on course-builder → channel matching `github/pr.opened` + repo matcher → create-todos, notify-gateway
   - Vercel deploy failures → channel matching `vercel/deploy.failed` → llm-triage, create-todos, notify-gateway
   - Calendar meetings with specific attendees → channel matching `calendar/*` → search-granola, vault-sync, create-todos

4. Old hardcoded functions (`vip-email-received.ts`) deprecated after channel equivalence is verified.

(All specific matcher values — email addresses, names, tag strings, repo names — live in Convex only, not in source code or this document.)

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
- Every event indexed to Typesense — full-text + semantic search across all history, zero external API calls for lookups
- Redis hot state for dedup and rate-awareness

### Bad
- Convex query on every event (should be fast, but adds a dependency)
- Action implementations need to be modular — refactoring 600 lines of VIP into pluggable steps is real work
- Google Doc download requires `gog` CLI + auth — worker environment needs access
- Typesense indexing on every event adds write volume (manageable — already doing it for OTEL)

### Risks
- Matcher overlap: two channels match the same event. Mitigation: all matches fire by default (an email can be relevant to multiple projects). Priority field for ordering, not exclusion.
- Action failures: one step fails, rest of pipeline stalls. Mitigation: Inngest step retries + `continueOnError` flag per action.
- Rate limits: aggressive doc downloading on every email. Mitigation: dedup by doc ID (Redis SET with TTL).
- Typesense storage growth: emails accumulate. Mitigation: retention policy per collection (e.g. 1 year), old docs auto-pruned by nightly maintenance.

## Implementation Order

### Phase 1: Conversation Index (immediate value, no routing needed)
1. **`front_messages` collection** — schema + index on `front/message.received` webhook. Backfill existing conversations.
2. **`granola_meetings` collection** — schema + nightly sync cron. Backfill all accessible meetings. Biggest bang — eliminates rate limit pain.
3. **Wire `voice_transcripts`** — collection exists, just needs the `voice/call.completed` handler to index.
4. **`telegram_messages` collection** — index on `telegram/callback.received` webhook.

### Phase 2: Channel Routing Engine
5. Convex `channels` schema + seed initial channels
6. Channel router Inngest function (matcher evaluation against any event type)
7. Channel processor Inngest function (action pipeline executor)
8. Port VIP actions into modular action implementations
9. Add new actions: `extract-google-links`, `download-gdocs`, `vault-sync`, `correlate-vault`

### Phase 3: Surface + Migration
10. CLI commands: `joelclaw channels list/show/add/edit/disable`
11. Wire router into the event bus (all events flow through)
12. Deprecate `vip-email-received.ts`
13. Web UI on joelclaw.com/system/channels
14. Add remaining collections (`github_events`, `todoist_events`, `imessage_threads`, `session_transcripts`) as needed
