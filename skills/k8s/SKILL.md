---
name: k8s
description: >-
  Operate the joelclaw Kubernetes cluster — Talos Linux on Colima (Mac Mini).
  Deploy services, check health, debug pods, recover from restarts, add ports,
  manage Helm releases, inspect logs, fix networking. Triggers on: 'kubectl',
  'pods', 'deploy to k8s', 'cluster health', 'restart pod', 'helm install',
  'talosctl', 'colima', 'nodeport', 'flannel', 'port mapping', 'k8s down',
  'cluster not working', 'add a port', 'PVC', 'storage', any k8s/Talos/Colima
  infrastructure task. Also triggers on service-specific deploy: 'deploy redis',
  'redeploy inngest', 'livekit helm', 'pds not responding'.
---

# k8s Cluster Operations — joelclaw on Talos

## Architecture

```
Mac Mini (localhost ports)
  └─ Lima SSH mux (~/.colima/_lima/colima/ssh.sock) ← NEVER KILL
      └─ Colima VM (4 CPU, 8 GiB, 60 GiB, VZ framework, aarch64)
          └─ Docker 29.x
              └─ Talos v1.12.4 container (joelclaw-controlplane-1)
                  └─ k8s v1.35.0 (single node, Flannel CNI)
                      └─ joelclaw namespace (privileged PSA)
```

For port mappings, recovery procedures, and cluster recreation steps, read [references/operations.md](references/operations.md).

## Quick Health Check

```bash
kubectl get pods -n joelclaw                          # all pods
curl -s localhost:7880/                                # LiveKit → "OK"
curl -s localhost:8288/health                          # Inngest → {"status":200}
curl -s localhost:6333/healthz                         # Qdrant
curl -s localhost:9627/xrpc/_health                    # PDS → {"version":"..."}
kubectl exec -n joelclaw redis-0 -- redis-cli ping     # → PONG
```

## Services

| Service | Type | Pod | Ports (Mac→NodePort) | Helm? |
|---------|------|-----|---------------------|-------|
| Redis | StatefulSet | redis-0 | 6379→6379 | No |
| Qdrant | StatefulSet | qdrant-0 | 6333→6333, 6334→6334 | No |
| Inngest | StatefulSet | inngest-0 | 8288→8288, 8289→8289 | No |
| LiveKit | Deployment | livekit-server-* | 7880→7880, 7881→7881 | Yes (livekit/livekit-server 1.9.0) |
| PDS | Deployment | bluesky-pds-* | 9627→**3000** | Yes (nerkho/bluesky-pds 0.4.2) |

**⚠️ PDS port trap**: Docker maps `9627→3000` (host→container). NodePort must be **3000** to match the container-side port. If set to 9627, traffic won't route.

**Rule**: NodePort value = Docker's container-side port, not host-side.

## Deploy Commands

```bash
# Manifests (redis, qdrant, inngest)
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/

# LiveKit (Helm)
helm upgrade --install livekit-server livekit/livekit-server \
  -n joelclaw -f ~/Projects/livekit-spike/values-joelclaw.yaml
# Then patch NodePort if fresh install:
kubectl patch svc livekit-server -n joelclaw --type='json' -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"},
  {"op":"replace","path":"/spec/ports/0/nodePort","value":7880},
  {"op":"replace","path":"/spec/ports/1/nodePort","value":7881}
]'

# PDS (Helm) — always patch NodePort to 3000
helm upgrade --install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw -f ~/Projects/livekit-spike/k8s-backup/pds-values-live.yaml
kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'
```

## Danger Zones

1. **Never kill processes on forwarded ports** — Lima SSH mux master handles ALL tunnels. Killing anything on 6379/8288/etc may kill mux → all ports die.
2. **Adding ports = cluster recreation** — Docker port maps are immutable. See [references/operations.md](references/operations.md) for the full recreation procedure.
3. **Inngest `host.k3d.internal`** — Stale k3d hostname in manifest. Works anyway (worker uses connect mode, not polling). Fix is pending.

## Key Files

| Path | What |
|------|------|
| `~/Code/joelhooks/joelclaw/k8s/*.yaml` | Service manifests |
| `~/Projects/livekit-spike/values-joelclaw.yaml` | LiveKit Helm values |
| `~/Projects/livekit-spike/CLUSTER.md` | Cluster creation notes |
| `~/.talos/config` | Talos client config |
| `~/.kube/config` | Kubeconfig (context: `admin@joelclaw-1`) |
| `~/.colima/default/colima.yaml` | Colima VM config |
| `~/.local/caddy/Caddyfile` | Caddy HTTPS proxy (Tailscale) |

## Troubleshooting

Read [references/operations.md](references/operations.md) for:
- Recovery after Colima restart
- Recovery after Mac reboot
- Flannel br_netfilter crash fix
- Full cluster recreation (nuclear option)
- Caddy/Tailscale HTTPS proxy details
- All port mapping details with explanation
