---
type: discovery
source: "https://builders.ramp.com/post/why-we-built-our-background-agent"
discovered: "2026-02-16"
tags: [article, ai, agents, infrastructure, build-vs-buy, agent-loops]
relevance: "validates custom background agent approach — Ramp made the same build-not-buy call as joelclaw's agent loop architecture"
---

# Build-Not-Buy for Background Coding Agents

Ramp's engineering team — Zach Bruggeman, Jason Quense, Rahul Sengottuvelu — published a piece on why they built their own background coding agent instead of adopting off-the-shelf tools. The framing is direct: **the craft of engineering is changing fast enough that custom agent infrastructure is a competitive advantage**, not overhead. Background agents that work autonomously, not just interactive copilots that autocomplete while you type.

The "background" distinction matters. Interactive coding assistants (Copilot, Cursor) are table stakes at this point. Background agents — the ones that pick up a task, run it to completion while you do something else, and come back with a PR — are a fundamentally different tool category. Ramp decided the existing options weren't giving them enough control or velocity, so they built their own. That's a meaningful signal from a company operating at real scale in fintech, where shipping velocity directly translates to revenue.

This maps closely to the agent loop architecture in joelclaw. Same core bet: **off-the-shelf agents don't give you enough control over the execution loop** — the planning, test-writing, implementation, review, and judgment cycle. When you need agents that work autonomously on stories from a PRD, you end up building custom infrastructure whether you planned to or not. Ramp apparently reached the same conclusion from a different starting point.

## Key Ideas

- **Background agents ≠ interactive copilots** — different category of tool with different infrastructure requirements
- **Build-not-buy signal** — a well-funded fintech engineering team chose to invest in custom agent tooling over adopting existing solutions
- **Velocity as the driver** — the explicit goal is accelerating faster, not cost reduction or headcount replacement
- **Engineering craft is the frame** — positioned as evolving the craft of engineering, not replacing engineers
- **Published January 2026** — early in the background agent wave, when most companies are still evaluating

## Links

- [Why We Built Our Own Background Agent — Ramp Builders](https://builders.ramp.com/post/why-we-built-our-background-agent)
- Authors: Zach Bruggeman ([@zachbruggeman](https://x.com/zachbruggeman)), Jason Quense, Rahul Sengottuvelu
