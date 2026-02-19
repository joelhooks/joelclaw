# k8s Operations Reference

## Port Mapping Details

Traffic path: `Mac:port → Lima SSH tunnel → Docker port map → Talos NodePort → Pod`

| Mac Port | Docker Container Port | NodePort | Service | Notes |
|----------|----------------------|----------|---------|-------|
| 6333 | 6333 | 6333 | Qdrant HTTP | REST API + dashboard |
| 6334 | 6334 | 6334 | Qdrant gRPC | |
| 6379 | 6379 | 6379 | Redis | AOF, 256MB maxmem, allkeys-lru |
| 7880 | 7880 | 7880 | LiveKit HTTP/WS | hostNetwork:true |
| 7881 | 7881 | 7881 | LiveKit WebRTC TCP | |
| 8288 | 8288 | 8288 | Inngest HTTP | Dashboard + Event API |
| 8289 | 8289 | 8289 | Inngest WS | Connect gateway (gRPC) |
| 9627 | **3000** | **3000** | Bluesky PDS | ⚠️ Asymmetric mapping |
| 64784* | 6443 | — | k8s API | Auto-assigned by talosctl |
| 64785* | 50000 | — | talosctl API | Auto-assigned by talosctl |

### Port Mapping Rule

NodePort must equal the Docker **container-side** port. Docker maps `hostPort:containerPort`. The Talos node receives traffic on `containerPort`, and NodePort listens on the node at that same value.

For symmetric mappings (6379:6379), NodePort=6379 works. For PDS (9627:3000), NodePort must be 3000.

### Inspecting Docker Port Mappings

```bash
ssh -F ~/.colima/_lima/colima/ssh.config lima-colima \
  "docker inspect joelclaw-controlplane-1 --format '{{json .HostConfig.PortBindings}}'" \
  | python3 -m json.tool
```

## Recovery Procedures

### After Colima Restart

```bash
colima status                    # Verify VM running
# Talos container should auto-start (Docker restart policy)
# If not:
ssh -F ~/.colima/_lima/colima/ssh.config lima-colima \
  "docker start joelclaw-controlplane-1"
# Wait 30-60s, then verify:
kubectl get pods -n joelclaw
```

### After Mac Reboot

Colima starts via launchd (`com.joel.colima`). Wait ~60s for full stack: VM → Docker → Talos → k8s → pods. Worker auto-starts via `com.joel.system-bus-worker`.

```bash
kubectl get pods -n joelclaw
curl localhost:8288/health
```

### Flannel br_netfilter Crash

Symptoms: Flannel pods crash, `stat /proc/sys/net/bridge/bridge-nf-call-iptables: no such file or directory`

Root cause: Talos-in-Docker shares Colima VM kernel. `br_netfilter` must load in the VM.

```bash
ssh -F ~/.colima/_lima/colima/ssh.config lima-colima "sudo modprobe br_netfilter"
# Wait for Flannel to auto-recover or delete the pod
```

The `--config-patch` at cluster creation (`machine.kernel.modules: [{name: br_netfilter}]`) prevents this on fresh clusters.

### Full Cluster Recreation

**When**: Adding new port mappings (Docker ports are immutable), or unrecoverable corruption.

**Before destroying**: Back up Helm values and any data:
```bash
helm get values livekit-server -n joelclaw > /tmp/livekit-values-backup.yaml
helm get values bluesky-pds -n joelclaw > /tmp/pds-values-backup.yaml
```

```bash
# 1. Destroy
talosctl cluster destroy --name joelclaw

# 2. Ensure DOCKER_HOST is set
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"

# 3. Write kernel module patch
cat > /tmp/talos-patch.yaml << 'EOF'
machine:
  kernel:
    modules:
      - name: br_netfilter
EOF

# 4. Create with ALL port mappings (add new ones here)
talosctl cluster create docker \
  --name joelclaw \
  --cpus-controlplanes "2.0" \
  --memory-controlplanes "4GiB" \
  --exposed-ports "6333:6333/tcp,6334:6334/tcp,6379:6379/tcp,7880:7880/tcp,7881:7881/tcp,8288:8288/tcp,8289:8289/tcp,9627:3000/tcp" \
  --workers 0 \
  --config-patch @/tmp/talos-patch.yaml \
  --subnet "10.5.0.0/24"

# 5. Fix kubeconfig context
kubectl config use-context admin@joelclaw-1

# 6. Get the talosctl endpoint port (auto-assigned)
TALOS_PORT=$(talosctl config info 2>&1 | grep Endpoints | awk -F: '{print $NF}')

# 7. Allow low NodePorts
talosctl -e 127.0.0.1:$TALOS_PORT -n 10.5.0.2 patch machineconfig --patch @- <<'PATCH'
cluster:
  apiServer:
    extraArgs:
      service-node-port-range: "1-65535"
PATCH

# 8. Remove control-plane taint (single node)
kubectl taint nodes joelclaw-controlplane-1 \
  node-role.kubernetes.io/control-plane:NoSchedule-

# 9. Install local-path-provisioner (Talos has no built-in storage)
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 10. Set privileged PSA
kubectl label namespace local-path-storage \
  pod-security.kubernetes.io/enforce=privileged --overwrite
kubectl label namespace joelclaw \
  pod-security.kubernetes.io/enforce=privileged --overwrite

# 11. Deploy core services
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/

# 12. Deploy LiveKit (Helm)
helm install livekit-server livekit/livekit-server \
  -n joelclaw -f ~/Projects/livekit-spike/values-joelclaw.yaml
kubectl patch svc livekit-server -n joelclaw --type='json' -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"},
  {"op":"replace","path":"/spec/ports/0/nodePort","value":7880},
  {"op":"replace","path":"/spec/ports/1/nodePort","value":7881}
]'

# 13. Deploy PDS (Helm) — NodePort MUST be 3000
helm install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw -f /tmp/pds-values-backup.yaml
kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'

# 14. Restart worker to reconnect
launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker
```

## Caddy HTTPS Proxy (Tailscale)

Caddyfile: `~/.local/caddy/Caddyfile`
TLS certs: `~/.local/certs/panda.tail7af24.ts.net.{crt,key}`

| URL | Backend |
|-----|---------|
| `https://panda.tail7af24.ts.net:9443` | Inngest dashboard (8288) |
| `https://panda.tail7af24.ts.net:8290` | Inngest WS connect (8289) |
| `https://panda.tail7af24.ts.net:3443` | Worker (3111) |
| `https://panda.tail7af24.ts.net:6443` | Qdrant (6333) |
| `panda.tail7af24.ts.net:6379` | Redis (direct TCP, no TLS) |
| `https://panda.tail7af24.ts.net:7443` | LiveKit WSS signaling (7880) |
| `http://localhost:8443` | Funnel webhook gateway → worker/inngest |

Tailscale Funnel: `panda.tail7af24.ts.net:443` → `localhost:3111` (public internet webhooks).

## Talos-Specific Commands

```bash
# Dashboard (live TUI)
talosctl -e 127.0.0.1:64785 -n 10.5.0.2 dashboard

# Kubelet logs
talosctl -e 127.0.0.1:64785 -n 10.5.0.2 logs kubelet

# Machine config
talosctl -e 127.0.0.1:64785 -n 10.5.0.2 get machineconfig -o yaml

# Config info (endpoints, cert expiry)
talosctl config info
```

Note: The talosctl endpoint port (64785) is auto-assigned at cluster creation and changes on recreation. Check `talosctl config info` for current value.

## Helm Repos

```
nerkho   https://charts.nerkho.ch    # Bluesky PDS
livekit  https://helm.livekit.io     # LiveKit server
```

## Secrets (agent-secrets)

| Secret | Used By |
|--------|---------|
| `livekit_api_key` | LiveKit server + agents |
| `livekit_api_secret` | LiveKit server + agents |
| `livekit_url` | LiveKit agents (ws://localhost:7880) |
| `pds_admin_password` | PDS admin |
| `pds_jwt_secret` | PDS auth |
| `pds_plc_rotation_key` | PDS DID rotation |

## launchd Services

| Plist | Purpose | Port |
|-------|---------|------|
| `com.joel.colima` | Colima VM | — |
| `com.joel.system-bus-worker` | Inngest worker | 3111 |
| `com.joel.caddy` | HTTPS proxy | 443/8290/3443/6443/8443 |
| `com.joel.gateway` | Pi gateway daemon | — (Redis pub/sub) |

## Known Issues

1. **Inngest `--sdk-url http://host.k3d.internal:3111`** — Stale k3d hostname in `~/Code/joelhooks/joelclaw/k8s/inngest.yaml`. Doesn't resolve in Talos. Works anyway because worker uses connect mode (`INNGEST_DEV=0`), not polling. Fix: update manifest to remove or replace with valid hostname.

2. **Stale kubeconfig context** — `admin@joelclaw` (old cluster) still in `~/.kube/config`. Points to dead port 63324. Active context is `admin@joelclaw-1`. Clean up: `kubectl config delete-context admin@joelclaw`.

3. **PDS data loss on recreation** — PDS uses local-path PVC. Cluster destroy = data gone. Back up sqlite files before recreation if needed: `kubectl cp joelclaw/bluesky-pds-xxx:/pds /tmp/pds-backup/`.

4. **No metrics-server** — `kubectl top` doesn't work. Install if needed: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`.

5. **`serveHost` in serve.ts** — Worker has `serveHost: "http://host.docker.internal:3111"` in `~/Code/system-bus-worker/packages/system-bus/src/serve.ts`. Stale from Docker Compose era. Works because worker uses connect mode (outbound to Inngest at `localhost:8288`), but should be cleaned up.
