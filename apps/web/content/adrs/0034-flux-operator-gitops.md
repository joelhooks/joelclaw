---
title: "Flux Operator for GitOps cluster management"
status: proposed
date: 2026-02-17
deciders: Joel Hooks
consulted: X community advice
informed: All agents
related:
  - "[ADR-0029 — Colima + Talos](0029-replace-docker-desktop-with-colima.md)"
tags: [kubernetes, gitops, infrastructure]
---

# ADR-0034: Flux Operator for GitOps Cluster Management

## Context and Problem Statement

Cluster state is currently applied manually via `kubectl apply -f`. The k8s manifests live in `~/Code/joelhooks/joelclaw/k8s/` and are applied by hand or by agents running kubectl commands. There's no reconciliation loop — if someone deletes a resource or kubectl apply drifts, nothing catches it.

Community advice (from X, Feb 2026) recommends **Flux Operator** (fluxoperator.dev) for GitOps-driven cluster management.

## Research Findings

### What Flux Operator actually does

Flux Operator is a Kubernetes operator that manages Flux CD installations declaratively. Flux CD is the CNCF graduated GitOps toolkit — it watches a git repo and continuously reconciles cluster state to match what's in git.

The Flux Operator simplifies Flux installation to a single CRD:

```yaml
apiVersion: fluxcd.controlplane.io/v1
kind: FluxInstance
metadata:
  name: flux
  namespace: flux-system
spec:
  distribution:
    version: "2.x"
    registry: "ghcr.io/fluxcd"
  components:
    - source-controller
    - kustomize-controller
    - helm-controller
    - notification-controller
  sync:
    kind: GitRepository
    url: "https://github.com/joelhooks/joelclaw.git"
    ref: "refs/heads/main"
    path: "k8s/"
    pullSecret: "flux-system"
```

Once deployed, Flux watches `joelhooks/joelclaw` repo's `k8s/` directory and automatically applies any changes. Push a manifest change → Flux applies it. Delete a resource from git → Flux deletes it from the cluster.

### GitHub App auth (Flux 2.5+, April 2025)

Flux supports GitHub App authentication — directly relevant since we have `joelclawgithub[bot]`. Instead of deploy keys tied to a user:

```bash
flux create secret githubapp flux-system \
  --app-id=<app-id> \
  --app-installation-id=<installation-id> \
  --app-private-key=./private-key.pem
```

Short-lived tokens, no user dependency, natural fit with the existing bot infrastructure.

### MCP Server for AI-assisted GitOps (May 2025)

Flux Operator has an MCP server (`flux-operator-mcp`) that connects AI assistants to the cluster:

```bash
brew install controlplaneio-fluxcd/tap/flux-operator-mcp
```

Capabilities: debug GitOps pipelines, compare configs between clusters, visualize dependencies, perform operations via natural language. Works with Claude Code, Cursor, etc.

This is directly relevant to the joelclaw agent architecture — agents could interact with cluster state through MCP instead of raw kubectl.

### What it replaces

Currently: Agent runs `kubectl apply -f redis.yaml` → hope it worked.

With Flux: Agent commits to git → Flux applies → Flux reports status → drift is auto-corrected.

### Flux Operator vs Flux CLI bootstrap

Traditional Flux uses `flux bootstrap` which commits Flux manifests into your repo and manages itself. Flux Operator is newer — it manages Flux as a Kubernetes operator, which is cleaner for fleet management but also works fine for single clusters.

### ArgoCD as an alternative

ArgoCD is the other major GitOps tool. More feature-rich UI, app-of-apps pattern. But heavier (requires 3+ pods, ~1 GB RAM baseline), designed for multi-team enterprises with approval workflows. Flux is lighter and more Unix-philosophy.

## Decision Drivers

- **Drift correction**: Does cluster state stay in sync with git?
- **Agent workflow**: Can agents commit to git instead of running kubectl?
- **Complexity**: How many new components in the cluster?
- **Resource cost**: Flux controllers ~200-300 MB RAM total
- **GitHub App integration**: Works with existing joelclawgithub[bot]?

## Options

### Option A: Manual kubectl apply (status quo)

Works. No reconciliation. Drift is possible but unlikely on a single-operator cluster.

### Option B: Flux Operator

GitOps reconciliation loop. Agents commit to git, Flux applies. MCP server for AI interaction. GitHub App auth.

### Option C: ArgoCD

More feature-rich but heavier. Better UI. Overkill for a single-cluster, single-operator setup.

### Option D: Simple CI/CD (GitHub Actions applies on push)

Lighter than Flux — just run kubectl in a workflow. No reconciliation, no drift correction, but automated deploys.

## Current Lean

**Interesting but premature.** The current workflow is: agent or Joel runs `kubectl apply`. There's one operator (Joel) and one cluster. The git-commit-to-deploy loop is elegant but the manual `kubectl apply` path has zero friction today.

**Trigger**: If any of these happen, Flux becomes worthwhile:
- Multiple clusters (Mac Mini + Pi 5) that need to stay in sync
- Agents frequently applying k8s manifests (making drift a real risk)
- Need for approval gates on cluster changes
- Want to use the MCP server for agent-cluster interaction

The MCP server angle is the most compelling for this system. Agent → MCP → Flux → cluster is a cleaner abstraction than agent → kubectl → cluster.

## Sources

- Flux Operator GitHub: https://github.com/controlplaneio-fluxcd/flux-operator
- Flux Operator docs: https://fluxcd.io/flux/operator/
- GitHub App bootstrap: https://fluxcd.io/blog/2025/04/flux-operator-github-app-bootstrap/
- AI-assisted GitOps (MCP server): https://fluxcd.io/blog/2025/05/ai-assisted-gitops/
- Time-based deployments: https://fluxcd.io/blog/2025/07/time-based-deployments/
