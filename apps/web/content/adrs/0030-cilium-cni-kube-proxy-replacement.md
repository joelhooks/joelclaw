---
title: "Replace Flannel + kube-proxy with Cilium"
status: withdrawn
date: 2026-02-17
deciders: Joel Hooks
consulted: X community advice
informed: All agents
related:
  - "[ADR-0029 — Colima + Talos](0029-replace-docker-desktop-with-colima.md)"
  - "[ADR-0031 — Cilium Gateway API](0031-cilium-gateway-api.md)"
tags: [kubernetes, networking, infrastructure]
---

# ADR-0030: Replace Flannel + kube-proxy with Cilium

## Context and Problem Statement

The Talos cluster (`joelclaw`) currently runs with the default CNI: **Flannel** + **kube-proxy**. This is the simplest path — Talos bundles Flannel out of the box and it works with zero config.

However, Flannel is a minimal overlay network. It provides pod-to-pod connectivity and nothing else — no network policies, no advanced load balancing, no observability. kube-proxy uses iptables rules for service routing, which works but doesn't scale well and provides no visibility into traffic flows.

Community advice (from X, Feb 2026) recommends Cilium as a kube-proxy replacement for anyone moving beyond basic testing.

## Research Findings

### What Cilium actually is

Cilium is an eBPF-based CNI that replaces both Flannel (pod networking) and kube-proxy (service routing) in a single component. It's a CNCF graduated project (same tier as Kubernetes itself).

Key capabilities beyond Flannel:
- **eBPF dataplane**: Bypasses iptables entirely. Service routing happens in kernel space via eBPF programs. Measurably lower latency and higher throughput than iptables-based kube-proxy.
- **Network policies**: Kubernetes NetworkPolicy support (Flannel has none). Plus CiliumNetworkPolicy for L7-aware rules.
- **Hubble observability**: Built-in flow visibility — see which pods talk to which, protocol-level metrics, DNS resolution tracking. Available as CLI (`hubble`), UI, and Prometheus metrics.
- **L2/BGP load balancing**: Can replace MetalLB for bare-metal LoadBalancer services. Fewer moving parts.
- **Identity-based security**: Pods get cryptographic identities, not just IP-based rules.

### Talos + Cilium is a documented, first-class path

Siderolabs' own **Kubernetes Cluster Reference Architecture** (May 2025) states:

> "Talos Linux will install Flannel by default. In order to install Cilium or replace Flannel, it is necessary to override the machine config to specify that no CNI should be initially installed."

Cilium docs have a dedicated Talos installation page. The config is well-documented:

```yaml
# Talos machine config patch to disable Flannel + kube-proxy
cluster:
  network:
    cni:
      name: none
  proxy:
    disabled: true
```

Then install Cilium via Helm with Talos-specific values:

```bash
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=localhost \
  --set k8sServicePort=7445 \
  --set cgroup.autoMount.enabled=false \
  --set cgroup.hostRoot=/sys/fs/cgroup
```

The `k8sServiceHost=localhost:7445` leverages Talos's KubePrism — a built-in API server proxy on every node. No external load balancer needed.

### Flannel limitations that matter now

- No network policy support at all. Any pod can talk to any other pod.
- No traffic observability. Can't see what's talking to what.
- kube-proxy iptables rules become a debugging black hole when services misbehave.

### Flannel's case for staying

- Zero config. Works out of the box with Talos.
- Lower resource usage than Cilium (~50-100 MB RAM vs Cilium's ~300-500 MB per node).
- Simpler mental model for a single-node dev/test cluster.
- Current cluster has 3 services (Redis, Qdrant, Inngest). Not exactly a complex network topology.

## Decision Drivers

- **Observability**: Can we see what's happening in the network?
- **Security**: Can we enforce pod-to-pod access rules?
- **Operational complexity**: How much harder is it to operate?
- **Resource cost**: What's the RAM/CPU overhead on a single-node Docker-based cluster?
- **Future path**: Does this carry forward to bare-metal Pi 5 Talos?

## Options

### Option A: Keep Flannel + kube-proxy (status quo)

Works today. Zero overhead. No network policies, no observability, no advanced routing. Fine for a 3-service testing cluster.

### Option B: Replace with Cilium (kube-proxy replacement mode)

Full eBPF networking stack. Network policies, Hubble observability, service mesh capabilities. More resources, more complexity, but the industry-standard path for Talos clusters.

## Current Lean

**Not yet.** The cluster is single-node Docker-based with 3 services. Cilium's value scales with cluster complexity. The right trigger is one of:
- Moving to bare-metal multi-node (Pi 5)
- Adding services that need network isolation
- Needing traffic observability for debugging
- Adopting Gateway API (ADR-0031) — Cilium is the natural gateway controller

## Implementation Plan (When Ready)

1. Recreate Talos cluster with CNI disabled:
   ```bash
   talosctl cluster create docker \
     --name joelclaw \
     --workers 0 \
     --memory-controlplanes 4GiB \
     -p 6379:6379/tcp,6333:6333/tcp,6334:6334/tcp,8288:8288/tcp,8289:8289/tcp \
     --config-patch-controlplanes @controlplane-patch.yaml
   ```
   Where `controlplane-patch.yaml` adds:
   ```yaml
   cluster:
     network:
       cni:
         name: none
     proxy:
       disabled: true
     allowSchedulingOnControlPlanes: true
   ```

2. Install Cilium via Helm with Talos values (see helm command above)

3. Verify: `cilium status`, `cilium connectivity test`

4. Re-apply all k8s manifests (unchanged)

5. Install Hubble for observability: `cilium hubble enable --ui`

## Verification

- [ ] `cilium status` shows all components healthy
- [ ] `kubectl get pods -n joelclaw` shows all services running
- [ ] `hubble observe` shows traffic flows between pods
- [ ] No kube-proxy pods running
- [ ] Services accessible on same ports as before

## Sources

- Cilium docs — Talos installation: https://docs.cilium.io/en/latest/installation/k8s-install-helm/
- Siderolabs Reference Architecture (2025): https://www.siderolabs.com/wp-content/uploads/2025/08/Kubernetes-Cluster-Reference-Architecture-with-Talos-Linux-for-2025-05.pdf
- Talos + Cilium walkthrough: https://rcwz.pl/2025-10-08-adding-cilium-to-talos-cluster/
- Talos + Cilium on Proxmox: https://unixorn.github.io/post/homelab/k8s/01-talos-with-cilium-cni-on-proxmox/
