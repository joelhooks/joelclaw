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
