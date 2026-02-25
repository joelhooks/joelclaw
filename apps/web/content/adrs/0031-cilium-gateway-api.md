---
title: "Adopt Cilium Gateway API instead of Ingress"
status: proposed
date: 2026-02-17
deciders: Joel Hooks
consulted: X community advice
informed: All agents
related:
  - "[ADR-0030 — Cilium CNI](0030-cilium-cni-kube-proxy-replacement.md)"
  - "[ADR-0029 — Colima + Talos](0029-replace-docker-desktop-with-colima.md)"
tags: [kubernetes, networking, ingress, infrastructure]
---

# ADR-0031: Adopt Cilium Gateway API Instead of Ingress

## Context and Problem Statement

The cluster currently uses NodePort services directly — no Ingress controller at all. If/when we need proper HTTP routing (TLS termination, host-based routing, path routing), the traditional answer is an Ingress controller like ingress-nginx.

Community advice (from X, Feb 2026) recommends Cilium Gateway API over traditional Ingress.

## Research Findings

### ingress-nginx is being retired — this is not speculative

The Kubernetes project officially announced (Nov 2025, kubernetes.io/blog) that **ingress-nginx is entering end-of-life by March 2026**:

> "Best-effort maintenance will continue until March 2026. Afterward, there will be no further releases, no bugfixes, and no updates to resolve any security vulnerabilities."

This is from SIG Network and the Security Response Committee — the maintainers couldn't keep up with CVEs on a security-critical, internet-facing component. The repo will be archived (read-only).

**Key distinction**: This affects the community `kubernetes/ingress-nginx` project. F5/NGINX Inc's commercial controller is separate and still maintained.

Google's open-source blog (Feb 2026) and CNCF blog (Jan 2026) both confirm and recommend Gateway API as the migration path.

### Gateway API is the official successor to Ingress

Gateway API is a Kubernetes SIG project (same governance as Ingress). It's not a vendor play — it's the community's answer to Ingress limitations:

| Aspect | Ingress | Gateway API |
|--------|---------|-------------|
| Routing | Host + path only | Host, path, headers, query params, traffic splitting |
| Protocols | HTTP/HTTPS only | HTTP, HTTPS, TCP, UDP, gRPC |
| Multi-tenancy | Weak (one resource mixes infra + app concerns) | Role-oriented: GatewayClass (provider) → Gateway (infra team) → HTTPRoute (devs) |
| Advanced features | Vendor-specific annotations | First-class CRDs (no annotations) |
| Portability | Annotation lock-in per controller | Standard across implementations |

### Cilium as Gateway API controller

When Cilium is the CNI (ADR-0030), Gateway API support is built-in — no additional controller to deploy. The eBPF dataplane handles the actual packet forwarding.

CNCF blog (Jan 2026): "Cilium's implementation supports all Core Gateway API resources and features, in addition to most Extended features, and enhances them with eBPF-powered performance, observability, and policy integration."

Basic setup:
```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1beta1
kind: Gateway
metadata:
  name: joelclaw-gateway
spec:
  gatewayClassName: cilium
  listeners:
  - name: http
    protocol: HTTP
    port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: inngest-route
spec:
  parentRefs:
  - name: joelclaw-gateway
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: inngest-svc
      port: 8288
```

### Reddit community sentiment (r/kubernetes, May 2025, 63 upvotes)

Mixed but trending toward Gateway API:
- "ingress controller will/can use gateway api... Things will just move to gateway api" (+35)
- "You got no choice to migrate really if you want to be on a supported version" (+21)
- "It's clearly the future" (+4)
- Counterpoint: "Gateway API seems like a downgrade from ease-of-use" (+4) — valid for simple use cases

### Current state: NodePort is fine for now

The cluster exposes services via NodePort on mapped Docker ports. There's no Ingress controller deployed. Gateway API would only matter when:
- Multiple HTTP services need host/path routing
- TLS termination inside the cluster is needed
- Traffic splitting (canary, blue-green) is needed

## Decision Drivers

- **ingress-nginx EOL**: March 2026 — don't adopt something about to be archived
- **Cilium dependency**: Gateway API is free if Cilium is already the CNI
- **Complexity vs need**: NodePort works fine for 3 services
- **Future-proofing**: Gateway API is the Kubernetes standard going forward

## Options

### Option A: Stay with NodePort (status quo)

No routing layer. Each service on its own port. Works for dev/test with a handful of services.

### Option B: Cilium Gateway API

Modern, standard, built into Cilium. No separate controller to manage. But requires Cilium first (ADR-0030).

### Option C: Traefik or other Ingress controller

Actively maintained alternative to ingress-nginx. Supports both Ingress and Gateway API. Independent of CNI choice.

## Current Lean

**Wait, but skip Ingress entirely when routing is needed.** The trigger is the same as ADR-0030: when we need proper HTTP routing (multiple services, TLS, traffic management), go directly to Gateway API via Cilium. Do not adopt ingress-nginx — it's being archived.

## Prerequisite

ADR-0030 (Cilium) must be accepted and implemented first. Gateway API is a natural addition once Cilium is the CNI.

## Sources

- Kubernetes official retirement announcement (Nov 2025): https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/
- CNCF blog — move to Cilium Gateway API (Jan 2026): https://www.cncf.io/blog/2026/01/27/navigating-the-ingress-nginx-archival-why-now-is-the-time-to-move-to-cilium/
- Google Open Source blog (Feb 2026): https://opensource.googleblog.com/2026/02/the-end-of-an-era-transitioning-away-from-ingress-nginx.html
- Cilium Gateway API docs: https://docs.cilium.io/en/latest/network/servicemesh/ingress-to-gateway/ingress-to-gateway/
- DigitalOcean tutorial: https://www.digitalocean.com/community/tutorials/kubernetes-gateway-api-tutorial-cilium-ingress-alternative
- r/kubernetes discussion: https://www.reddit.com/r/kubernetes/comments/1kri73b/ingress_controller_v_gateway_api/

## Deferral Note (2026-02-19)

Deferred. Depends on ADR-0030 (Cilium). Caddy + Tailscale handles routing on single-node today, but Gateway API becomes the right ingress model for multi-node. Revisit alongside ADR-0030 when Pi 5 workers join the cluster.
