---
status: proposed
date: 2026-02-23
parent: ADR-0114
---

# ADR-0115: Koko — Elixir Agent Project Charter

## Context

ADR-0114 evaluates a full Elixir/BEAM migration for joelclaw. That's a 6-18 month commitment with unclear ROI. But the BEAM's process model is genuinely compelling for agent infrastructure — and the only way to validate that is to build something real.

Koko is the low-stakes answer: an Elixir OTP application that lives alongside joelclaw on Overlook, connects to the existing Redis event bridge, and gradually picks up real work. Not a migration. Not a rewrite. A co-resident agent that proves (or disproves) the BEAM thesis with actual joelclaw workloads.

## Decision

### What Koko is

- An Elixir/OTP application at `~/Code/joelhooks/koko`
- A supervised process tree running alongside the existing TypeScript stack
- A consumer of joelclaw's existing Redis event bus — it observes events and can claim work
- A proving ground for BEAM patterns (supervision, hot reload, process isolation, fault tolerance)
- Fun

### What Koko is not

- A migration of joelclaw — the TypeScript stack remains primary
- A replacement for Inngest — Koko does not orchestrate existing functions
- A gateway replacement — Telegram routing stays in TypeScript
- Production-critical — if Koko crashes, nothing breaks. The existing stack doesn't depend on it.

### Graduation criteria

Koko graduates from toy to "real component" when it:
1. Successfully handles at least 3 distinct workload types end-to-end
2. Demonstrates fault recovery that the TypeScript stack can't match (supervisor restart of a crashed worker)
3. Runs for 7+ days unsupervised without manual intervention
4. Joel says "I'd rather Koko did this than the TypeScript version"

At graduation, Koko gets a launchd plist and becomes a peer to system-bus-worker.

### Tech stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Erlang/OTP 27 + Elixir 1.18.4 | Current stable, mise-managed |
| Redis client | Redix | Lightweight, well-maintained |
| LLM client | req_llm | Composable, multi-provider, built on Req |
| Job processing | Oban (evaluate later) | Not needed until Koko has enough work to need queuing |
| JSON | Jason | Standard |

### Naming

Koko — after the gorilla who learned sign language. Listens, learns, does work. Signs back.

## Consequences

- Koko adds zero operational burden to joelclaw — it's an independent OTP app
- Learning Elixir/OTP happens through real work, not tutorials
- If BEAM proves its value, ADR-0114 gets concrete evidence for Strategy B (hybrid)
- If Koko stalls or proves BEAM isn't worth it, we kill it cleanly — no migration debt
