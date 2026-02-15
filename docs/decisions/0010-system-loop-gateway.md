---
status: proposed
date: 2026-02-14
decision-makers: Joel Hooks
---

# Establish a central system loop gateway for autonomous orchestration

## Context and Problem Statement

The system already has meaningful execution capability, but orchestration is still manual. ADR-0005 established durable coding loops with role-based execution and event-driven handoffs. ADR-0007 improved those loops with stronger controls, better isolation assumptions, and more reliable execution characteristics. ADR-0008 added a retrospective and skill-evolution layer so outcomes can feed learning instead of disappearing after a run. In parallel, the broader stack already includes an event bus, video/transcript pipelines, and a note queue that can move data through durable workflows.

What is missing is the autonomous gateway that decides what should happen next. Today Joel is that gateway. He watches incoming events, decides which loop to start, prioritizes competing work, interprets failures, and chooses when to retry, skip, or escalate. That human coordination works, but it limits throughput and creates a single-point bottleneck for system responsiveness.

The OpenClaw architecture calls for a central LLM session loop that continuously runs a SENSE→ORIENT→DECIDE→ACT→LEARN pattern: SENSE incoming events and state changes; ORIENT against current system context, goals, and backlog; DECIDE the highest-value safe action; ACT by dispatching to existing pipelines (coding loop, media/transcript flows, note queue handlers, and retrospective processors); then LEARN from outcomes to improve future routing and prioritization.

The unresolved problem is how to introduce this gateway while balancing key drivers: whether operation should be always-on or scheduled/cron-triggered, how safety boundaries and kill-switch controls are enforced, how cost is bounded as loop frequency grows, and how human oversight remains explicit for high-impact decisions. This ADR proposes framing and constraints for that orchestration layer.

Related: [ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md), [ADR-0007 — Agent loop v2 improvements](0007-agent-loop-v2-improvements.md), [ADR-0008 — Loop retrospective and skill evolution](0008-loop-retrospective-and-skill-evolution.md)

## Decision Drivers

- Autonomous action capability: the system should move routine work forward without waiting for manual triage each time.
- Safety and human oversight: high-impact actions must remain reviewable, interruptible, and bounded by explicit guardrails.
- Cost control (LLM calls): loop execution frequency and model usage must be predictable and capped to avoid runaway spend.
- State awareness: routing decisions should use current backlog, recent loop outcomes, and system health, not stale assumptions.
- Composability with existing pipelines: the gateway should dispatch into current coding, media, notes, and retrospective flows without rewriting them.
- Graceful degradation: when model, network, or downstream systems fail, the gateway should fall back to safe no-op, defer, or human escalation behavior.

## Considered Options

### Option A: No system loop — keep human as gateway

In this model, Joel continues to interpret events and manually trigger follow-on workflows. The architecture stays simple and transparent, but throughput remains constrained by human availability and attention.

### Option B: Cron-triggered heartbeat — Inngest cron function that runs every N minutes and checks state

A scheduled Inngest function wakes up on a fixed cadence, evaluates system state, and decides whether to dispatch work. This creates predictable execution windows and easier cost controls, but it can introduce latency between events and action.

### Option C: Event-driven reactive loop — function triggered by terminal events (`loop.complete`, note captured, etc.) that evaluates next action

Each relevant event triggers a lightweight evaluation function that decides the next safe step immediately from fresh context. This improves responsiveness and reduces idle polling, but requires careful deduplication and reentrancy controls to avoid cascades.

### Option D: Always-on LLM session — persistent context window that receives all events

A long-lived LLM session continuously consumes events and decides actions in near real time. It offers strong continuity of context, but increases operational complexity, safety risk surface, and ongoing token cost pressure.

## Decision Outcome

Chosen option: **Hybrid of Option C + Option B**. The gateway will use an event-driven reactive loop as the primary control path, triggered by high-signal events such as `agent/loop.complete`, `agent/loop.retro.complete`, and `system/note`. A cron heartbeat sweep every 15-30 minutes will run as a fallback to catch missed events, reconcile drift, and unblock stuck work.

This approach is selected because it combines low-latency action on fresh system signals with bounded reliability backstops. It preserves responsiveness for autonomous orchestration without requiring a fully always-on session model.

### Consequences

Good:
- Autonomous action improves because the system can route and dispatch follow-on work immediately after terminal events.
- Feedback loops are faster because loop outcomes and retrospectives can trigger next actions without waiting for manual polling windows.
- The note queue gets processed more consistently because the fallback heartbeat sweep closes event-delivery gaps.

Bad:
- LLM call volume can increase, especially during event bursts and periodic sweeps, which raises operating cost.
- Runaway action risk increases if deduplication, reentrancy guards, or rate limits are misconfigured.
- Operational complexity increases because two trigger paths (event and cron) must be coordinated and observed.

Neutral:
- Human operators can still override, pause, or cancel execution flows when needed, so control remains available even with higher autonomy.

Safety constraints for this decision:
- Human override and cancel controls remain mandatory for high-impact or uncertain actions.
- Action limits are enforced per cycle and per time window to prevent cascade behavior.
- Cost caps (daily/weekly budget and per-run token ceilings) are enforced before dispatching new work.

## Pros and Cons of the Options

### Option A: No system loop — keep human as gateway

Pros:
- Lowest technical complexity and implementation risk.
- Full human judgment on every orchestration decision.
- Minimal incremental LLM and infrastructure cost.

Cons:
- Throughput remains bottlenecked by human availability.
- Slower feedback loops and delayed reaction to events.
- Higher risk of missed follow-ups during busy periods.

### Option B: Cron-triggered heartbeat — Inngest cron function that runs every N minutes and checks state

Pros:
- Predictable cadence simplifies budgeting, monitoring, and cost controls.
- Straightforward recovery path for missed or dropped events.
- Easier to reason about execution windows and rate limiting.

Cons:
- Adds latency between event occurrence and action.
- Can perform unnecessary polling when no meaningful work is pending.
- Coarser-grained responsiveness for time-sensitive follow-up tasks.

### Option C: Event-driven reactive loop — function triggered by terminal events (`loop.complete`, note captured, etc.) that evaluates next action

Pros:
- Fast reaction to fresh system signals and completed workflows.
- Avoids idle polling by running when meaningful events occur.
- Better alignment with existing event-bus architecture.

Cons:
- Requires robust deduplication and idempotency controls.
- Higher risk of event storms causing action cascades without strict guards.
- More complex observability for tracing cross-event orchestration chains.

### Option D: Always-on LLM session — persistent context window that receives all events

Pros:
- Strong continuity of context across many related events.
- Near real-time decisioning with minimal trigger latency.
- Centralized orchestration logic in one long-lived control loop.

Cons:
- Highest ongoing token and runtime cost profile.
- Largest safety and operational risk surface if control logic drifts.
- Harder to implement and operate reliably than event-triggered functions.

## Implementation Plan

1. Build a new Inngest gateway function `system/heartbeat` that can be invoked from two trigger paths: (a) cron schedule every 15-30 minutes and (b) terminal events such as `agent/loop.complete`, `agent/loop.retro.complete`, and `system/note`.
2. Add a deterministic state-gathering step that collects current orchestration inputs before any LLM call: note queue length, recent `slog` entries for the last execution window, pending retro recommendations, active loop runs, and a half-done inventory of interrupted or partially completed work.
3. Add an LLM decision step that receives only the gathered state and must choose exactly one action from a constrained action set: `start_loop`, `process_notes`, `apply_retro_recommendation`, `emit_alert`, or `do_nothing`.
4. Implement an action execution step that maps the selected action to a single Inngest event emit: `agent/loop.requested` for `start_loop`, `system/note.process.requested` for `process_notes`, `agent/loop.retro.apply.requested` for `apply_retro_recommendation`, `system/alert.requested` for `emit_alert`, and no dispatch for `do_nothing`.
5. Enforce safety rails in the gateway runtime: max actions per hour, LLM/token cost budget checks before dispatch, a human-approval gate for destructive actions, and always-log reasoning with state snapshot plus chosen action for auditability.
6. Add observability and replay hooks so each gateway run records trigger source (`cron` vs `event`), decision payload hash, action outcome, and safety-rail decisions, enabling post-incident replay and drift checks.

## Verification

- [ ] Triggering `system/heartbeat` from cron and from a terminal event both execute the same decision pipeline and produce a run log with the trigger source.
- [ ] State-gathering logs include note queue length, recent `slog` summary, pending retro recommendation count, active loop run count, and half-done inventory count for every run.
- [ ] The decision step rejects any action outside `start_loop|process_notes|apply_retro_recommendation|emit_alert|do_nothing` and records a validation error.
- [ ] For each allowed action except `do_nothing`, the gateway emits the expected Inngest event name exactly once per decision.
- [ ] Hourly rate-limit configuration blocks actions after the configured max and emits a safety alert instead of dispatching work.
- [ ] Budget checks prevent action dispatch when token or cost limits are exceeded and log the blocked reason.
- [ ] Destructive actions are blocked without explicit human approval and are only executed after approval state is present.
- [ ] Every run writes a structured reasoning log containing state summary, chosen action, and safety-rail decisions.
