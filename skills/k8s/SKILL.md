---
name: k8s
displayName: K8s
description: >-
  Operate the joelclaw Kubernetes cluster — Talos Linux on Colima (Mac Mini).
  Deploy services, check health, debug pods, recover from restarts, add ports,
  manage Helm releases, inspect logs, fix networking. Triggers on: 'kubectl',
  'pods', 'deploy to k8s', 'cluster health', 'restart pod', 'helm install',
  'talosctl', 'colima', 'nodeport', 'flannel', 'port mapping', 'k8s down',
  'cluster not working', 'add a port', 'PVC', 'storage', any k8s/Talos/Colima
  infrastructure task. Also triggers on service-specific deploy: 'deploy redis',
  'redeploy inngest', 'livekit helm', 'pds not responding'.
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, kubernetes, talos, colima, infrastructure]
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
curl -s localhost:9627/xrpc/_health                    # PDS → {"version":"..."}
kubectl exec -n joelclaw redis-0 -- redis-cli ping     # → PONG
```

## Services

| Service | Type | Pod | Ports (Mac→NodePort) | Helm? |
|---------|------|-----|---------------------|-------|
| Redis | StatefulSet | redis-0 | 6379→6379 | No |
| Typesense | StatefulSet | typesense-0 | 8108→8108 | No |
| Inngest | StatefulSet | inngest-0 | 8288→8288, 8289→8289 | No |
| LiveKit | Deployment | livekit-server-* | 7880→7880, 7881→7881 | Yes (livekit/livekit-server 1.9.0) |
| PDS | Deployment | bluesky-pds-* | 9627→**3000** | Yes (nerkho/bluesky-pds 0.4.2) |

**⚠️ PDS port trap**: Docker maps `9627→3000` (host→container). NodePort must be **3000** to match the container-side port. If set to 9627, traffic won't route.

**Rule**: NodePort value = Docker's container-side port, not host-side.

## Deploy Commands

```bash
# Manifests (redis, typesense, inngest)
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/

# system-bus worker (build + push GHCR + apply + rollout wait)
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh

# LiveKit (Helm + reconcile patches)
~/Code/joelhooks/joelclaw/k8s/reconcile-livekit.sh joelclaw

# PDS (Helm) — always patch NodePort to 3000
# (export current values first if the release already exists)
helm get values bluesky-pds -n joelclaw > /tmp/pds-values-live.yaml 2>/dev/null || true
helm upgrade --install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw -f /tmp/pds-values-live.yaml
kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'
```

## Auto Deploy (GitHub Actions)

- Workflow: `.github/workflows/system-bus-worker-deploy.yml`
- Trigger: push to `main` touching `packages/system-bus/**` or worker deploy files
- Behavior:
  - builds/pushes `ghcr.io/joelhooks/system-bus-worker:${GITHUB_SHA}` + `:latest`
  - runs deploy job on `self-hosted` runner
  - updates k8s deployment image + waits for rollout + probes worker health
- If deploy job is queued forever, check that a `self-hosted` runner is online on the Mac Mini.

## Danger Zones

1. **Never kill processes on forwarded ports** — Lima SSH mux master handles ALL tunnels. Killing anything on 6379/8288/etc may kill mux → all ports die.
2. **Adding ports = cluster recreation** — Docker port maps are immutable. See [references/operations.md](references/operations.md) for the full recreation procedure.
3. **Inngest `host.k3d.internal`** — Stale k3d hostname in manifest. Works anyway (worker uses connect mode, not polling). Fix is pending.

## Key Files

| Path | What |
|------|------|
| `~/Code/joelhooks/joelclaw/k8s/*.yaml` | Service manifests |
| `~/Code/joelhooks/joelclaw/k8s/livekit-values.yaml` | LiveKit Helm values (source controlled) |
| `~/Code/joelhooks/joelclaw/k8s/reconcile-livekit.sh` | LiveKit Helm deploy + post-upgrade reconcile |
| `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh` | Build/push/deploy system-bus worker to k8s |
| `~/Code/joelhooks/joelclaw/infra/k8s-reboot-heal.sh` | Reboot auto-heal script for Colima/Talos/taint/flannel |
| `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.k8s-reboot-heal.plist` | launchd timer for reboot auto-heal |
| `~/Code/joelhooks/joelclaw/skills/k8s/references/operations.md` | Cluster operations + recovery notes |
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
