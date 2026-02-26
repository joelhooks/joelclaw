---
status: accepted
date: 2026-02-26
decision-makers: joel
---

# ADR-0148: Kubernetes Cluster Resilience Policy

## Context

The joelclaw k8s cluster (Talos Linux on Colima, single control-plane node) is the production runtime for all core services: Redis, Inngest, Typesense, system-bus-worker, LiveKit, Bluesky PDS. When the cluster is unhealthy, joelclaw is down.

We've hit recurring failures from:
- `kubectl port-forward` silently dying, breaking Inngest pipeline runs
- Control-plane taint returning after Docker/node restarts, blocking pod scheduling
- Flannel losing `subnet.env` after Docker restart, causing pod sandbox failures
- No backup strategy for PVC data (local-path provisioner, reclaimPolicy: Delete)
- Missing health probes on some services

## Decision

### Service Exposure: NodePort Only

**All services MUST use NodePort with Docker port mappings on the Talos container.** Never use `kubectl port-forward` for any service that needs persistent host access.

To add a new port:
1. Hot-add to Docker container's `hostconfig.json` + `config.v2.json` (see k8s skill)
2. Set k8s service type to NodePort with matching nodePort value
3. Update the port mapping table in the k8s skill

### Health Probes: All Three Required

Every workload MUST have:
- **Liveness probe** — restart if hung
- **Readiness probe** — don't route traffic until ready
- **Startup probe** — grace period for slow starts (prevents liveness kills during init)

Current gaps to fix:
- Typesense: missing liveness probe
- Bluesky PDS: missing readiness and startup probes
- system-bus-worker: missing startup probe

### Post-Restart Recovery Checklist

After any Docker/Colima/node restart:
1. Remove control-plane taint: `kubectl taint nodes joelclaw-controlplane-1 node-role.kubernetes.io/control-plane:NoSchedule- || true`
2. Verify flannel is running: `kubectl get pods -n kube-system | grep flannel`
3. If flannel is crash-looping: `colima ssh -- sudo modprobe br_netfilter`, then delete the flannel pod
4. Verify all pods reach Running state
5. Test service connectivity on all mapped ports

### PVC Data Protection

- `reclaimPolicy: Delete` means PVC deletion = data loss
- Critical stateful services: Redis (event bus state), Typesense (OTEL + search indices), Inngest (run history), PDS (AT Proto repo)
- TODO: implement periodic PVC backup to NAS via CronJob or rsync

### Disk Monitoring

Colima VM has 19GB total. Monitor with `colima ssh -- df -h /`. Alert if >80% used.

## Consequences

- No more silent port-forward failures breaking pipelines
- Services recover automatically after restarts (with taint removal)
- Health probes catch hung processes instead of leaving them zombie
- PVC backup prevents data loss on VM recreation
