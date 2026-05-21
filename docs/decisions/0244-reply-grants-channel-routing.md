---
status: accepted
date: 2026-05-21
decision-makers:
  - Joel Hooks
related:
  - 0130-slack-channel-integration
  - 0131-unified-channel-intelligence-pipeline
  - 0189-gateway-guardrails
---

# ADR-0244: Reply Grants for Public Channel Participation

joelclaw may observe Slack channels passively, but public participation requires a **Reply Grant**: a User-issued, thread-scoped, short-lived permission recorded in Redis with OTEL receipts. Durable channel permission policy lives in `~/.joelclaw/gateway/channel-permissions.json` and is evaluated with CASL-style RBAC; runtime lifecycle is governed by XState actors in a pure `@joelclaw/channel-routing` package, while `packages/gateway` owns all side effects such as Slack posting, Telegram approval, Redis writes, draft generation, and OTEL emission.

We chose this because the gateway accidentally posted operator-routing filler into a Slack thread after confusing passive intel, public mention handling, and stale source attribution. Inngest is too heavy for low-latency public chat turns, and daemon-local boolean logic is too fragile. CASL answers “is this actor allowed?”, XState answers “which lifecycle state is this interaction in?”, and the gateway adapter performs deterministic effects only when the machine emits approved intents.

Defaults for v1: Slack-only, 5 public replies per grant, 30-minute idle TTL, 2-hour absolute TTL, Telegram alert + private suggested reply for non-granted mentions, `:joelclaw:` reaction as explicit permission, and follow-up chat only for grant invokers allowed by the durable Channel Permission Policy plus the grant’s Invoker Allowlist.
