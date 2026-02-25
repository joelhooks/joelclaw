---
status: proposed
date: 2026-02-23
---

# ADR-0114: Elixir/BEAM/Jido Migration — Full Architecture Evaluation

## Context

joelclaw is a personal AI operating system built in TypeScript. After 100+ ADRs and ~40k LOC of system-bus functions, a recurring theme has emerged: **a significant fraction of the infrastructure exists to compensate for problems the BEAM VM solves natively.**

Specific pain points that BEAM eliminates by design:

| Current Pain | Root Cause | BEAM Native Solution |
|---|---|---|
| launchd daemons (5+) for process management | Node.js is one-process-per-service | OTP supervisors — unlimited lightweight processes in one VM |
| Worker clone sync workflow (push → fetch → reset → kickstart → PUT sync) | Can't hot-reload a running Bun process | Hot code reload — deploy without restart |
| Redis pub/sub dual-client hack | ioredis subscription blocks the client | Process mailboxes — every process has built-in messaging |
| Gateway session file persistence (`~/.joelclaw/gateway.session`) | pi sessions are stateful and fragile | GenServer state — survives crashes via supervisor restart |
| Inngest as external orchestrator (k8s pod, function registry sync, stale registration) | No built-in durable execution in Node.js | OTP — Task, GenServer, Supervisor provide durable execution natively |
| Priority queue in Redis sorted sets (ADR-0104) | No native priority mailbox | `receive` with pattern matching on priority tuples |
| Concurrency guards via Redis keys + TTLs | No process-level isolation | Process-per-resource — each has isolated state, no shared memory |
| Notification dedup via Redis cooldowns | Shared-nothing requires external coordination | Process state — cooldown timers live in the process, no Redis round-trip |
| Tripwire/watchdog for gateway health | Process crashes are silent and unrecoverable | Supervisors with restart strategies — crash recovery is the default |
| Extension reload requires session kill + daemon restart | pi loads extensions once at session start | Hot code reload — update modules in the running VM |

The [Jido framework](https://github.com/agentjido/jido) provides an Elixir-native agent architecture with:
- **Agents as 25KB processes** (GenServer-backed, supervisor-managed)
- **Signal-based communication** (CloudEvents-compliant, type-routed)
- **Directive system** (Emit, Spawn, Schedule — pure functional core, effectful runtime)
- **Plugin architecture** (composable capability bundles with state, actions, routes)
- **Built-in observability** (telemetry events, OTEL tracer behavior, debug mode)
- **FSM strategies** (state machine workflows — maps to gateway state management)
- **Worker pools** (pre-warmed agent pools — maps to webhook/event processing)
- **Memory and identity plugins** (built-in, maps to current memory system)

## Current System Inventory

### What exists today

| Component | Tech | LOC | Files | Complexity |
|-----------|------|-----|-------|------------|
| Event bus functions | Inngest + TypeScript | ~34k | 63 | High — durable steps, retries, cron, fan-out |
| Gateway daemon | pi session + launchd | ~3k | 8 | High — Telegram, Redis bridge, session mgmt |
| CLI | Effect-TS + Bun | ~8k | 25 | Medium — 30+ commands, HATEOAS output |
| Web app | Next.js + Convex | ~5k | 40 | Medium — MDX, auth, real-time dashboard |
| Memory system | Typesense + Redis | ~2k | 6 | Medium — observe, reflect, promote, triage |
| Webhook server | Express + providers | ~1.5k | 10 | Low — signature verify, dispatch |
| Cache layer (ADR-0112) | Redis + file | ~350 | 1 | Low — just shipped |
| Infrastructure glue | launchd, k8s, bash | ~500 | 15 | High — fragile, stateful, manual |

### External dependencies that complicate migration

| Dependency | Current Role | Migration Difficulty |
|-----------|-------------|---------------------|
| **Inngest** | Event orchestration, durable execution, cron, retry | Hard — 74 functions, deeply integrated step patterns |
| **Convex** | Real-time DB for web app (schema, queries, auth) | Hard — tight coupling with Next.js frontend |
| **pi** | Agent coding harness (tool use, sessions, extensions) | Very Hard — no Elixir equivalent exists |
| **Vercel** | CDN, ISR, edge functions for Next.js | Medium — Phoenix deployment is different |
| **Telegram Bot API** | Primary human interface | Easy — HTTP API, language-agnostic |
| **Front API** | Email integration | Easy — HTTP API |
| **Todoist API** | Task management | Easy — HTTP API |
| **Typesense** | Search + vector store | Easy — HTTP API |
| **Redis** | Cache, pub/sub, state | Partially eliminated — keep for cache, drop pub/sub |

## What BEAM/Jido Replaces Naturally

### Tier 1: Direct replacements (high confidence, clear win)

**Inngest → OTP Supervision Tree**
- Each of 74 functions becomes a GenServer or Task under a supervisor
- Cron schedules via [Quantum](https://github.com/quantum-elixir/quantum-core) (mature, production-proven)
- Retries via supervisor restart strategies + exponential backoff in process
- Step functions → sequential `with` chains or Jido Strategy FSM states
- Fan-out → `Task.Supervisor.async_stream_nolink/3`
- Concurrency limits → process-per-resource with GenServer call serialization
- **Eliminates: Inngest k8s pod, function registry sync, PUT sync, stale registration bugs**
- **Risk: Lose Inngest dashboard (run traces, step visualization). Must build equivalent.**

**Redis pub/sub → Phoenix.PubSub / process messaging**
- Gateway event bridge becomes PubSub topic subscription
- No more dual-client ioredis hack
- No more LPUSH/LRANGE drain pattern
- **Eliminates: Redis subscription client, gateway drain logic**

**launchd daemons → OTP Application**
- system-bus-worker, gateway, gateway-tripwire, content-sync-watcher, vault-log-sync, typesense-portforward — all become child processes in one supervision tree
- Single `mix release` produces one deployable artifact
- **Eliminates: 5+ launchd plists, PID management, session files, kickstart commands**

**Priority queue (ADR-0104) → process mailbox**
```elixir
def handle_info({:message, priority, payload}, state) do
  state = %{state | queue: PriorityQueue.push(state.queue, priority, payload)}
  {:noreply, drain(state)}
end
```
- Starvation prevention, dedup, coalescing — all in-process state
- **Eliminates: Redis sorted set, SHA-256 dedup window, aging promotion logic**

**Webhook server → Phoenix/Plug**
- Plug pipeline for signature verification
- Pattern-match dispatch to handlers
- Each provider becomes a Plug module
- **Eliminates: Express server, provider registry**

### Tier 2: Good fit but requires design work

**Gateway agent → Jido Agent with Telegram plugin**
- Gateway becomes a long-lived Jido Agent process
- Telegram channel as a Jido Signal adapter (inbound) + Action (outbound)
- MCQ flows as FSM Strategy states
- Session state in GenServer, not Redis + files
- **Risk: No pi integration. How does the agent write code?**

**Memory system → Jido Memory plugin + Typesense**
- Observe/reflect/promote pipeline maps to Jido Agent with memory plugin
- Typesense stays as search backend (HTTP API, language-agnostic)
- Proposal triage becomes a Jido Strategy FSM
- **Risk: Current memory pipeline is deeply intertwined with Inngest step patterns**

**Cache layer (ADR-0112) → ETS / Cachex**
- [Cachex](https://github.com/whitfin/cachex) provides TTL, warm/cold tiers, stats
- ETS for hot cache (faster than Redis for local reads)
- File cache stays for warm tier
- **Eliminates: Redis cache keys, cache.ts module**

### Tier 3: Difficult / unclear benefit

**Web app (Next.js → Phoenix LiveView)**
- Full rewrite of apps/web (~5k LOC, 40 files)
- MDX pipeline → Earmark + custom transformers (thinner plugin ecosystem)
- Convex real-time → LiveView sockets (comparable but different DX)
- Vercel CDN/ISR → self-hosted Phoenix or Fly.io
- Auth (Better Auth) → Phoenix auth generators or custom
- **Risk: High effort, uncertain payoff. The web layer works fine.**

**Agent coding interface (pi/codex → ???)**
- pi is the coding agent harness — tool use, file I/O, sessions, extensions
- Jido Shell exists (virtual workspace, command execution) but is early
- No equivalent of codex exec in Elixir ecosystem
- Could use Jido AI + Jido Shell + LLM Actions for a custom agent loop
- **Risk: Very high. This is the creative heart of the system. Building a coding agent from scratch is a multi-month project.**

**CLI (Effect-TS → Mix tasks or Burrito)**
- [Burrito](https://github.com/burrito-elixir/burrito) for standalone CLI binary
- Mix tasks for development
- Effect's structured error handling → `with` chains + tagged tuples
- HATEOAS output → Jason encoding of response structs
- **Risk: Medium. CLI is well-tested and stable. Rewriting is friction without clear gain.**

## Migration Strategies

### Strategy A: Full rewrite (12-18 months)

Replace everything. Single Elixir umbrella app.

| Phase | Duration | Scope |
|-------|----------|-------|
| 0. Proof of concept | 2 weeks | One Jido Agent running heartbeat, connected to Redis |
| 1. Event bus | 6 weeks | All 74 functions as OTP processes, kill Inngest |
| 2. Gateway | 4 weeks | Jido Agent with Telegram, kill launchd daemons |
| 3. Memory | 3 weeks | Observe/reflect/promote as Jido pipeline |
| 4. Web | 8 weeks | Phoenix LiveView, kill Next.js/Vercel/Convex |
| 5. Agent coding | 8+ weeks | Custom coding agent on Jido, kill pi dependency |
| 6. CLI | 3 weeks | Mix tasks + Burrito binary |

**Total: ~34 weeks.** Highly ambitious. System is offline-capable for nothing during migration.

### Strategy B: Hybrid — BEAM backend, keep JS frontend (6-8 months)

Replace the infrastructure layer where BEAM wins. Keep the web frontend.

| Phase | Duration | Scope |
|-------|----------|-------|
| 0. Proof of concept | 2 weeks | Jido Agent running heartbeat |
| 1. Event bus | 6 weeks | 74 functions → OTP, kill Inngest |
| 2. Gateway | 4 weeks | Jido Agent with Telegram adapter |
| 3. Memory | 3 weeks | Pipeline as Jido Agents |
| 4. API layer | 2 weeks | Phoenix API serving Next.js frontend |
| 5. CLI bridge | 2 weeks | Elixir CLI or keep TS CLI calling Phoenix API |

**Total: ~19 weeks.** Next.js stays on Vercel. Convex stays. pi/codex stay for coding tasks. BEAM handles all backend orchestration.

### Strategy C: Incremental strangler — one function at a time (ongoing)

Run Elixir alongside TypeScript. Migrate functions incrementally.

| Step | Scope |
|------|-------|
| 1. Elixir app with Phoenix.PubSub subscribing to Redis events | Bridge |
| 2. Migrate simplest functions first (heartbeat, system-logger, daily-digest) | 3-5 functions |
| 3. Gradually move more functions, one at a time | Months |
| 4. When >50% migrated, evaluate killing Inngest | Decision point |

**Total: open-ended.** Low risk, but carries the cost of running two runtimes indefinitely. Operational complexity increases before it decreases.

## What You Gain

1. **Single runtime** — one BEAM VM replaces Inngest pod + Bun worker + gateway daemon + 5 launchd services
2. **True fault tolerance** — supervisor trees replace tripwire/watchdog/heartbeat recovery machinery
3. **Hot code reload** — deploy without restart, no stale function registry, no session kill
4. **Process isolation** — each function, each webhook, each agent session — isolated heap, crash one ≠ crash all
5. **Native concurrency** — no Redis pub/sub hack, no dual-client, no LPUSH/LRANGE drain
6. **Dramatic infra simplification** — kill: Inngest k8s pod, 5+ launchd plists, worker clone sync, gateway session files, Redis pub/sub layer
7. **Jido-native agent patterns** — signal routing, directive execution, plugin architecture, FSM strategies all align with joelclaw's signal→action→effect pattern
8. **LiveBook for exploration** — interactive notebooks for system debugging (Elixir's Jupyter equivalent)

## What You Lose

1. **Inngest dashboard** — best-in-class run visualization. Must build equivalent or use Grafana/custom telemetry.
2. **TypeScript ecosystem** — npm is vast. Hex.pm is smaller. Some integrations (Convex SDK, next-mdx-remote, shiki) have no Elixir equivalent.
3. **Vercel CDN + ISR** — Phoenix can be fast but no automatic edge network. Fly.io is the closest equivalent.
4. **pi/codex integration** — the entire coding-agent loop is TypeScript-native. No Elixir equivalent at comparable maturity.
5. **Momentum** — 74 functions, 40k LOC, 100+ ADRs of decisions encoded in the current stack. Migration cost is real and the current system works.
6. **Convex real-time** — LiveView is comparable but losing Convex means losing its conflict resolution, transactional guarantees, and managed hosting.
7. **Effect-TS patterns** — structured error handling, dependency injection, schema validation. Elixir has equivalents (`with`, application config, NimbleOptions) but different idioms.
8. **Team familiarity** — Joel and all current agent tooling are TypeScript-native.

## Jido Framework Assessment

### Strengths for joelclaw
- **Agent-as-process model** perfectly maps to gateway, memory pipeline, and function workers
- **Signal routing** (CloudEvents-based) directly replaces Inngest event dispatch
- **Directive system** (Emit, Spawn, Schedule) maps to current event fan-out patterns
- **Plugin architecture** allows incremental capability addition (memory, identity, chat)
- **Built-in telemetry** with OTEL tracer behavior — no custom o11y-logging skill needed
- **FSM Strategy** maps to gateway state management (idle → processing → responding → idle)
- **Worker pools** for high-throughput webhook/event processing
- **25KB per agent** — could run hundreds of specialized agents (one per integration) in one VM

### Gaps / Risks
- **Maturity**: Jido is ~1 year old, single maintainer (Mike Hostetler). GitHub stars ~250. Production usage unclear beyond demos.
- **jido_ai**: LLM integration exists but unclear depth — tool calling, streaming, multi-provider support?
- **jido_memory**: Exists but documentation thin. May need to build memory pipeline from scratch on top of Jido primitives.
- **jido_shell**: Virtual filesystem shell — interesting for sandboxed code execution but not a pi replacement.
- **No coding agent**: Jido has no equivalent of pi/codex for autonomous code generation. This would be a ground-up build.
- **Community**: Small. If Mike stops maintaining it, we're on our own. Compare to Inngest (funded company, active development).

## Cost/Benefit Summary

| Factor | Full Rewrite | Hybrid | Strangler |
|--------|-------------|--------|-----------|
| Infra simplification | ★★★★★ | ★★★★ | ★★ |
| Risk | ★★★★★ | ★★★ | ★ |
| Calendar time | 12-18 months | 6-8 months | Ongoing |
| Operational complexity during migration | High | Medium | High (two runtimes) |
| Web layer disruption | Total | None | None |
| Agent coding disruption | Total | None | None |
| Inngest dashboard loss | Immediate | Immediate | Gradual |

## Open Questions

1. **Is Jido production-ready?** Single maintainer, ~1 year old. What happens if it's abandoned?
2. **Can Jido AI handle the LLM integration depth we need?** Tool calling, streaming, multi-provider, structured output?
3. **What's the coding agent story?** Without pi/codex, how do agent loops write code? Jido Shell + LLM Actions?
4. **Is the web layer worth migrating?** Next.js + Vercel works. Phoenix LiveView is good but rewriting the site is pure cost.
5. **What about Convex?** Keep it for the web frontend? Replace with Ecto + Postgres? Both have trade-offs.
6. **Can we justify 6-8 months of migration for a personal system?** The current system works. Is the maintenance burden high enough to warrant this?
7. **Would starting from Elixir primitives (without Jido) be simpler?** OTP + Phoenix + Oban (for job processing) is a mature, proven stack. Jido adds agent abstractions but also adds a dependency risk.

## Alternatives Considered

### Option A: Jido (full agent framework)
- Agent-as-process, signals, directives, plugins, FSM strategies
- ~1 year old, single maintainer, ~250 stars
- Ecosystem: jido_ai, jido_memory, jido_shell, jido_chat
- **Pro**: Strongest agent abstractions, signal routing maps to Inngest events
- **Con**: Young, small community, unclear production usage. Dependency risk.

### Option B: OTP + Oban + Phoenix (recommended if migrating)
- [Oban](https://github.com/oban-bg/oban) — mature, funded, production-proven job processor. Direct Inngest replacement with durable jobs, cron, retries, priorities, workflows (fan-out/fan-in), queue isolation, telemetry. Oban Web provides dashboard (replaces Inngest dashboard).
- [LangChain Elixir](https://github.com/brainlid/langchain) — LLM integration (OpenAI, Anthropic, Google, Bumblebee). Maintained by Mark Ericksen (Fly.io). 2+ years, production-used.
- Raw OTP GenServers for gateway agent, memory pipeline, long-lived processes
- Phoenix LiveView for web (or keep Next.js, Phoenix serves API)
- Cachex/ETS replaces Redis cache. Phoenix.PubSub replaces Redis pub/sub.
- **Pro**: Battle-tested stack, no dependency on young frameworks. Oban is 6+ years old with thousands of production deployments.
- **Con**: No pre-built agent patterns. ~500 lines of custom GenServer code to build signal routing / directive execution.
- **Assessment**: AppUnite and George Guimarães both conclude the Elixir community doesn't need agent frameworks — OTP primitives are the agent framework. "Effective agent-based systems rely on software architecture... teams should retain control over system design."

### Option C: SwarmEx
- Lightweight agent orchestration, early stage, author acknowledges bugs
- **Pro**: Minimal. **Con**: Not production-ready. Skip.

### Option D: Stay TypeScript, reduce infrastructure
- Replace Inngest with [Trigger.dev](https://trigger.dev) or self-hosted Temporal
- Simplify launchd to fewer services
- Accept the maintenance burden as cost of TypeScript ecosystem benefits
- **Pro**: No migration. Incremental improvements.
- **Con**: Fundamental process model limitations remain.

### Option E: Deno + TypeScript
- Better process model than Node/Bun
- Still single-threaded per isolate
- Doesn't solve the fundamental "processes as first-class" problem
- **Pro**: Stay in TypeScript. **Con**: Marginal improvement.

## Consequences

This ADR is in **researching** status. No decision has been made.

Next steps if pursuing further:
1. Build a proof-of-concept: single Jido Agent running heartbeat, connected to existing Redis
2. Evaluate Jido AI for LLM tool calling depth
3. Benchmark: one Inngest function vs equivalent Jido Agent (latency, memory, observability)
4. Talk to Mike Hostetler about Jido roadmap and production usage
5. Prototype Telegram adapter as Jido Signal plugin
