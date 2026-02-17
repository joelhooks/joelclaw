---
type: discovery
slug: self-hosting-as-woodworking
source: "https://joelhooks.com/self-hosting/"
discovered: "2026-02-17"
tags: [article, self-hosting, infrastructure, homelab, philosophy, k8s, nas, craft]
relevance: "genesis document for the homelab that became the personal AI OS — three-body NAS, 10G ethernet, k3s cluster all trace back here"
---

# Self-Hosting as Woodworking — Build the Workshop Before the Furniture

The core move in this post is the **craft metaphor**. Self-hosting isn't about replacing cloud services with cheaper alternatives. It's woodworking. You build the workshop first — the bench, the tools, the jigs — and the furniture comes later. The workshop *is* the point. That framing rejects the datacenter mindset where infrastructure is a cost center you minimize.

The [Kubernetes](https://kubernetes.io/)-as-[Vim](https://www.vim.org/) comparison is the line that sticks: **start small, build up**. Nobody learns Vim by reading the docs cover-to-cover. You learn `hjkl`, then visual mode, then macros, then you're customizing `init.lua` at 2am. k8s works the same way — spin up [k3s](https://k3s.io/) on one box, run a pod, add a service, graduate to multi-node when the pain demands it. The post links out to [Mike Royal's self-hosting guide](https://github.com/mikeroyal/Self-Hosting-Guide) as a reference map for that incremental journey.

The hardware story grounds the philosophy in specifics. The [Asustor NAS](https://www.asustor.com/) named **three-body** (after [Liu Cixin's trilogy](https://en.wikipedia.org/wiki/The_Three-Body_Problem_(novel))), [10G ethernet](https://en.wikipedia.org/wiki/10_Gigabit_Ethernet) for fast local transfers, the whole homelab genesis. This isn't a theoretical exercise — it's a running system that evolved into the infrastructure behind [joelclaw.com](https://joelclaw.com), the [Inngest event bus](/adrs/inngest-event-bus), the [video ingest pipeline](https://joelclaw.com/cool/video-ingest-pipeline-with-inngest-and-mlx-whisper), and the [k3s cluster ambitions](/adrs/k3s-cluster-for-joelclaw-network). The post captures the moment before all of that — when it was just a NAS and a philosophy.

## Key Ideas

- **Self-hosting is woodworking, not IT** — the workshop is the product, not overhead
- **k8s is like Vim** — start with the basics, accumulate capability incrementally, don't try to learn everything at once
- **[Mike Royal's Self-Hosting Guide](https://github.com/mikeroyal/Self-Hosting-Guide)** — comprehensive reference map for the self-hosting landscape
- **three-body** — the [Asustor NAS](https://www.asustor.com/) that anchors the homelab, named with intent
- **10G ethernet** — local network speed that makes self-hosting practical for media-heavy workflows
- **Sovereignty as philosophy** — own the hardware, own the data, own the platform. Mirrors the [AT Protocol](https://atproto.com/) bet on data ownership at the protocol level

## Links

- [Self-Hosting — joelclaw.com](https://joelhooks.com/self-hosting/)
- [Mike Royal's Self-Hosting Guide](https://github.com/mikeroyal/Self-Hosting-Guide)
- [k3s — Lightweight Kubernetes](https://k3s.io/)
- [Asustor NAS](https://www.asustor.com/)
- [The Three-Body Problem — Liu Cixin](https://en.wikipedia.org/wiki/The_Three-Body_Problem_(novel))
- [ADR-0025: k3s Cluster for joelclaw Network](https://joelclaw.com/adrs/k3s-cluster-for-joelclaw-network)
