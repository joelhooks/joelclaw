---
status: proposed
date: 2026-02-22
tags: [agent-secrets, leases, otel, observability]
---

# ADR-0110: Agent-Secrets Lease Deduplication & OTEL Integration

## Context

The agent-secrets daemon accumulates thousands of stale leases because the system-bus worker (and other callers) acquire new leases on every restart without revoking old ones. With 24h TTLs and frequent restarts (~8/day), this produces 2,600+ active leases for 56 secrets.

Additionally, the daemon operates without any observability — crashes, restart cycles, and lease churn are invisible unless someone manually checks logs.

### Observed failure (2026-02-22)

- Daemon entered crash loop (3 restarts in 3 minutes) after an unauthorized signal attempt.
- launchd `KeepAlive` auto-healed but the zombie socket window caused ~2 min of downtime.
- 2,625 active leases found (2,206 with 24h TTL), 13MB audit log.
- Root cause of lease accumulation: `start.sh` and `serve.ts` both use `--ttl 24h` and create new leases on every worker restart.

## Decision

### 1. Lease deduplication by client_id + secret_name

When a client acquires a lease for a secret it already holds an active lease on, the daemon **replaces** the old lease (revoke + delete) rather than stacking a new one. This matches how most credential managers work.

- Lookup key: `(client_id, secret_name)` where the existing lease is not expired and not revoked.
- Old lease is silently revoked and removed from the map.
- Audit logs both the revocation (as `lease_replace`) and the new acquisition.
- No CLI changes needed — dedup is server-side behavior.

### 2. OTEL integration via joelclaw CLI

When `joelclaw` is available on the system, the daemon emits structured OTEL events for:

- `daemon.started` / `daemon.stopped` — lifecycle events
- `lease.acquired` / `lease.replaced` / `lease.expired` — lease operations (sampled — only replacements and errors at info level, routine acquires at debug)
- `daemon.crash_recovered` — when startup detects and removes a stale socket

Emission is best-effort (fire-and-forget exec) and never blocks daemon operation.

## Consequences

- Lease count drops from O(restarts × secrets × TTL) to O(unique clients × secrets).
- leases.json stays small (< 100 entries typically).
- Audit log growth slows proportionally.
- OTEL events make daemon health visible in `joelclaw otel list/search/stats`.
- No breaking changes to CLI or RPC protocol.
