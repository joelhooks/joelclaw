---
type: adr
status: shipped
date: 2026-02-21
tags: [adr, observability, design-system, infrastructure, pipeline]
deciders: [joel]
supersedes: ["0006-observability-prometheus-grafana", "0033-victoriametrics-grafana-monitoring-stack"]
---

# ADR-0087: Full-Stack Observability + JoelClaw Design System

## Status

implemented

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
- **Convex** `contentResources` with type `otel_event`: Real-time reactive feed for the UI. Rolling watch window — default last 30 minutes (`OTEL_EVENTS_CONVEX_WINDOW_HOURS=0.5`) of warn/error/fatal events. Purge older events opportunistically. Debug/info events stay in Typesense only.
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

### 4. Sentry Role (and "Sentry at Home" Decision)

Sentry is adopted as a **secondary** signal for exception tracking, stack traces, and distributed tracing UX. It is **not** the system of record for joelclaw observability; Typesense + Convex + joelclaw.com remain canonical.

For this system, **self-hosted Sentry is deferred** until there is an explicit hard requirement (air-gapped ops, policy requirement, or sustained traffic that justifies dedicated ops overhead). Current rationale:

- Sentry self-hosted is positioned as low-volume / proof-of-concept deployment and requires meaningful host resources (minimum 4 CPU, 16 GB RAM + 16 GB swap, 20 GB disk).
- Self-hosted releases are monthly CalVer snapshots, with regular upgrade pressure and expected downtime during upgrades.
- Sentry self-hosted docs do not provide direct scaling guidance for custom Kubernetes topologies; maintenance burden shifts fully to us.

Decision:
- **Now**: instrument Sentry SDKs for web + worker/gateway paths where it accelerates diagnosis.
- **Later (optional)**: deploy self-hosted Sentry only on a dedicated host profile and explicit ops runbook, not on the main single-node control-plane by default.

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
- Convex write volume increases (mitigated: only warn+ events, 30m rolling watch window)
- Design system bootstrap is upfront work before it pays off
- Two storage backends for events (Typesense + Convex) adds complexity

### Risks
- Alert fatigue if thresholds are too sensitive — start conservative, tune with echo/fizzle-style feedback
- Circular dependency: o11y pipeline monitors itself. Mitigation: fatal alerts go direct to Telegram (bypass Inngest)

## Implementation Plan

### Phase 0: Contracts and Guardrails (day 1)
1. Add canonical event contract in `packages/system-bus/src/observability/otel-event.ts` (new), including runtime validation.
2. Add emitter helpers in `packages/system-bus/src/observability/emit.ts` (new) with severity mapping and source/component conventions.
3. Add storage adapter in `packages/system-bus/src/observability/store.ts` (new) that dual-writes:
   - Typesense collection `otel_events` (full retention window)
   - Convex `contentResources` type `otel_event` (warn+ rolling window)
4. Document env contract in `.env.example` / ops docs:
   - `OTEL_EVENTS_ENABLED`
   - `OTEL_EVENTS_CONVEX_WINDOW_HOURS`
   - `SENTRY_DSN` (optional)
   - `SENTRY_ENVIRONMENT`
5. Rollout gate: no ingestion unless contract + adapter tests pass.

### Phase 1: Worker and Gateway Instrumentation (week 1)
1. Worker:
   - Add event emission at ingress/egress in `packages/system-bus/src/serve.ts`.
   - Wrap critical functions in `packages/system-bus/src/inngest/functions/index.ts` registration path (start/success/fail envelopes).
   - Add explicit instrumentation in high-impact functions:
     - `packages/system-bus/src/inngest/functions/observe.ts`
     - `packages/system-bus/src/inngest/functions/heartbeat.ts`
     - `packages/system-bus/src/inngest/functions/check-system-health.ts`
     - `packages/system-bus/src/inngest/functions/content-sync.ts`
2. Gateway:
   - Emit drain / queue / send outcomes from:
     - `packages/gateway/src/channels/redis.ts`
     - `packages/gateway/src/command-queue.ts`
     - `packages/gateway/src/channels/telegram.ts`
     - `packages/gateway/src/daemon.ts`
3. Add backpressure + drop protections (sampling for debug-level chatter) in `packages/system-bus/src/observability/store.ts`.
4. Rollout gate: event volume < configured threshold, no queue regressions on gateway.

### Phase 2: Query Surfaces (week 1)
1. Web API:
   - Add `apps/web/app/api/otel/route.ts` (new) for typed query/filter over `otel_events`.
2. CLI:
   - Add `packages/cli/src/commands/otel.ts` (new) with:
     - `joelclaw otel list`
     - `joelclaw otel search`
     - `joelclaw otel stats`
   - Register command in `packages/cli/src/cli.ts`.
3. Add schema docs and examples under `apps/web/content/adrs/0087...` + runbook.
4. Rollout gate: on-call triage possible from CLI alone (no direct DB access).

### Phase 3: UI and Design System (week 2)
1. Expand shared UI in `packages/ui/src/`:
   - `status-badge.tsx` (new)
   - `metric-card.tsx` (new)
   - `event-timeline.tsx` (new)
   - `filter-chips.tsx` (new)
2. Add observability pages:
   - `apps/web/app/system/page.tsx` (new)
   - `apps/web/app/system/events/page.tsx` (new)
3. Migrate existing pages to shared components:
   - `apps/web/app/syslog/page.tsx`
   - `apps/web/app/network/page.tsx`
   - `apps/web/app/dashboard/page.tsx`
4. Rollout gate: mobile render + auth checks + query latency SLOs met.

### Phase 4: Agent Loop and Escalation (week 2-3)
1. Add error-rate evaluator function in `packages/system-bus/src/inngest/functions/check-system-health.ts` (or dedicated `check-otel.ts` new function).
2. Wire gateway notification path through:
   - `packages/system-bus/src/inngest/middleware/gateway.ts`
   - `packages/gateway/src/commands/telegram-handler.ts`
3. Fatal-event fast path bypasses normal batching and posts immediate Telegram alert.
4. Rollout gate: synthetic fatal event reaches Telegram within SLA.

### Phase 5: Sentry Integration (optional, parallel)
1. Web SDK integration:
   - `apps/web/sentry.client.config.ts` (new)
   - `apps/web/sentry.server.config.ts` (new)
   - `apps/web/sentry.edge.config.ts` (new)
   - `apps/web/next.config.js` Sentry plugin wiring
2. Worker/gateway optional `@sentry/node` init in:
   - `packages/system-bus/src/serve.ts`
   - `packages/gateway/src/daemon.ts`
3. Keep Sentry as secondary sink: do not replace Typesense/Convex ingestion paths.
4. Self-hosted Sentry only after separate infra ADR addendum with host sizing, backup, upgrade, and rollback runbook.

## Verification

- [x] Typesense `otel_events` collection is auto-created on first write and accepts worker + gateway instrumentation events.
- [x] `joelclaw otel list`, `joelclaw otel search`, and `joelclaw otel stats` are implemented and wired into the CLI.
- [x] Warn/error/fatal events mirror to Convex `contentResources` as `otel_event` for real-time UI surfaces.
- [x] Convex rolling window is enforced with `OTEL_EVENTS_CONVEX_WINDOW_HOURS` (default `0.5` = 30 minutes) and opportunistic prune on high-severity writes.
- [x] `/system` renders mobile-first health summary + event feed from the new `/api/otel` API.
- [x] `/system/events` supports full-text search and facet filters for `source` and `level`.
- [x] Heartbeat/system health now queries `otel_events` for recent error-rate escalation.
- [x] Fatal path uses `immediateTelegram` signaling and bypasses normal batch digest delay in gateway Redis drain.
- [x] `packages/ui` shared components (`status-badge`, `metric-card`, `event-timeline`, `filter-chips`) are consumed by `/system`, `/syslog`, `/network`, and `/dashboard`.
- [x] No Grafana dependency was added.
- [x] Canonical write path is centralized in `packages/system-bus/src/observability/{otel-event.ts,emit.ts,store.ts}`.
- [x] Sentry remains optional + secondary (`SENTRY_DSN` / `SENTRY_ENVIRONMENT`), and no self-hosted Sentry infra was added.

## Implementation Outcome (2026-02-21)

### Completed
- Implemented canonical observability contract and storage adapters under `packages/system-bus/src/observability/`.
- Added worker ingest endpoint (`/observability/emit`) so gateway emissions go through the single worker write path.
- Instrumented worker and gateway hot paths listed in this ADR with debug flood guardrails.
- Added owner-authenticated web query API at `apps/web/app/api/otel/route.ts`.
- Added CLI surface `joelclaw otel {list|search|stats}`.
- Added `/system` and `/system/events` pages and reused shared UI components across existing pages.
- Wired error-rate escalation in `check-system-health` with immediate fatal Telegram path.

### Exact Paths Touched
- `packages/system-bus/src/observability/otel-event.ts`
- `packages/system-bus/src/observability/emit.ts`
- `packages/system-bus/src/observability/store.ts`
- `packages/system-bus/src/observability/otel-event.test.ts`
- `packages/system-bus/src/observability/store.test.ts`
- `packages/system-bus/src/lib/typesense.ts`
- `packages/system-bus/src/serve.ts`
- `packages/system-bus/src/inngest/functions/index.ts`
- `packages/system-bus/src/inngest/functions/observe.ts`
- `packages/system-bus/src/inngest/functions/heartbeat.ts`
- `packages/system-bus/src/inngest/functions/check-system-health.ts`
- `packages/system-bus/src/inngest/functions/content-sync.ts`
- `packages/gateway/src/observability.ts`
- `packages/gateway/src/channels/redis.ts`
- `packages/gateway/src/command-queue.ts`
- `packages/gateway/src/channels/telegram.ts`
- `packages/gateway/src/daemon.ts`
- `apps/web/app/api/otel/route.ts`
- `packages/cli/src/commands/otel.ts`
- `packages/cli/src/cli.ts`
- `packages/ui/src/status-badge.tsx`
- `packages/ui/src/metric-card.tsx`
- `packages/ui/src/event-timeline.tsx`
- `packages/ui/src/filter-chips.tsx`
- `apps/web/app/system/page.tsx`
- `apps/web/app/system/events/page.tsx`
- `apps/web/app/syslog/page.tsx`
- `apps/web/app/network/page.tsx`
- `apps/web/app/dashboard/page.tsx`
- `apps/web/components/site-header.tsx`
- `apps/web/components/mobile-nav.tsx`
- `apps/web/app/api/search/route.ts`
- `apps/web/app/api/typesense/[collection]/route.ts`
- `apps/web/app/api/typesense/[collection]/[id]/route.ts`

## References

- ADR-0006: Prometheus + Grafana (superseded — wrong era, wrong stack)
- ADR-0033: VictoriaMetrics + Grafana (superseded — Grafana unnecessary, joelclaw.com is the surface)
- ADR-0082: Typesense unified search (storage backend for events)
- ADR-0084: Unified contentResources (Convex real-time layer)
- ADR-0085: Data-driven network page (pattern for ISR + Convex Server Components)
- ADR-0075: Better Auth + Convex (owner-only auth for dashboards)
- [shadcn registry docs](https://ui.shadcn.com/docs/registry)
- [Vercel composition patterns skill](~/.agents/skills/vercel-composition-patterns/SKILL.md)
- [Sentry self-hosted docs](https://develop.sentry.dev/self-hosted/)
- [Sentry self-hosted releases/upgrades](https://develop.sentry.dev/self-hosted/releases/)
- [Sentry Node OpenTelemetry support](https://docs.sentry.io/platforms/node/performance/instrumentation/opentelemetry)

## Notes

### Q&A (Joel, 2026-02-21)
- **Biggest pain**: Silent failures. System fails quietly, discovered by accident hours later.
- **Consumer**: Agent-first. Self-diagnose + auto-fix. Escalate exceptions to Joel.
- **Surface**: joelclaw.com. Mobile-first. Next.js cached components. No Grafana.
- **Scope**: Full stack. Structured logs. High cardinality. Plenty of storage — use it.
- **Design system**: shadcn registry in monorepo. Consistent component library across all pages.
