---
status: proposed
date: 2026-02-14
decision-makers: Joel Hooks
---

# Establish a central system loop gateway for autonomous orchestration

## Context and Problem Statement

The current system has strong execution primitives but no autonomous orchestration layer that continuously turns system state into coordinated action. ADR-0005 established durable coding loops with explicit role boundaries and event-driven execution, and ADR-0007 strengthened those loops with better isolation, controls, and reliability. ADR-0008 added a retrospective path so completed runs can feed skill evolution and memory artifacts. Together, these decisions created substantial capability: the coding loop can implement and validate stories, the event bus can route and persist workflow events, the note queue can stage inbound work and context, and retrospective mechanisms can capture outcomes for future improvement.

What is missing is a central gateway that decides when and how these capabilities should run as a coherent system. Today, Joel is that gateway. Joel notices signals, interprets context, chooses priorities, decides which loop to trigger, resolves conflicts, and intervenes when quality or safety degrades. This manual gateway works, but it creates a bottleneck and limits continuity: orchestration quality depends on human availability, attention, and context switching capacity.

The OpenClaw architecture defines the missing control plane as a central LLM session loop that operates continuously on a structured control cycle: SENSE -> ORIENT -> DECIDE -> ACT -> LEARN. SENSE gathers events and telemetry from the bus, repositories, notes, and run history. ORIENT builds current state and constraints. DECIDE selects next actions and priority order. ACT dispatches pipelines (coding, ingestion, curation, repair) through existing execution systems. LEARN updates playbooks and operating heuristics based on observed outcomes.

This decision is driven by four system-level concerns: whether the loop should run always-on versus cron-triggered, how safety boundaries and failure containment are enforced, how runtime and model cost are controlled, and how human oversight remains explicit at key control points without requiring Joel to be the constant manual router for all loop activity.

Related decisions: ADR-0005 (durable coding loops), ADR-0007 (loop v2 improvements), ADR-0008 (retrospective and skill evolution).

## Decision Drivers

- Autonomous action capability: the system should select and trigger useful next actions without requiring Joel to manually route every transition.
- Safety and human oversight: the gateway must keep explicit human approval and override paths for destructive or high-impact actions.
- Cost control (LLM calls): orchestration cadence and model usage need hard limits so routine operation stays within budget.
- State awareness: loop decisions must reflect live state from runs, note queues, retrospectives, and recent event outcomes.
- Composability with existing pipelines: the loop should orchestrate current Inngest and coding-loop infrastructure instead of replacing proven execution paths.
- Graceful degradation: if one trigger mechanism is down or delayed, the system should continue with a safer fallback mode.

## Considered Options

### Option A: No system loop (human gateway only)
Keep Joel as the sole gateway who evaluates system state, manually ranks work, starts loops, retries failures, and sequences transitions between pipelines. Automation remains execution-only, so the system runs what Joel tells it to run but never decides on its own what to do next. This approach gives strong safety and human oversight but does not scale beyond what Joel can personally supervise and coordinate.

### Option B: Cron-triggered heartbeat
An Inngest cron function runs on a fixed schedule (every N minutes), gathers current system state from runs, note queues, and recent events, then uses an LLM call to decide whether to dispatch one of the allowed next actions. The model only reasons at scheduled intervals, which keeps behavior predictable and gives straightforward levers for cost and rate control. If the cron fires and there is nothing actionable, the function exits without dispatching, which reduces wasted inference and keeps the system idle when appropriate.

### Option C: Event-driven reactive loop
An orchestration function is triggered by terminal events, including `loop.complete`, note capture, retrospective completion, and failure signals, and immediately evaluates what action to take next. The loop reacts in near real-time as system state changes, while safety is enforced through a constrained action set and idempotent event handling that identifies duplicate or conflicting signals. This approach improves responsiveness and avoids polling overhead, but requires careful design to prevent cascading triggers or runaway event chains.

### Option D: Always-on LLM session
A persistent LLM context window runs continuously, ingesting all relevant events and updating its working state as signals arrive in real time. It can integrate context-rich orchestration decisions without delay, but requires robust guardrails and cost controls because inference is effectively continuous. This option gives the highest responsiveness and contextual awareness at the expense of significantly higher model cost and greater complexity in failure isolation.

## Decision Outcome

*To be determined after evaluation of options against decision drivers.*
