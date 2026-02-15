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
