---
type: discovery
slug: dogfooding-agent-tools-live-rails-migration
source: "https://www.loom.com/share/ffd749d2dead403c8859c71461c82628"
discovered: "2026-02-25"
tags: [video, egghead, rails, migration, agent-tools, dogfooding, infrastructure]
relevance: "direct evidence of the joelclaw agent stack doing real production work — migrating egghead off Rails via PR #261"
---

# Dogfooding Agent Tools on a Live Rails Migration

This is a [Loom recording](https://www.loom.com/share/ffd749d2dead403c8859c71461c82628) Joel shared in the [egghead](https://egghead.io) Slack showing him using his own tooling to work on migrating egghead off [Rails](https://rubyonrails.org/). The specific context is a **purchase bug fix** tied to [PR #261](https://github.com/skillrecordings/course-video-manager/pull/261) in [Matt](https://github.com/vojtaholik)'s [course-video-manager](https://github.com/skillrecordings/course-video-manager) repo.

The thing that makes this worth capturing isn't the bug fix itself — it's the meta-layer. Joel built an entire agent operating system and here it is doing **real production work** on egghead's infrastructure. Not a demo. Not a toy example. An actual Rails migration with a real PR and a real bug that needed fixing. The tools justify themselves when they're the tools you reach for to get work done.

Migrating off Rails is one of those long-tail infrastructure projects that accumulates complexity in every corner. Purchase flows touch payment processing, user state, course access — all the stuff that breaks quietly. Having agent tooling that can navigate that kind of codebase and produce a concrete PR is the difference between "I should migrate off Rails someday" and actually shipping the migration in pieces.

[TODO: Joel's specific commentary from the Loom on what the tools did and how the workflow felt]

## Key Ideas

- **Dogfooding as validation** — the strongest signal that your tools work is when you use them on real problems, not contrived demos
- **Rails migration in progress** at [egghead](https://egghead.io) — purchase flow is one of the critical paths being moved off the legacy stack
- **PR #261** in [course-video-manager](https://github.com/skillrecordings/course-video-manager/pull/261) — a concrete bug fix artifact from the migration work
- **Agent-assisted migration** — using the [joelclaw](https://joelclaw.com) stack to navigate and modify a legacy Rails codebase
- **Loom as async artifact** — shared in Slack so the team can see the workflow without a live meeting

## Links

- [Loom recording](https://www.loom.com/share/ffd749d2dead403c8859c71461c82628)
- [course-video-manager repo](https://github.com/skillrecordings/course-video-manager)
- [PR #261](https://github.com/skillrecordings/course-video-manager/pull/261)
- [egghead.io](https://egghead.io)
