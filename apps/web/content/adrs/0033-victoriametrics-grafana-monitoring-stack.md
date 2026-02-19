---
title: "VictoriaMetrics + Grafana monitoring stack for Kubernetes"
status: deferred
date: 2026-02-17
deciders: Joel Hooks
consulted: X community advice, Siderolabs reference architecture
informed: All agents
related:
  - "[ADR-0029 — Colima + Talos](0029-replace-docker-desktop-with-colima.md)"
  - "[ADR-0030 — Cilium CNI](0030-cilium-cni-kube-proxy-replacement.md)"
supersedes: "[ADR-0006 — Prometheus + Grafana](0006-observability-prometheus-grafana.md)"
tags: [kubernetes, monitoring, observability, infrastructure]
---

# ADR-0033: VictoriaMetrics + Grafana Monitoring Stack

## Supersedes ADR-0006

ADR-0006 proposed Prometheus + Grafana for the same observability goal but under different assumptions: Docker Compose, 8 GB RAM budget, pre-Talos. The system has since migrated to Talos k8s on a 64 GB machine (ADR-0029). VictoriaMetrics is a better fit than raw Prometheus for k8s — lower resources, better compression, native k8s-stack Helm chart. Grafana remains the visualization layer in both.

## Context and Problem Statement

The Talos cluster has no monitoring. We observe the system via `kubectl get pods`, `talosctl dashboard`, and application logs. There's no metrics collection, no dashboards, no alerting.

Community advice (from X, Feb 2026) recommends the **VictoriaMetrics + Grafana stack**. Separately, the Siderolabs Kubernetes Reference Architecture (May 2025) also recommends this exact combination:

> "We recommend Grafana for observability and VictoriaLogs or Loki for logging."

## Research Findings

### VictoriaMetrics — Prometheus-compatible, less resource-hungry

VictoriaMetrics is a Prometheus-compatible time-series database. It accepts Prometheus scrape format, supports PromQL, and works as a drop-in Grafana datasource using the Prometheus data source type.

**Why not just Prometheus?**
- VictoriaMetrics uses significantly less RAM and disk than Prometheus for the same data
- Better compression (up to 70x vs Prometheus)
- Long-term storage built in (Prometheus needs Thanos or Cortex for this)
- PromQL-compatible with extensions (MetricsQL)
- Can run as a single binary (`vmsingle`) or distributed cluster

**victoria-metrics-k8s-stack Helm chart**: One-chart deployment that includes:
- VictoriaMetrics (vmsingle or cluster)
- vmagent (metrics scraper, replaces Prometheus server's scrape function)
- Grafana with pre-configured dashboards
- VMAlertmanager for alerting
- Pre-built ServiceMonitors/VMServiceScrape for kubelet, kube-state-metrics, node-exporter, etc.
- Default Grafana dashboards for cluster overview, node metrics, pod metrics

### Grafana — the dashboard standard

Grafana is the de facto visualization layer. VictoriaMetrics k8s stack bundles it with pre-configured data sources pointing to VictoriaMetrics. Also works with VictoriaLogs (for log exploration, replacing Loki).

The Grafana Operator can manage dashboards as Kubernetes CRDs — dashboards defined in YAML, version-controlled in git. One blog post showed managing Cilium dashboards this way:

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: cilium-dashboard
spec:
  folderRef: "cilium"
  url: "https://raw.githubusercontent.com/cilium/cilium/main/install/kubernetes/cilium/files/cilium-agent/dashboards/cilium-dashboard.json"
```

### Resource requirements

For a single-node cluster, the minimal setup (vmsingle + vmagent + Grafana):
- **vmsingle**: ~100-200 MB RAM, minimal CPU
- **vmagent**: ~50-100 MB RAM
- **Grafana**: ~100-200 MB RAM
- **Total**: ~300-500 MB RAM

Prometheus equivalent would be 500 MB-1 GB+ for the same workload.

### What we'd actually see

With the k8s stack deployed:
- **Cluster overview**: CPU/memory usage per node, pod counts, restart counts
- **Pod metrics**: Per-pod CPU, memory, network, disk I/O
- **kubelet metrics**: Container starts, image pulls, volume operations
- **If Cilium (ADR-0030)**: Network flow metrics, policy drops, DNS latency — Cilium exports Prometheus metrics natively and has published Grafana dashboards

## Decision Drivers

- **Current observability**: Zero. `kubectl` and logs only.
- **Debugging value**: When pods crash or services slow down, metrics tell the story.
- **Resource cost**: ~300-500 MB RAM is 0.5-0.8% of the 64 GB machine.
- **Operational complexity**: One Helm chart, auto-configured scraping.
- **Synergy with Cilium**: Cilium's Hubble metrics feed directly into VictoriaMetrics/Grafana.

## Options

### Option A: No monitoring (status quo)

kubectl + logs. Works until something breaks and you need to understand why.

### Option B: VictoriaMetrics + Grafana (k8s stack)

Full monitoring with minimal resources. Prometheus-compatible. One Helm chart.

### Option C: Prometheus + Grafana (kube-prometheus-stack)

The traditional choice. More resource-hungry, larger community, more docs. Would work but VictoriaMetrics is strictly better on resource efficiency.

## Current Lean

**This one is close to worth doing now.** Unlike Cilium or distributed storage, monitoring provides immediate value even on a single-node dev cluster. When Inngest hangs or Qdrant's memory spikes, you'd want to see the timeline.

The cost (~300-500 MB RAM on a 64 GB machine) is negligible. The main reason to wait: the cluster is stable and we're not debugging issues. But the first time something goes wrong, we'll wish we had metrics.

**Trigger**: Next time we hit an unexplained pod crash, Inngest timeout, or resource pressure — deploy the monitoring stack then. Or just do it proactively next time we're in the cluster config.

## Implementation Plan (When Ready)

```bash
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

helm install victoria-metrics vm/victoria-metrics-k8s-stack \
  --namespace monitoring \
  --create-namespace \
  --set vmsingle.enabled=true \
  --set vmcluster.enabled=false \
  --set grafana.enabled=true
```

Then port-forward or NodePort Grafana:
```bash
kubectl -n monitoring port-forward svc/victoria-metrics-k8s-stack-grafana 3000:80
```

## Sources

- VictoriaMetrics k8s stack Helm chart: https://docs.victoriametrics.com/helm/victoria-metrics-k8s-stack/
- VictoriaMetrics cluster guide: https://docs.victoriametrics.com/guides/k8s-monitoring-via-vm-cluster/
- VictoriaMetrics + Grafana Operator walkthrough: https://blog.ogenki.io/post/series/observability/metrics/
- Siderolabs Reference Architecture: https://www.siderolabs.com/wp-content/uploads/2025/08/Kubernetes-Cluster-Reference-Architecture-with-Talos-Linux-for-2025-05.pdf
