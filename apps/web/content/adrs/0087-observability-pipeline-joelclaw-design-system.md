---
type: adr
status: proposed
date: 2026-02-21
tags: [adr, observability, design-system, infrastructure, pipeline]
deciders: [joel]
supersedes: ["0006-observability-prometheus-grafana", "0033-victoriametrics-grafana-monitoring-stack"]
---

# ADR-0087: Full-Stack Observability + JoelClaw Design System

## Status

proposed

## Context

The system has been running for 7 days with **zero observability infrastructure**. ADR-0006 (Prometheus + Grafana) and ADR-0033 (VictoriaMetrics + Grafana) were proposed but never deployed. Both targeted traditional infrastructure metrics (CPU, memory, pod restarts) for a system that has since evolved into an event-driven agent platform with 61+ Inngest functions, a memory pipeline, webhook integrations, and a real-time web dashboard.

### The Actual Pain (2026-02-21 session)

Every major bug discovered today was found **by accident**, not by alerts:

| Failure | Duration Silent | How Discovered |
|---------|----------------|----------------|
| Vercel webhook 401s (missing secret) | **Days** | Manual log grep |
| Recall doing keyword search, not semantic | **Since Typesense migration** | Code audit |
| Gateway replay flood (389 stale messages) | **Since message-store creation** | User report |
| Convex dual-write silently dropping | **Unknown** | Code audit |
| Echo-fizzle implemented but never registered | **Since implementation** | Code audit |
| Batch digest never flushing (3 events stuck) | **Hours** | Manual Redis inspect |

The pattern: **the system fails quietly and Joel stumbles across it later.** Traditional metrics wouldn't have caught most of these — they're pipeline logic failures, not resource exhaustion.

### What Exists Today

- **slog**: Manual CLI for infrastructure changes. Append-only JSONL. Good for audit trail, bad for real-time.
- **Worker stderr**: Structured-ish console.log. Not queryable. Lost on restart.
- **Inngest dashboard**: Step traces per function run. Requires manual inspection.
- **Heartbeat**: 15-minute health check. Checks pod liveness but not pipeline correctness.
- **joelclaw.com**: /network (live pod status), /syslog (manual slog entries), /memory (observations), /dashboard (stats).
- **Convex contentResources**: Unified polymorphic table. Already stores network status, syslog, memory observations.

### Design System Gap

joelclaw.com pages are built ad-hoc — each page reinvents card layouts, filter chips, status badges, stat readouts. No shared component library, no consistent design language, no reusable patterns. The shadcn registry pattern solves this: components are authored in the monorepo, published as a registry, and consumed via `shadcn add`.

## Decision

### 1. Observability Architecture

**Structured event logging → Typesense (search + high cardinality) → Convex (real-time UI) → joelclaw.com (dashboards) → Agent (auto-diagnosis) → Telegram (escalation)**

#### Collection Layer

Every subsystem emits structured log events with consistent schema:

```typescript
interface OtelEvent {
  id: string;                    // UUID
  timestamp: number;             // epoch ms
  level: "debug" | "info" | "warn" | "error" | "fatal";
  source: string;                // e.g. "worker", "gateway", "webhook", "inngest", "memory"
  component: string;             // e.g. "observe.ts", "vercel-provider", "recall"
  action: string;                // e.g. "webhook.received", "function.completed", "search.executed"
  duration_ms?: number;          // for timed operations
  success: boolean;
  error?: string;                // error message if !success
  metadata: Record<string, unknown>;  // high-cardinality fields — function ID, event ID, deployment ID, etc.
}
```

Sources:
- **Worker**: Instrument all Inngest function starts/completions/failures. Webhook receipt + verification. Typesense/Convex writes.
- **Gateway**: Event drain cycles. Message store operations. Telegram send/receive. Session health.
- **Infrastructure**: Pod status (from existing network-status-update). Daemon health. Disk/memory (from `vm_stat`, `df`).
- **Pipeline**: Memory observe→reflect→triage→promote chain. Content sync. Friction detection runs.

#### Storage Layer

- **Typesense** `otel_events` collection: Primary store. Auto-embedding on `action + error + metadata` for semantic search. Faceted on `source`, `component`, `level`, `success`. High cardinality fields in metadata (function IDs, deployment IDs, session IDs). Retention: unlimited (storage is cheap, NAS-backed archive for cold data).
- **Convex** `contentResources` with type `otel_event`: Real-time reactive feed for the UI. Rolling window — last 24h of warn/error/fatal events. Purge older events nightly. Debug/info events stay in Typesense only.
- **Redis streams**: Hot buffer for real-time alerting. Agent subscribes. Events older than 1h auto-trimmed.

#### Agent Consumption

The agent gets observability data through:
1. **Proactive**: Heartbeat check function queries Typesense for error rate in last 15 minutes. If above threshold → investigate → auto-fix or escalate.
2. **Reactive**: `joelclaw otel` CLI command — query events by source, level, time range, component. Agent uses this mid-session for diagnosis.
3. **Alert stream**: Redis pub/sub for fatal/error events. Gateway extension subscribes and injects into agent context.

#### Escalation

Agent acts first. Escalation to Joel (via Telegram) only when:
- Error rate exceeds threshold AND agent can't auto-fix
- Fatal events (pod crash, worker down)
- Pipeline stall detected (no events from a source for > 30 minutes)

### 2. JoelClaw Design System (shadcn Registry)

Bootstrap a shadcn component registry in the monorepo for consistent, mobile-first UI across all joelclaw.com pages.

#### Registry Structure

```
packages/ui/
├── registry.json              # shadcn registry manifest
├── src/
│   ├── components/
│   │   ├── status-badge.tsx       # ● green/yellow/red with label
│   │   ├── metric-card.tsx        # stat readout with trend arrow
│   │   ├── event-timeline.tsx     # chronological event feed
│   │   ├── filter-chips.tsx       # faceted filter bar (reusable)
│   │   ├── pipeline-flow.tsx      # visual pipeline stage indicators
│   │   ├── alert-banner.tsx       # error/warning banner with action
│   │   ├── data-table.tsx         # sortable, filterable table
│   │   ├── sparkline.tsx          # inline mini chart for trends
│   │   ├── section-header.tsx     # font-pixel uppercase header
│   │   └── search-input.tsx       # Typesense-powered search
│   ├── hooks/
│   │   ├── use-otel-events.ts     # Convex useQuery for real-time events
│   │   ├── use-pipeline-health.ts # aggregated pipeline status
│   │   └── use-system-status.ts   # infrastructure health summary
│   └── lib/
│       ├── otel-client.ts         # fetch wrapper for /api/otel
│       └── format.ts              # duration, timestamp, byte formatters
```

#### Design Tokens

- **Font**: Geist Pixel Square for data readouts + section headers (bitmap/terminal feel), Geist Mono for body
- **Theme**: catppuccin-macchiato (matches vault + code blocks)
- **Mobile-first**: Touch targets ≥ 44px, single-column default, responsive breakpoints
- **Status colors**: Green (operational), Yellow (degraded), Red (down), Neutral (unknown)

#### Component Composition Pattern

Following Vercel composition patterns (ADR skill): compound components, render props for customization, context providers for shared state. Server Components for data fetching, Client Components only for interactivity.

```tsx
// Example: Pipeline health dashboard composition
<PipelineHealth>
  <PipelineHealth.Summary />           {/* Server Component — ISR cached */}
  <PipelineHealth.StageList>           {/* Server Component */}
    <PipelineHealth.Stage name="webhooks" />
    <PipelineHealth.Stage name="memory" />
    <PipelineHealth.Stage name="content-sync" />
  </PipelineHealth.StageList>
  <PipelineHealth.EventFeed />         {/* Client Component — Convex useQuery */}
</PipelineHealth>
```

### 3. Dashboard Pages

#### /system (new — replaces need for Grafana)

Mobile-first system overview. Three sections:

1. **Health Summary** — traffic light for each subsystem (infra, pipeline, agent). Server Component, ISR 60s.
2. **Event Feed** — real-time stream of warn/error events from Convex. Client Component. Filterable by source/level.
3. **Pipeline Stages** — visual flow showing each pipeline's last-run status, throughput, error rate. Server Component.

#### /system/events (new)

Full event explorer. Typesense-powered search across all otel_events. Faceted filters: source, component, level, time range. High cardinality metadata searchable. Mobile-friendly table with expandable rows.

#### Existing pages enhanced

- **/network**: Already data-driven. Add sparklines for pod restart counts, uptime trends.
- **/syslog**: Replace manual slog entries with auto-collected otel_events filtered to infrastructure actions.
- **/dashboard**: Add pipeline health widgets using design system components.

## Consequences

### Positive
- Silent failures become impossible — every subsystem emits structured events, agent monitors continuously
- Agent can self-diagnose using `joelclaw otel` CLI and Typesense queries — no human grepping
- Consistent UI via design system — new pages take hours instead of days
- High cardinality metadata enables ad-hoc investigation ("show me all events for deployment dpl_xxx")
- Mobile-first means Joel can glance at system health from anywhere
- Storage is cheap — keep everything, search it later

### Negative
- Instrumentation effort — every function/webhook/pipeline needs event emission added
- Convex write volume increases (mitigated: only warn+ events, 24h rolling window)
- Design system bootstrap is upfront work before it pays off
- Two storage backends for events (Typesense + Convex) adds complexity

### Risks
- Alert fatigue if thresholds are too sensitive — start conservative, tune with echo/fizzle-style feedback
- Circular dependency: o11y pipeline monitors itself. Mitigation: fatal alerts go direct to Telegram (bypass Inngest)

## Implementation Plan

### Phase 1: Foundation (week 1)
1. Define `OtelEvent` schema in shared types package
2. Create `packages/ui/` with shadcn registry, seed with 3-4 core components (status-badge, metric-card, event-timeline, filter-chips)
3. Create Typesense `otel_events` collection with auto-embedding
4. Create `/api/otel` API route for querying events
5. Add `joelclaw otel` CLI command (list, search, stats)

### Phase 2: Instrumentation (week 1-2)
6. Instrument worker: function start/complete/fail, webhook receipt/verify/emit
7. Instrument gateway: drain cycles, message store ops, Telegram delivery
8. Instrument memory pipeline: observe/reflect/triage/promote with event emission
9. Instrument content-sync, friction, nightly-maintenance

### Phase 3: Dashboard (week 2)
10. Build /system page with health summary + event feed + pipeline stages
11. Build /system/events explorer page
12. Enhance existing pages with design system components
13. Wire heartbeat check function to query otel_events for error rate

### Phase 4: Agent Loop (week 2-3)
14. Gateway extension subscribes to error/fatal Redis stream
15. Agent auto-diagnosis: on error spike, query recent events, attempt fix, escalate if stuck
16. Telegram escalation with structured alert format + action buttons

## References

- ADR-0006: Prometheus + Grafana (superseded — wrong era, wrong stack)
- ADR-0033: VictoriaMetrics + Grafana (superseded — Grafana unnecessary, joelclaw.com is the surface)
- ADR-0082: Typesense unified search (storage backend for events)
- ADR-0084: Unified contentResources (Convex real-time layer)
- ADR-0085: Data-driven network page (pattern for ISR + Convex Server Components)
- ADR-0075: Better Auth + Convex (owner-only auth for dashboards)
- [shadcn registry docs](https://ui.shadcn.com/docs/registry)
- [Vercel composition patterns skill](~/.agents/skills/vercel-composition-patterns/SKILL.md)

## Notes

### Q&A (Joel, 2026-02-21)
- **Biggest pain**: Silent failures. System fails quietly, discovered by accident hours later.
- **Consumer**: Agent-first. Self-diagnose + auto-fix. Escalate exceptions to Joel.
- **Surface**: joelclaw.com. Mobile-first. Next.js cached components. No Grafana.
- **Scope**: Full stack. Structured logs. High cardinality. Plenty of storage — use it.
- **Design system**: shadcn registry in monorepo. Consistent component library across all pages.
