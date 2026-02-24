---
type: discovery
slug: rule-engines-that-keep-humans-in-the-loop-at-scale
source: "https://github.com/roostorg/osprey"
discovered: "2026-02-24"
tags: [repo, tool, trust-safety, event-processing, infrastructure, python, rust, ai, operator-oversight]
relevance: "This is a direct reference architecture for [joelclaw](https://joelclaw.com/system) because it separates automatic action from human review and keeps a queryable trail of operator verdicts before escalated enforcement."
---

# Rule Engines That Keep Humans in the Loop at Scale

Most event pipelines die not on volume, but on ambiguity. [Osprey](https://github.com/roostorg/osprey), built by [ROOST](https://roost.tools), is explicit about that: automate the obvious and investigate what your models can’t decide confidently. That framing is simple, and it’s why this project feels different from the usual “one more rules engine” repos.

The architecture is intentionally practical: a [Rust](https://www.rust-lang.org/) coordinator and a [Python](https://www.python.org/) worker layer, with decisions driven by rule logic that can be extended through [UDFs](https://en.wikipedia.org/wiki/Function_(programming)) and persisted state via an optional labels backend (the sample uses [PostgreSQL](https://www.postgresql.org/)). The design keeps the hot path fast while still letting operators query outcomes, actions, and past decisions in a way that supports both incident response and auditability.

Given how [joelclaw](/system) already treats [events](/system/events) as first-class system objects, this reads like a usable safety layer pattern. You get the same shape of problem—streaming ambiguous behavior, possible enforcement, and rollback risk—and Osprey shows a route where humans can keep control without bottlenecking the whole stream.

## Key Ideas

- **Automate the obvious, inspect the ambiguous**: Osprey’s core bet is a split between deterministic policy execution and operator-led investigation, which is a sane pattern for safety-critical systems.
- **Language + plugin model**: Rule logic is extendable through [custom functions](https://github.com/roostorg/osprey/tree/main/example_plugins/src) instead of hard-coding every hypothesis.
- **Stateful decisions at scale**: The labels service model supports cross-event continuity so actions can reference prior history, not just single-event snapshots.
- **Dual-language implementation**: The [`osprey_coordinator`](https://github.com/roostorg/osprey/tree/main/osprey_coordinator) (Rust) + [`osprey_worker`](https://github.com/roostorg/osprey/tree/main/osprey_worker) (Python) split is a performance + flexibility compromise that other rule systems often avoid.
- **Built for operational review**: The project explicitly values UI-driven investigation and effect testing, not just batch simulation.
- **Open collaboration model**: ROOST and [Discord](https://discord.com) using a production safety problem as the core open-source example lowers the usual “this is a research toy” risk.

## Links

- Source: [https://github.com/roostorg/osprey](https://github.com/roostorg/osprey)
- Organization: [https://roost.tools](https://roost.tools)
- Upstream context: [Discord](https://discord.com)
- Collaborator: [internet.dev](https://internet.dev/)
- Example docs: [https://github.com/roostorg/osprey/tree/main/docs](https://github.com/roostorg/osprey/tree/main/docs)
- UI reference: [https://github.com/roostorg/osprey/blob/main/docs/images/query-and-charts.png](https://github.com/roostorg/osprey/blob/main/docs/images/query-and-charts.png)
- Related joelclaw surface: [joelclaw events](https://joelclaw.com/system/events)
- Internal follow-up spot: [/adrs/rule-engine-review.md](/adrs/rule-engine-review.md)
- Related discovery hub: [/cool/rule-engines](/cool/rule-engines)
