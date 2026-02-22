---
status: shipped
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - email
  - hexagonal
  - ports-adapters
  - joelclaw
---

# ADR-0052: Email Port — Hexagonal Architecture with Dual Adapters

## Context

joelclaw needs email capabilities: inbox triage, draft replies, archive/tag, and eventually agent-initiated email. Joel uses **Front** (collaborative inbox) for all email at egghead.io. Gmail (joelhooks@gmail.com) is a secondary account for personal/sending.

The system also needs a **calendar port** with a similar shape — Google Calendar via `gog` CLI. And future integrations (Slack, Discord, SMS) will follow the same pattern. Rather than couple directly to any provider's API, we need a port/adapter architecture that keeps the application logic provider-agnostic.

This follows Principle 3 (Ports and Adapters) from AGENTS.md — Alistair Cockburn's Hexagonal Architecture (2005).

## Decision

Define an **EmailPort** interface (the port) with two adapters: Front (primary inbox/triage) and Gmail via `gog` CLI (search/delivery). A factory selects the adapter based on use case. The port lives in a standalone package (`packages/email/`).

### Port Interface

```typescript
// packages/email/src/port/types.ts
interface EmailPort {
  // Read
  listInboxes(): Promise<Inbox[]>;
  listConversations(inboxId: string, opts?: ListOpts): Promise<Conversation[]>;
  getConversation(id: string): Promise<ConversationDetail>;

  // Triage
  archive(conversationId: string): Promise<void>;
  tag(conversationId: string, tagId: string): Promise<void>;
  untag(conversationId: string, tagId: string): Promise<void>;
  assign(conversationId: string, assigneeId: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;

  // Compose
  createDraft(params: DraftParams): Promise<Draft>;
  listDrafts(conversationId?: string): Promise<Draft[]>;
  deleteDraft(draftId: string): Promise<void>;
}
```

### Adapters

**Front adapter** (`src/adapters/front.ts`): Wraps `@skillrecordings/front-sdk`. Used for inbox triage, conversation management, tagging, drafts. Front has native draft API support and collaborative features.

**Gmail adapter** (`src/adapters/gmail.ts`): Wraps `gog` CLI with `-j` (JSON output). Used for search across Gmail, sending from joelhooks@gmail.com, calendar-adjacent email operations. `gog` requires `GOG_KEYRING_PASSWORD` env var and `--account` flag.

### Factory

```typescript
function createEmailAdapter(provider: "front" | "gmail"): EmailPort {
  switch (provider) {
    case "front": return new FrontAdapter(process.env.FRONT_API_TOKEN!);
    case "gmail": return new GmailAdapter("joelhooks@gmail.com");
  }
}
```

### Package Structure

```
packages/email/
├── src/
│   ├── port/
│   │   └── types.ts        # EmailPort interface + domain types
│   ├── adapters/
│   │   ├── front.ts        # Front SDK adapter
│   │   └── gmail.ts        # gog CLI adapter
│   └── index.ts            # Factory + re-exports
├── package.json
└── tsconfig.json
```

### Why Standalone Package

Per Principle 3, the port is owned by the hexagon, not by the adapter. `packages/email/` is consumed by:
- **Worker** (`packages/system-bus/`) — Inngest functions that triage email
- **CLI** (`packages/cli/`) — `joelclaw email inbox`, `joelclaw email triage`
- **Gateway** — agent can query email state during conversations

None of these should know whether Front or Gmail is backing the operation.

## Alternatives Considered

### A: Front SDK directly in worker

Call Front API directly from Inngest functions. No port abstraction.

**Rejected** — violates hexagonal principle. When (not if) we add another email provider, we'd need to modify application logic.

### B: Gmail only via `gog`

Skip Front, use Gmail for everything via `gog` CLI.

**Rejected** — Joel uses Front for all email collaboration. Front has team features (assignment, tags, shared drafts) that Gmail lacks. `gog` is better for search and personal sending.

### C: Single adapter that switches internally

One adapter class with if/else for Front vs Gmail.

**Rejected** — this is the adapter pattern done wrong. Each provider gets its own adapter. The factory selects.

## Consequences

### Positive
- **Provider-agnostic email** — application logic never mentions Front or Gmail
- **Testable** — in-memory adapter for testing (third adapter, per Principle 3)
- **Extensible** — Outlook, Fastmail, etc. are one adapter each
- **Pattern template** — same shape applies to calendar, tasks, notifications
- **Draft-then-approve** — agent creates drafts, Joel approves in Front before send

### Negative
- **Indirection** — port interface adds a layer between caller and provider
- **Lowest common denominator** — port can only expose features all adapters support (or adapters throw "not supported")
- **Two secrets to manage** — `front_api_token` and `gog_keyring_password`

## Implementation Status

### ✅ Scaffolded + Front Webhooks Verified (2026-02-18)
- `packages/email/` created with `package.json`, `tsconfig.json`
- `EmailPort` interface defined at `src/port/types.ts`
- Front adapter started at `src/adapters/front.ts` (uses `@skillrecordings/front-sdk`)
- Gmail adapter started at `src/adapters/gmail.ts` (wraps `gog` CLI)
- Front webhooks fully working: Rules webhook → `front/message.received` events flowing. Real emails (newsletters, Vercel notifications) confirmed E2E through gateway.
- `front_api_token` and `front_rules_webhook_secret` stored in agent-secrets
- Worker `start.sh` leases both secrets + `TODOIST_*` secrets on startup

### ⬜ Front adapter complete
- Finish all `EmailPort` methods against Front API
- Integration test with real Front account

### ⬜ Gmail adapter complete
- Auth: `gog auth add joel@joelhooks.com --services gmail`
- Wrap `gog gmail` subcommands (search, get, thread, send)

### ⬜ CLI commands
- `joelclaw email inbox` — list conversations
- `joelclaw email triage` — agent-assisted triage
- `joelclaw email draft` — create draft reply

### ⬜ Inngest functions
- Email triage function triggered by Front webhooks
- Agent drafts reply, pushes to gateway for approval

### ⬜ Calendar port (future ADR)
- Same pattern: `CalendarPort` interface, Google Calendar adapter via `gog calendar`
- Will need ADR-0053
