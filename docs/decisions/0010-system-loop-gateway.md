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
Good: Autonomous action improves and feedback loops are faster because the system routes follow-on work immediately after terminal events. Bad: LLM call cost increases during event bursts and sweeps, runaway action risk grows if deduplication or rate limits are misconfigured, and operational complexity rises from coordinating two trigger paths. Neutral: Human operators can still override, pause, or cancel execution flows, so control remains available even with higher autonomy.

The note queue gets processed more consistently because the fallback heartbeat sweep closes event-delivery gaps. The risk of cascade behavior is mitigated by enforcing action limits per cycle and per time window. Safety constraints for this decision include: human override and cancel controls remain mandatory for high-impact or uncertain actions; action limits are enforced per cycle and per time window to prevent cascade behavior; and cost caps (daily/weekly budget and per-run token ceilings) are enforced before dispatching new work.

## Pros and Cons of the Options

### Option A: No system loop — keep human as gateway
- Pro: Lowest technical complexity, full human judgment on every decision, and minimal incremental LLM cost. Con: Throughput bottlenecked by human availability, slower feedback loops, and higher risk of missed follow-ups during busy periods.
- Pro: Simplest operational model with no automation risk. Con: System responsiveness is entirely constrained by manual attention windows.

### Option B: Cron-triggered heartbeat — Inngest cron function that runs every N minutes and checks state
- Pro: Predictable cadence simplifies budgeting and cost controls, with straightforward recovery for missed events. Con: Adds latency between event occurrence and action, and can perform unnecessary polling when no meaningful work is pending.
- Pro: Easier to reason about execution windows and rate limiting. Con: Coarser-grained responsiveness for time-sensitive follow-up tasks.

### Option C: Event-driven reactive loop — function triggered by terminal events (`loop.complete`, note captured, etc.) that evaluates next action
- Pro: Fast reaction to fresh system signals, avoids idle polling, and aligns with existing event-bus architecture. Con: Requires robust deduplication and idempotency controls, with higher risk of event storms causing action cascades.
- Pro: Better alignment with the reactive dispatch model already in use. Con: More complex observability for tracing cross-event orchestration chains.

### Option D: Always-on LLM session — persistent context window that receives all events
- Pro: Strong context continuity across related events, near real-time decisioning, and centralized orchestration logic. Con: Highest ongoing token and runtime cost profile, with largest safety and operational risk surface.
- Pro: Minimal trigger latency for time-critical decisions. Con: Harder to implement and operate reliably than event-triggered functions, and control logic drift increases over long sessions.
