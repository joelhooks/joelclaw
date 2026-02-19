---
status: accepted
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - networking
  - webhooks
  - tailscale
  - joelclaw
---

# ADR-0051: Tailscale Funnel as Public Ingress for Webhooks

## Context

joelclaw runs on a Mac Mini behind a residential network with no static IP and no port forwarding. All services are reachable only over Tailscale (private mesh VPN). ADR-0048 introduced a webhook gateway so external services like Todoist can push events into the system, but the gateway needs a **publicly reachable HTTPS URL** to receive those webhooks.

### Constraints discovered during implementation

1. **Todoist requires standard port 443** — webhook callback URLs "must use HTTPS and cannot specify ports for security reasons." A URL like `https://host:8443/path` is rejected with `INVALID_ARGUMENT_VALUE`. This is common across webhook providers (GitHub, Stripe, etc. all expect :443).

2. **No public IP** — residential NAT, no port forwarding. Traditional approaches (static IP, cloud VM, DMZ) don't apply.

3. **Existing Caddy on :443** — Caddy already serves the Inngest dashboard, worker health, Qdrant, and Inngest Connect over Tailscale HTTPS on `panda.tail7af24.ts.net`.

### Options considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Tailscale Funnel** | Zero infra, already enabled on node, Tailscale handles TLS + DNS | Shares :443 namespace with Caddy (resolved via layered routing) |
| **B. Cloudflare Tunnel** | Battle-tested, path-based routing built in | New dependency, account setup, token management, DNS changes |
| **C. ngrok** | Quick setup, popular for dev | Paid for stable URLs, another dependency, ephemeral by default |
| **D. Cloud VM reverse proxy** | Full control | Ongoing cost, maintenance burden, latency hop |

## Decision

**Use Tailscale Funnel on port 443** with Caddy as a local path-routing layer.

### Architecture

```
Public Internet                    Mac Mini
                                  ┌─────────────────────────────────┐
Todoist POST ──→ Tailscale Edge   │                                 │
                 (TLS termination)│                                 │
                      │           │  Tailscale Funnel :443          │
                      └──────────▶│  → localhost:8443 (Caddy HTTP)  │
                                  │       │                         │
                                  │       ├─ /webhooks/*            │
                                  │       │  → localhost:3111       │
                                  │       │    (system-bus worker)  │
                                  │       │                         │
                                  │       └─ /* (default)           │
                                  │          → localhost:8288       │
                                  │            (Inngest dashboard)  │
                                  └─────────────────────────────────┘

Tailnet (private)
                                  ┌─────────────────────────────────┐
Browser ──→ panda.tail7af24.ts.net│  Caddy HTTPS :443               │
            (Tailscale direct)    │  → localhost:8288 (Inngest)     │
                                  │                                 │
            :3443                 │  → localhost:3111 (worker)      │
            :6443                 │  → localhost:6333 (Qdrant)      │
            :8290                 │  → localhost:8289 (Connect)     │
                                  └─────────────────────────────────┘
```

### Key insight: Funnel and Caddy coexist on :443

Tailscale Funnel intercepts traffic at the TUN interface layer (inside the Tailscale daemon), before packets reach the kernel TCP stack. Caddy binds to `*:443` at the OS level. They don't conflict because:

- **Public internet traffic** → Tailscale edge → DERP relay → Tailscale daemon → proxy to `localhost:8443` (Caddy HTTP, path routing)
- **Tailnet traffic** → direct WireGuard → OS TCP stack → Caddy HTTPS on `*:443` (existing TLS certs)

Public callers hit Funnel → Caddy HTTP. Tailnet callers hit Caddy HTTPS directly. Same machine, no port conflict.

### Configuration

**Caddy** (`~/.local/caddy/Caddyfile`):
```
http://localhost:8443 {
    handle /webhooks/* {
        reverse_proxy localhost:3111
    }
    handle {
        reverse_proxy localhost:8288
    }
}
```

**Tailscale**:
```bash
tailscale serve --bg --https 443 http://localhost:8443
tailscale funnel --bg 443 on
```

### Public webhook URL

```
https://panda.tail7af24.ts.net/webhooks/todoist
```

Standard HTTPS, port 443, no custom ports. Compatible with Todoist, GitHub, Stripe, and any webhook provider.

## Consequences

### Positive
- **Zero additional infrastructure** — no cloud VMs, tunnels, or third-party services
- **Tailscale handles TLS** — auto-provisioned certs, no manual renewal
- **Path-based routing** — easy to add new webhook providers (`/webhooks/github`, `/webhooks/stripe`)
- **Caddy as router** — familiar config, hot-reload, battle-tested reverse proxy
- **Tailnet access unchanged** — existing Caddy HTTPS blocks continue to work for all services
- **Persistent** — `tailscale serve` and `tailscale funnel` survive reboots (stored in Tailscale prefs)

### Negative
- **Tailscale dependency** — if Tailscale's edge is down, webhooks stop (acceptable for personal system)
- **Single ingress point** — all public traffic funnels through one path; no geographic redundancy
- **Funnel ports limited** — only 443, 8443, 10000 available (fine for webhooks on :443)

### Operational notes
- Monitor `~/.local/log/caddy.err` for routing issues
- `tailscale funnel status` to verify Funnel is active
- Worker logs at `~/.local/log/system-bus-worker.log` show webhook events
- Todoist HMAC verification requires `TODOIST_CLIENT_SECRET` — leased from agent-secrets in worker `start.sh`

## Related

- **ADR-0048**: Webhook Gateway for External Service Integration (the gateway this exposes)
- **ADR-0047**: Todoist as Async Conversation Channel (first consumer)
- **ADR-0049**: Gateway TUI via WebSocket (same session's work)
- Caddy skill: `~/.agents/skills/caddy/SKILL.md`
