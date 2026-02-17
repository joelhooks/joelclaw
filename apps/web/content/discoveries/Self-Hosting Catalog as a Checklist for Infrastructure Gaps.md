---
type: discovery
slug: self-hosting-catalog-infrastructure-gaps
source: "https://github.com/mikeroyal/Self-Hosting-Guide"
discovered: "2026-02-17"
tags: [repo, infrastructure, self-hosting, homelab, monitoring, containers, networking, security]
relevance: "reference catalog for joelclaw infrastructure decisions — monitoring, health checks, container logs, system metrics"
---

# Self-Hosting Catalog as a Checklist for Infrastructure Gaps

[Mike Royal's Self-Hosting Guide](https://github.com/mikeroyal/Self-Hosting-Guide) is a 6000+ line curated index of self-hosting tools organized by category — containers, monitoring, dashboards, automation, security, networking, DNS, backups, and about forty other verticals. It's not a tutorial. It's a **lookup table for infrastructure decisions you haven't made yet.**

The real value isn't any single tool recommendation. It's the category coverage. When you're building out a homelab or personal infrastructure stack, the hardest problem isn't picking between [Uptime Kuma](https://github.com/louislam/uptime-kuma) and [Gatus](https://github.com/TwinProduction/gatus) — it's remembering that health checks are a category you need to address at all. This guide functions as a checklist: scan the sections, find the gaps in your stack, evaluate what fills them. The tools that jumped out as immediately relevant: **[Uptime Kuma](https://github.com/louislam/uptime-kuma)** for monitoring, **[Netdata](https://github.com/netdata/netdata)** for system metrics, **[Gatus](https://github.com/TwinProduction/gatus)** for endpoint health checks, and **[Dozzle](https://github.com/amir20/dozzle)** for container log viewing.

The guide also covers [WireGuard](https://www.wireguard.com/) and [Tailscale](https://tailscale.com/) setup in depth, plus sections on [Docker](https://www.docker.com/), [Kubernetes](https://kubernetes.io/), [Ansible](https://www.ansible.com/), and [Grafana](https://grafana.com/) — all of which are already in play or on the roadmap for the [joelclaw](https://joelclaw.com) infrastructure. The [k3s](https://k3s.io/) cluster work ([ADR-0025](/adrs/k3s-cluster-for-joelclaw-network)) and the move toward multi-node federation make the networking, service discovery, and log management sections particularly worth revisiting as the stack grows.

## Key Ideas

- **Category coverage over tool depth** — the guide's value is mapping the full decision space, not deep-diving any single tool. Scan it for gaps you haven't addressed.
- **[Uptime Kuma](https://github.com/louislam/uptime-kuma)** — self-hosted monitoring with a clean UI, status pages, and notifications. Lightweight alternative to [Grafana](https://grafana.com/) for uptime-specific concerns.
- **[Netdata](https://github.com/netdata/netdata)** — real-time system metrics with zero configuration. Runs per-node, which maps well to a multi-machine [Tailscale](https://tailscale.com/) setup.
- **[Gatus](https://github.com/TwinProduction/gatus)** — health check endpoints with conditions (status code, response time, body content). Could complement the [Inngest](https://www.inngest.com/) worker health checks.
- **[Dozzle](https://github.com/amir20/dozzle)** — real-time Docker container log viewer in the browser. Lighter than `docker logs` piped through grep when debugging [Inngest worker issues](https://joelclaw.com/adrs/system-loop-gateway).
- **Sections on [Ansible](https://www.ansible.com/) and configuration management** — relevant as the joelclaw stack grows beyond what launchd plists and manual SSH can maintain.
- **[WireGuard](https://www.wireguard.com/) deep-dive** — covers [PiVPN](https://www.pivpn.io/), [pfSense](https://www.pfsense.org/), and [OpenWRT](https://openwrt.org/) setups. Useful reference if Tailscale ever needs supplementing.

## Links

- [Self-Hosting Guide repo](https://github.com/mikeroyal/Self-Hosting-Guide) — the guide itself
- [Mike Royal on GitHub](https://github.com/mikeroyal) — author, maintains several similar curated guides
- [Uptime Kuma](https://github.com/louislam/uptime-kuma) — self-hosted monitoring
- [Netdata](https://github.com/netdata/netdata) — real-time system metrics
- [Gatus](https://github.com/TwinProduction/gatus) — endpoint health checks
- [Dozzle](https://github.com/amir20/dozzle) — Docker container log viewer
- [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) — related curated list, more tool-focused
- [r/selfhosted](https://www.reddit.com/r/selfhosted/) — community referenced in the guide
