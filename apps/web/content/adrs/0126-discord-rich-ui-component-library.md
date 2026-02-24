# ADR-0126: Discord Rich UI Component Library

- **Status**: proposed
- **Date**: 2026-02-24
- **Related**: ADR-0122 (Discord rich messaging), ADR-0124 (thread-forked sessions), ADR-0125 (channel-aware prompt injection)

## Context

Cross-referencing actual gateway workloads (72h OTEL data, slog, session transcripts) with Discord's Components V2 capabilities to define the exact UI components needed. Design principles from `frontend-design` skill: bold aesthetic direction, intentional composition, information density over decoration.

### Workload Analysis (72h OTEL)

| Workload | Events | UI Need |
|----------|--------|---------|
| Telegram messages | 990 | Already rich (keyboards, buttons) |
| Content sync | 990 | Status containers, progress bars |
| Observe/memory | 460 | Search results, proposal cards |
| Heartbeat | 403 | Health dashboard, status indicators |
| Recall/search | 321 | Result cards with scores, context |
| Discord messages | 111 | **Gap: plain text, needs CV2** |
| MCQ decisions | 67 | Button flows, quiz mode |
| Discovery | 34 | Link cards, enrichment preview |
| Email triage | 15 | Thread summary, action buttons |
| Friction analysis | 8 | Pattern cards, fix approval |

### Existing Commands (need Discord equivalents)

Builtins: `/status`, `/help`, `/runs`, `/health`, `/reload`, `/compact`, `/new`, `/search`, `/send`
Config: `/model`, `/thinking`
Skills: dynamic skill commands

## Decision

Build a **Discord Components V2 component library** in `packages/gateway/src/discord-ui/` (not the broken `packages/discord-ui/`). Direct discord.js builders, no React reconciler.

### Component Inventory

Design language: **utilitarian-dense** — high information density, monospace data, accent color coding by severity, minimal decoration. Inspired by terminal dashboards and ops tooling. Reference: `frontend-design` skill — "industrial/utilitarian" tone.

#### 1. StatusContainer
**Workload**: heartbeat (403/72h), health checks
**CV2**: Container + Sections + color-coded accent bar
```
┌─ 🟢 System Health ────────────────────┐
│ Worker: 74 functions    Uptime: 12h   │
│ Inngest: synced         Redis: OK     │
│ Typesense: 6246 events  Errors: 0.1%  │
│ [Refresh]  [Runs]  [Logs]             │
└────────────────────────────────────────┘
```
- Green accent = healthy, yellow = degraded, red = down
- Section with thumbnail (status icon) + key metrics as TextDisplay
- ActionRow: Refresh, View Runs, View Logs buttons

#### 2. SearchResultCard
**Workload**: recall (321/72h), search
**CV2**: Container + repeating Sections
```
┌─ 🔍 Recall: "discord session management" ─┐
│ ▸ [0.87] Thread-forked sessions ADR-0124   │
│   "Each Discord thread forks a new pi..."  │
│ ▸ [0.72] Gateway multi-channel routing     │
│   "Replace global currentSource with..."   │
│ ▸ [0.65] Kimaki prior art analysis         │
│   "Discord bot orchestrating OpenCode..."  │
│ [More] [Refine] [Save to Vault]            │
└────────────────────────────────────────────┘
```
- Accent color by top score (green ≥0.8, yellow ≥0.5, red <0.5)
- Each result: score badge + title + truncated context
- Buttons: pagination, refine query, save

#### 3. McqFlow (already exists, upgrade to CV2)
**Workload**: MCQ (67/72h)
**CV2**: Container + buttons + text display
```
┌─ ⚡ Feature Design ───────────────────┐
│ Which Datalog engine for Roam graph?  │
│                                       │
│ [★ Datahike]  [XTDB]  [Datascript]   │
│                        [Other...]     │
└───────────────────────────────────────┘
```
- Recommended option gets ★ badge and Primary style
- Quiz mode: no ★, all Secondary style
- Timeout: auto-select recommended after 30s

#### 4. RunCard
**Workload**: runs monitoring, loop nanny
**CV2**: Container + Sections
```
┌─ 🏃 Recent Runs ─────────────────────┐
│ ✅ discovery-capture      2m ago  1.2s│
│ ✅ content-sync           5m ago  3.4s│
│ ⚠️ docs-ingest           12m ago SLOW│
│ ❌ friction-fix           1h ago  ERR │
│ [View Failed] [Retry] [All Runs]      │
└───────────────────────────────────────┘
```
- Color accent by worst status in set
- Each run: emoji status + function name + age + duration
- Buttons: filter by status, retry failed, link to Inngest

#### 5. DiscoveryCard
**Workload**: discovery (34/72h)
**CV2**: Container + MediaGallery (if OG image) + Section
```
┌─ 🔗 Discovery ───────────────────────┐
│ [OG image thumbnail]                  │
│ Kimaki — Discord agent sessions       │
│ github.com/remorses/kimaki            │
│ "Orchestrates OpenCode coding agents  │
│  inside Discord. Thread=session..."   │
│ [Open] [Save to Vault] [Dismiss]      │
└───────────────────────────────────────┘
```
- MediaGallery for OG image when available
- Section: title + URL + context snippet
- Buttons: open link, save, dismiss

#### 6. ApprovalCard
**Workload**: exec approvals, loop decisions, friction fixes
**CV2**: Container + warning accent + buttons
```
┌─ ⚠️ Approval Required ───────────────┐
│ friction-fix wants to modify:         │
│ packages/system-bus/src/lib/cache.ts  │
│                                       │
│ Change: Add TTL to Granola cache      │
│ Risk: Low (existing function)         │
│                                       │
│ [✅ Approve] [❌ Deny] [📋 Diff]      │
└───────────────────────────────────────┘
```
- Yellow accent for pending, green for approved, red for denied
- Diff button opens code preview in thread

#### 7. SessionCard
**Workload**: session management, thread lifecycle
**CV2**: Container + Section with thumbnail
```
┌─ 📋 Thread Session ──────────────────┐
│ 🧵 #koko-shadow-executor             │
│ Status: active   Age: 2h 15m         │
│ Messages: 34     Model: opus-4-6     │
│ [Fork] [Compact] [Archive] [Resume]  │
└───────────────────────────────────────┘
```

#### 8. HeartbeatDigest
**Workload**: heartbeat cron (403/72h) — the most frequent automated event
**CV2**: Compact Container, minimal
```
┌─ 💓 22:30 PST ───────────────────────┐
│ All systems nominal                   │
│ W:74 I:✓ R:✓ T:6.2k E:0.1%         │
└───────────────────────────────────────┘
```
- Ultra-compact for routine heartbeats
- Expands to full StatusContainer on click

### Slash Commands — Work-Mapped

Commands match actual workloads, not generic bot patterns.

| Command | Args | Component | Workload (72h vol) |
|---------|------|-----------|-------------------|
| `/health` | — | StatusContainer | Heartbeat (403) |
| `/recall` | `<query>` | SearchResultCard | Memory search (321) |
| `/runs` | `[count]` | RunCard | Run monitoring |
| `/discover` | `<url>` | DiscoveryCard | Discovery (34) |
| `/friction` | — | ApprovalCard list | Friction triage (8) |
| `/sync` | — | StatusContainer | Content sync (990) |
| `/docs` | — | RunCard (filtered) | Docs ingest (5048) |
| `/loop` | `[action]` | RunCard + buttons | Agent loops |
| `/email` | — | SearchResultCard | Email triage (15) |
| `/deploy` | — | StatusContainer | Vercel deploys |
| `/schedule` | `<prompt>` | Confirmation | Deferred tasks (ADR-0102) |
| `/fork` | `[message_id]` | SessionCard | Session mgmt (Kimaki) |
| `/compact` | — | Confirmation | Session mgmt |
| `/config` | — | Select menus | Settings (model, thinking) |

**Removed**: Generic `/status` (merged into `/health`), `/help` (Discord's built-in command list), `/new` (use `/fork`), `/reload` (ops-only, not user work), `/search` (merged into `/recall`), `/model`+`/thinking` (merged into `/config`).

## Implementation

### File Structure
```
packages/gateway/src/discord-ui/
  components/
    status-container.ts
    search-result-card.ts
    mcq-flow.ts
    run-card.ts
    discovery-card.ts
    approval-card.ts
    session-card.ts
    heartbeat-digest.ts
  slash-commands/
    register.ts        # Guild-scoped command registration
    handler.ts         # Interaction router
  helpers/
    accent-color.ts    # Severity → color mapping
    truncate.ts        # Smart text truncation
    format.ts          # Monospace alignment helpers
  index.ts             # Public API
```

### Design Tokens
```typescript
const ACCENT = {
  healthy: 0x22C55E,   // green-500
  warning: 0xEAB308,   // yellow-500
  error:   0xEF4444,   // red-500
  info:    0x3B82F6,   // blue-500
  neutral: 0x6B7280,   // gray-500
} as const;
```

### Key Principles (from frontend-design skill)
1. **Utilitarian density** — pack information tight, no decorative waste
2. **Color means severity** — accent bars communicate state at a glance
3. **Monospace for data** — code blocks for aligned metrics
4. **Buttons are actions** — every button does something, no filler
5. **Containers group related info** — one container per logical unit
6. **Separators create rhythm** — visual breathing room between sections

## Consequences

- Discord becomes a first-class rich interaction channel (parity with Telegram)
- Components V2 containers are strictly better than embeds for layout control
- Direct discord.js builders — no React reconciler dependency
- Each component is independently testable and composable
- New channels can adopt the component patterns (Slack, web dashboard)

## Success Criteria

- All 8 components rendering correctly in Discord threads
- All 14 slash commands registered and functional
- Heartbeat digest renders in < 200ms
- MCQ flow works with buttons (no text fallback needed)
- Search results show scores and truncated context
- Thread sessions fork correctly with SessionCard confirmation
