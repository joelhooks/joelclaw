---
type: discovery
slug: supervision-trees-that-diagnose-their-own-failures
source: "https://github.com/beamlens/beamlens"
discovered: "2026-02-28"
tags: [repo, elixir, otp, beam, ai, observability, llm, monitoring, self-diagnosis, skills-architecture]
relevance: "Skill-based LLM monitoring inside OTP maps to Koko's supervision tree and mirrors joelclaw's own skill architecture"
---

# Supervision Trees That Diagnose Their Own Failures

Threshold alerts tell you *that* memory spiked. They don't tell you *why*. [Beamlens](https://github.com/beamlens/beamlens) by [Bradley Golden](https://github.com/bradleygolden) drops an LLM directly into your [OTP supervision tree](https://www.erlang.org/doc/design_principles/sup_princ) as a child process, gives it read access to the BEAM's internal state — [ETS](https://www.erlang.org/doc/apps/stdlib/ets) distributions, [scheduler](https://www.erlang.org/doc/system/system_principles#schedulers) utilization, [allocator](https://www.erlang.org/doc/apps/erts/erlang#memory/0) fragmentation, garbage collection stats — and lets it **investigate causes instead of flagging symptoms**. Production-safe by design: everything is read-only, no side effects, data stays in your infrastructure.

The architecture is a [Coordinator-Operator](https://hexdocs.pm/beamlens) pattern where each monitoring capability is a **skill** with its own system prompt and snapshot function. Fourteen built-in skills cover BEAM VM health, memory allocators, anomaly detection, ETS tables, GC, log analysis, OS metrics, overload detection, ports, supervisor trees, function tracing via [Recon](https://github.com/ferd/recon), and system events. Custom skills are a `@behaviour` implementation — define a `system_prompt/0` and a `snapshot/0`, and Beamlens weaves it into the investigation. The [Anomaly skill](https://hexdocs.pm/beamlens/Beamlens.Skill.Anomaly.html) learns your baseline and auto-triggers investigations when it detects statistical anomalies, rate-limited to prevent runaway [LLM](https://en.wikipedia.org/wiki/Large_language_model) costs.

What makes this clever: it uses [BAML](https://github.com/BoundaryML/baml) for type-safe LLM prompts with intent decomposition that separates fact from speculation. The [Lua](https://www.lua.org/) sandbox handles safe execution. Multiple [LLM providers](https://hexdocs.pm/beamlens/providers.html) are supported — [Anthropic](https://www.anthropic.com/), [OpenAI](https://openai.com/), [Gemini](https://ai.google.dev/), [Ollama](https://ollama.ai/) for local, [AWS Bedrock](https://aws.amazon.com/bedrock/), the works. A typical investigation costs one to three cents with [Haiku](https://www.anthropic.com/claude). Early development, [v0.3.1](https://hex.pm/packages/beamlens), [Apache-2.0](https://github.com/beamlens/beamlens/blob/main/LICENSE). The bet here is that LLM reasoning applied to runtime internals that external APM tools can't see produces better incident diagnosis than any amount of static rules.

## Key Ideas

- **LLM as supervised child process** — monitoring intelligence lives inside the app, not outside it, with access to internal state that external tools can't reach
- **Skill-based monitoring architecture** — each capability (BEAM health, ETS, GC, allocators, anomaly detection) is a pluggable skill with its own system prompt and snapshot, composable at the supervision tree level
- **Fact vs speculation decomposition** — [BAML](https://github.com/BoundaryML/baml) type-safe prompts separate what the LLM observed from what it inferred, keeping diagnosis honest
- **Auto-trigger on statistical anomaly** — the [Anomaly skill](https://hexdocs.pm/beamlens/Beamlens.Skill.Anomaly.html) learns baselines and triggers investigations without human intervention, rate-limited by default
- **Read-only production safety** — no side effects, no mutations, no backend phone-home; data stays in your infrastructure
- **[Lua sandbox](https://www.lua.org/) for safe execution** — execution boundaries that prevent the diagnostic layer from affecting the system it's diagnosing
- **Coordinator-Operator pattern** — separates investigation orchestration from data collection, with pluggable strategies ([AgentLoop](https://hexdocs.pm/beamlens) vs Pipeline)

## Links

- [beamlens/beamlens on GitHub](https://github.com/beamlens/beamlens)
- [Hex.pm package](https://hex.pm/packages/beamlens)
- [HexDocs](https://hexdocs.pm/beamlens)
- [Bradley Golden (author)](https://github.com/bradleygolden)
- [Roadmap](https://github.com/orgs/beamlens/projects/1)
- [BAML — type-safe LLM prompts](https://github.com/BoundaryML/baml)
- [Recon — Erlang production debugging](https://github.com/ferd/recon)
- [Early access waitlist](https://forms.gle/1KDwTLTC1UNwhGbh7)
