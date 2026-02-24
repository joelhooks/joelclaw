---
type: discovery
slug: why-running-agents-on-a-single-branch-can-be-faster-than-worktrees
source: "https://x.com/bholmesdev/status/2025988271776383275"
discovered: "2026-02-24"
tags: [article, ai, agentic-engineering, multi-agent, git, codex, workflow, sandboxing, system-ops]
relevance: "For Joel's [[agent-loop]] flow, this is a concrete policy: keep loops on one [main branch](https://git-scm.com/docs/git-branch) with strict task boundaries first, then switch to sandboxed parallelism when concurrent GUI testing causes collisions."
---

# Why Running Agents on a Single Branch Can Be Faster Than Worktrees

[Ben Holmes](https://x.com/BHolmesDev)'s note on [his X thread](https://x.com/bholmesdev/status/2025988271776383275) is a sharp counterpoint to the “more branches + more orchestration” instinct. In [Peter Steinberger](https://steipete.me/)'s setup, there is one [Git](https://git-scm.com/docs/git) repository, one live dev server, one checked-out [main branch](https://git-scm.com/docs/git-branch), and multiple [OpenAI Codex](https://en.wikipedia.org/wiki/OpenAI_Codex)-style agents at once.

The move is subtle but useful: complexity shifts from infrastructure to **task boundaries**. He gives each agent a narrowly defined job, lets them commit changes on shared ground, and validates with atomic, file-scoped commits. That keeps output reviewable without paying branch and worktree overhead just to make multiple agents move in parallel.

The weak point appears when concurrency needs direct UI control. The post explicitly calls out native app testing as the moment where parallel on one branch becomes brittle. In practice for [joelclaw](https://joelclaw.com), the useful pattern is clear: start lean with one branch, then add [Git worktrees](https://git-scm.com/docs/git-worktree) or [cloud sandboxing](https://github.com/features/codespaces) only when interaction collisions rise.

## Key Ideas

- **One branch is viable when tasks are explicit**: keep [agent orchestration](https://en.wikipedia.org/wiki/Agentic_AI) in the task definitions and you can avoid a lot of branch churn while still preserving safety.
- **Atomic, file-scoped commits are a practical brake**: each agent's touched files become the merge unit, reducing cross-agent ambiguity and lowering review friction.
- **Parallelism should be constrained by test mode**: when work is GUI-bound or requires a real cursor/mouse loop, moving some agents to isolated runtime environments prevents accidental clobbering.
- **Branch-per-agent is a scaling lever, not a starting point**: treat isolation as escalation, not default, and keep the developer loop fast until contention proves the extra ceremony is worth it.

## Links

- [Source post on X](https://x.com/bholmesdev/status/2025988271776383275)
- [Linked article view](https://x.com/i/article/2025986700158353408)
- [Ben Holmes on X](https://x.com/BHolmesDev)
- [Peter Steinberger](https://steipete.me/)
- [joelclaw system events](/system/events)
- [Git branch docs](https://git-scm.com/docs/git-branch)
- [Git worktree docs](https://git-scm.com/docs/git-worktree)
- [Cloud sandboxing context in GitHub Codespaces](https://github.com/features/codespaces)
- [joelclaw discovery index](https://joelclaw.com/cool)
- [joelclaw ADR index](https://joelclaw.com/adrs)
- [Agentic AI overview](https://en.wikipedia.org/wiki/Agentic_AI)
- [OpenAI Codex reference](https://en.wikipedia.org/wiki/OpenAI_Codex)
