---
status: proposed
date: 2026-02-19
deciders: joel
tags: [pi, inngest, monitoring, joelclaw]
---

# ADR-0066: Inngest Monitor Pi Extension

## Context

The joelclaw system has ~30 Inngest functions handling video ingest, memory compaction, email triage, friction analysis, heartbeat checks, and more. Today, firing an event and monitoring its lifecycle requires switching to a terminal and running `joelclaw send`, `joelclaw runs`, `joelclaw run <id>` — context-switching that breaks flow.

Pi extensions for background work (codex-exec, ralph-loop, session-reader, inbox-watcher) all converged on a consistent UX pattern in ADR-0061: persistent widget for live status, `display: false` messages for model context, batch turn triggering. But none of these talk to Inngest directly — they spawn local processes or dispatch fire-and-forget events.

The gap: no pi extension lets you fire an Inngest event and watch its run lifecycle (which function triggered, which steps completed, success/failure) without leaving the session.

## Decision

Create `@joelclaw/pi-extensions` package in the joelclaw monorepo (`packages/pi-extensions/`) containing joelclaw-specific pi extensions, starting with `inngest-monitor`.

### inngest-monitor

A pi extension that sends Inngest events and monitors run lifecycle via the Inngest GQL API (`localhost:8288/v0/gql`).

**Tools:**
- `inngest_send` — fire an event, optionally monitor the resulting runs
- `inngest_runs` — detailed run inspection with step traces

**Monitoring mechanism:** GQL polling (not Redis pub/sub). The Inngest GQL API exposes run status and step traces for ALL functions — no gateway middleware dependency. Poll every 3s for `run` status + `runTrace` step tree until terminal state.

**UX:** Same widget pattern as codex-exec et al:
- Persistent widget shows running/recent events with step progress
- `display: false` messages deliver results to model silently
- `triggerTurn` on completion/failure, batched when multiple runs active
- Compact `renderCall`/`renderResult` on both tools
- Message renderer for `inngest-run-complete` type

### GQL queries used

```graphql
# Run status
{ run(runID: "...") { id status functionID startedAt endedAt output } }

# Step trace (live progress)
{ runTrace(runID: "...") { name status duration isRoot childrenSpans { name status duration childrenSpans { name status duration } } } }

# Function name resolution (cached)
{ functions { id name } }

# Error details (on failure)
{ runTraceSpanOutputByID(outputID: "...") { data error { message name stack } } }
```

### Package structure

```
packages/pi-extensions/
  package.json          # @joelclaw/pi-extensions
  tsconfig.json
  inngest-monitor/
    index.ts            # pi extension
    DESIGN.md           # detailed design reference
```

## Consequences

- Agents can fire Inngest events and see results without context-switching
- Run progress visible at a glance in the widget (step names, completion %)
- Model gets run results automatically for follow-up actions
- No Redis dependency — works purely via Inngest's GQL API
- Joelclaw-specific extensions separated from generic pi-tools
- New extensions (e.g. function browser, event history) can be added to the same package
