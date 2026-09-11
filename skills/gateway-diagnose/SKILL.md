---
name: gateway-diagnose
displayName: Gateway Diagnose
description: "Diagnose gateway failures by reading daemon logs, session transcripts, Redis state, and OTEL telemetry. Full Telegram path triage: daemon process → Redis channel → command queue → pi session → model API → Telegram delivery. Use when: 'gateway broken', 'telegram not working', 'why is gateway down', 'gateway not responding', 'check gateway logs', 'what happened to gateway', 'gateway diagnose', 'gateway errors', 'review gateway logs', 'fallback activated', 'gateway stuck', or any request to understand why the gateway failed. Distinct from the gateway skill (operations) — this skill is diagnostic."
version: 1.1.5
author: Joel Hooks
tags: [joelclaw, gateway, diagnosis, logs, telegram, reliability]
disable-model-invocation: true
---

# Gateway diagnosis

Find the failing request, event, run, or flow id and expected behavior. Start from the existing evidence; diagnosis does not itself authorize sending a probe message.

Read the current gateway entrypoint, service configuration, and ownership/runbook. Use `joelclaw gateway --help` for supported status, event, and diagnostic commands. Resolve service placement before probing dependencies; an absent local cluster is not evidence that a remotely owned dependency failed.

Trace the actual path: ingress, durable queue, policy, gateway session, adapter, and delivery receipt. Compare timestamps, correlation ids, progress, and configured timeouts. Queue age alone does not prove a hung agent. Degraded dependencies may still permit useful channel and session diagnosis.

Follow the first relevant failure to its cause. For an audit, report it. For an authorized repair, fix that failure and continue independent diagnosis. Do not stop the whole task merely because the first probe failed.

Use the configured model, provider, process owner, and current startup source. Historical error strings are clues, not a mandate to restore old embedded controllers, poll-owner leases, or model pins.

Preserve the single transport and gateway owners. Do not start a competing poller or gateway, weaken access controls, kill processes by name, or reset a shared checkout. Use the owning service's scoped restart or recovery path when authorized.

Verify the affected behavior and report the exact observation. A successful queue submission is not proof of delivery. Never print tokens, raw private messages, or auth files in a diagnostic report.
