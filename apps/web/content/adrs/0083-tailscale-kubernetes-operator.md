---
status: proposed
date: 2026-02-20
decision-makers: Joel
tags:
  - adr
  - infrastructure
  - tailscale
  - k8s
  - networking
type: adr
---

# ADR-0083: Tailscale Kubernetes Operator for Service Mesh

## Context

The joelclaw k8s cluster (Talos on Colima, Mac Mini) exposes services via a 6-hop chain:

```
Tailnet device → Tailscale → panda:port → Caddy HTTPS → localhost:port
  → Lima SSH mux → Docker port map → Talos NodePort → Pod
```

This works but has compounding friction:

1. **Docker port maps are immutable** — adding a new service port requires full cluster recreation (`talosctl cluster destroy` + recreate with new `--exposed-ports`). This is the #1 operational pain point.
2. **Lima SSH mux is a single point of failure** — killing any process on a forwarded port can take down ALL tunnels.
3. **Every new service needs 3 manual steps**: Docker port mapping, NodePort service, Caddy HTTPS entry.
4. **No per-service access control** — once you can reach panda, you can reach everything.
5. **Adding Typesense (ADR-0082) requires cluster recreation anyway** — perfect opportunity to fix the networking layer.

Current port inventory (all require Docker mapping + Caddy):

| Service | Ports | Caddy HTTPS |
|---------|-------|-------------|
| Redis | 6379 | direct (no TLS) |
| Qdrant | 6333, 6334 | :6443 |
| Inngest | 8288, 8289 | :9443, :8290 |
| LiveKit | 7880, 7881 | :7443 |
| PDS | 9627→3000 | port-forward |
| Worker | 3111 | :3443 |
| **Typesense (new)** | **8108** | **would need entry** |

That's 12 port mappings across 7 services, each requiring manual Docker + Caddy config.

## Decision

Deploy the [Tailscale Kubernetes Operator](https://tailscale.com/kb/1439/kubernetes-operator-cluster-ingress) to the joelclaw cluster. Each k8s service gets a first-class Tailscale identity, accessible from any tailnet device via MagicDNS. Eliminates Docker port mapping, Lima tunneling, and most Caddy config.

### How It Works

```
                  Tailscale Control Plane
                         │
            ┌────────────┼────────────┐
            │            │            │
     ┌──────▼──┐  ┌──────▼──┐  ┌─────▼────┐
     │  panda  │  │clanker  │  │  laptop   │
     │(Mac Mini│  │  -001   │  │  /phone   │
     └────┬────┘  └─────────┘  └───────────┘
          │
    ┌─────▼─────────────────────────────┐
    │  Colima VM → Talos k8s cluster    │
    │                                   │
    │  ┌──────────────────────┐         │
    │  │ Tailscale Operator   │         │
    │  │ (watches annotations)│         │
    │  └──────────┬───────────┘         │
    │             │ creates              │
    │  ┌──────────▼───────────┐         │
    │  │ Per-service proxies  │         │
    │  │ redis.ts.net         │         │
    │  │ inngest.ts.net       │         │
    │  │ typesense.ts.net     │         │
    │  │ livekit.ts.net       │         │
    │  └──────────────────────┘         │
    └───────────────────────────────────┘
```

### Service Exposure

Each service gets exposed by adding one annotation:

```yaml
metadata:
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "typesense"
spec:
  type: ClusterIP  # NOT NodePort — no port mapping needed
```

Result: `typesense.tail7af24.ts.net:8108` — accessible from any tailnet device.

### What Changes

| Before (NodePort + Caddy) | After (Tailscale Operator) |
|---|---|
| Add Docker port map → cluster recreation | `kubectl annotate svc` → done |
| Configure Caddy HTTPS entry | Tailscale provides TLS automatically |
| Lima SSH mux tunnels all ports | Direct WireGuard mesh, no tunneling |
| NodePort on every service | ClusterIP (simpler, no port conflicts) |
| One IP for all services (panda) | Each service gets own tailnet identity |
| No per-service ACLs | Tailscale ACL tags per service |

### Installation

```bash
# One-time: create OAuth client in Tailscale admin console
kubectl create namespace tailscale
kubectl create secret generic tailscale-oauth \
  --namespace tailscale \
  --from-literal=clientId=$TS_OAUTH_ID \
  --from-literal=clientSecret=$TS_OAUTH_SECRET

helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale \
  --set oauth.clientId=$TS_OAUTH_ID \
  --set oauth.clientSecret=$TS_OAUTH_SECRET
```

### Resource Cost

- Operator pod: ~50m CPU, 64Mi memory
- Per-service proxy: ~10m CPU, 20Mi memory each
- 6 services × 20Mi = ~120Mi total proxy overhead
- Well within Mac Mini's 64GB capacity

### Migration Plan

Deploy alongside the Typesense rollout (ADR-0082) during the cluster recreation:

1. **Create OAuth client** in Tailscale admin console with `tag:k8s-service` tag
2. **Recreate cluster** with Typesense port (8108) — last time we need to add Docker ports
3. **Install Tailscale operator** via Helm
4. **Annotate existing services** with `tailscale.com/expose: "true"`
5. **Verify MagicDNS** — `redis.tail7af24.ts.net`, `inngest.tail7af24.ts.net`, etc.
6. **Update Caddy** — strip internal service proxies, keep only Funnel (public webhooks)
7. **Update NEIGHBORHOOD.md** — new service URLs
8. **Future services** — just annotate, no cluster recreation ever again

### What Caddy Keeps

After migration, Caddy only handles:
- **Webhook Funnel** (`:8443`) — public internet → Tailscale Funnel → Caddy → worker
- Everything else served directly by Tailscale operator proxies with auto-TLS

## Consequences

### Positive
- **Never recreate cluster for ports again** — the biggest operational win
- **MagicDNS** — `typesense.tail7af24.ts.net` instead of `panda:8108`
- **Per-service ACLs** — Redis only reachable from panda, Inngest from panda + clanker
- **Simpler Caddy** — only public webhook funnel
- **Auto-TLS** — Tailscale handles certs, no manual cert renewal
- **Multi-machine access** — clanker-001, laptop, phone all get direct mesh connections to k8s services
- **Future-proof** — adding any new service is `kubectl annotate`, not infrastructure surgery

### Negative
- **More tailnet devices** — ~6 proxy devices added to machine list (cosmetic)
- **OAuth client management** — one-time setup, but requires Tailscale admin console access
- **Operator dependency** — if operator pod dies, proxy pods still run but won't update

### Risks
- **Colima VM networking** — Tailscale operator needs outbound internet from inside the Talos container. Should work (pods can reach internet today for LiveKit, PDS), but verify during install.
- **Talos compatibility** — Tailscale operator is well-tested on standard k8s. Talos-in-Docker-in-Colima is unusual. May need `hostNetwork: true` on the operator or proxy pods.

## References

- [Tailscale Kubernetes Operator docs](https://tailscale.com/kb/1439/kubernetes-operator-cluster-ingress)
- [Tailscale Helm chart](https://pkgs.tailscale.com/helmcharts)
- [Tailscale blog: Mesh your k8s cluster](https://tailscale.com/blog/kubernetes-operator)
- ADR-0029: Colima + Talos k8s cluster
- ADR-0082: Typesense unified search (paired deployment)
