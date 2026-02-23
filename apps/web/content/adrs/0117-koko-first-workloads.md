---
status: proposed
date: 2026-02-23
parent: ADR-0115
---

# ADR-0117: Koko First Workloads

## Context

Koko needs real work to prove the BEAM thesis. The workloads should be:
- **Low risk** — if Koko fails, the existing stack handles it
- **Observable** — clear success/failure signal
- **BEAM-advantaged** — demonstrate something the TypeScript stack does poorly
- **Self-contained** — minimal integration surface

## Decision

### Workload 1: Health pulse (process supervision demo)

Koko runs its own heartbeat — a GenServer that pings Redis, Typesense, and the Inngest API every 60 seconds. If any check crashes, the supervisor restarts it. This is the "hello world" of OTP fault tolerance.

**Why this first**: It's trivial, runs continuously, and immediately demonstrates supervisor restarts — something launchd/TypeScript can't do at function granularity.

**Success criteria**: Koko's health pulse runs for 7 days. Deliberately crash one check (e.g., bad Typesense URL). Verify supervisor restarts only that check, others continue unaffected.

### Workload 2: Event digest (process-per-event demo)

Koko accumulates events over a time window (e.g., 1 hour), then summarizes them via LLM call. Each accumulation window is its own process — if one crashes mid-summary, the next window starts fresh.

**Why this second**: Demonstrates process isolation for stateful work. The current TypeScript daily-digest function is a single Inngest step — if it fails, the whole function retries from scratch.

**Success criteria**: Koko produces a 1-hour event digest via req_llm. Compare quality/latency to the existing daily-digest function.

### Workload 3: File watcher (hot reload demo)

Koko watches a directory (e.g., `~/Vault/docs/decisions/`) for changes using `:fs` (Erlang filesystem events). On change, it reads the file and does something useful — e.g., validates ADR frontmatter, checks for broken cross-references.

**Why this third**: Demonstrates hot code reload. Update Koko's validation rules, reload the module, see it take effect without restart. The current content-sync-watcher is a launchd daemon that must be fully restarted for any code change.

**Success criteria**: Koko detects an ADR file change within 5 seconds, validates it, and logs the result. Hot-reload a validation rule without restarting the VM.

### Workloads explicitly deferred

- **LLM tool calling / coding agent** — too complex for early Koko. Needs ADR-0114 extension model design first.
- **Telegram interaction** — gateway owns this. Koko shouldn't touch it until graduation.
- **Oban job processing** — Koko doesn't need durable queuing until it has enough work volume.
- **Memory pipeline** — deeply intertwined with Inngest steps. Not a good early candidate.

## Consequences

- Three workloads that each demonstrate a distinct BEAM advantage (supervision, isolation, hot reload)
- All three are read-only or additive — they don't modify existing joelclaw state
- Each has clear success criteria for evaluating BEAM value
- Failure of any workload informs ADR-0114 with concrete evidence
