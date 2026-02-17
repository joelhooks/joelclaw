---
type: discovery
slug: self-hosting-is-woodworking-and-kubernetes-is-vim
source: "https://joelhooks.com/self-hosting/"
discovered: "2026-02-17"
tags: [article, infrastructure, self-hosting, homelab, kubernetes, nas, philosophy]
relevance: "origin story for three-body NAS and the incremental infrastructure path toward k3s (ADR-0025)"
---

# Self-Hosting Is Woodworking and Kubernetes Is Vim

This is the genesis post for the whole homelab. The piece that explains **why** the [Asustor NAS](https://www.asustor.com/) got named [three-body](joel@three-body:/volume1/home/joel/video/), why there's [10G ethernet](https://joelhooks.com/self-hosting/) running through the office, and what philosophy drives the infrastructure decisions downstream of all of it.

The core metaphor: self-hosting is **woodworking**. You don't start by building a dining table — you start by building the shop. A workbench. Some jigs. You accumulate tools and skill together, and the projects you can take on grow with your capability. [Mike Royal's self-hosting guide](https://github.com/mikeroyal/Self-Hosting-Guide) gets a nod as the reference catalog for what's possible, but the post isn't about picking from a menu. It's about the practice itself.

The [Kubernetes](https://kubernetes.io/) analogy is the sharpest line: **k8s is like [Vim](https://www.vim.org/) — start small, build up.** Nobody learns Vim by reading the manual cover to cover. You learn `i`, `Esc`, `:wq` and you're productive on day one. Everything after that is incremental. Same with k8s — you don't need to understand [CRDs](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/) and [service meshes](https://istio.io/) to run a useful cluster. Start with a single node, deploy one thing, learn as you go. The complexity is opt-in, not prerequisite. That's the whole [k3s](https://k3s.io/) bet in [ADR-0025](/adrs/k3s-cluster-for-joelclaw-network) — lightweight Kubernetes that doesn't demand you become a platform engineer before you get anything running.

The post also captures a specific moment in time: the transition from "I have a NAS for backups" to "I have infrastructure I control." That's the inflection point where self-hosting stops being a hobby and starts being a platform. Everything that came after — [Inngest](https://www.inngest.com/) on the event bus, [Qdrant](https://qdrant.tech/) for search, [Redis](https://redis.io/) for state, the [video ingest pipeline](/cool/video-ingest-pipeline) — traces back to this decision to own the stack.

## Key Ideas

- **Self-hosting as craft practice** — the woodworking metaphor frames infrastructure as a skill you develop incrementally, not a product you install
- **Kubernetes is Vim** — start with the minimum viable commands, add complexity as you need it, never front-load the entire learning curve
- **[Mike Royal's Self-Hosting Guide](https://github.com/mikeroyal/Self-Hosting-Guide)** — comprehensive catalog of self-hostable services, referenced as the "what's possible" map
- **The NAS as genesis** — [three-body](joel@three-body:/volume1/home/joel/video/) (Asustor NAS) with 10G ethernet was the first real infrastructure investment, everything else grew from there
- **Ownership as philosophy** — self-hosting isn't about saving money or avoiding cloud bills, it's about **sovereignty** over your own data and platform
- **Incremental complexity** — the path from NAS → Docker → k3s mirrors the Vim learning curve: each layer is optional until you need it

## Links

- [Self-Hosting — joelhooks.com](https://joelhooks.com/self-hosting/)
- [Mike Royal's Self-Hosting Guide](https://github.com/mikeroyal/Self-Hosting-Guide)
- [ADR-0025 — k3s Cluster for joelclaw Network](/adrs/k3s-cluster-for-joelclaw-network)
- [k3s — Lightweight Kubernetes](https://k3s.io/)
- [Asustor NAS](https://www.asustor.com/)
