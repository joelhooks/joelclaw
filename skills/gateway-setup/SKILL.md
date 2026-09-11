---
name: gateway-setup
displayName: Gateway Setup
description: "Set up a persistent AI agent gateway on macOS with Redis event bridge, heartbeat monitoring, and multi-session routing. Interactive Q&A to match your intent — from minimal (Redis + extension) to full (embedded daemon + Telegram + watchdog). Use when: 'set up a gateway', 'I want my agent always on', 'event bridge', 'heartbeat monitoring', 'agent notifications', or any request to make an AI agent persistent and reachable."
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, gateway, setup, redis, telegram]
disable-model-invocation: true
---

# Gateway setup

Start with the requested environment and current source. Read `gateway` and the existing service ownership configuration before installing anything. A fleet with an existing gateway needs repair or configuration of that owner, not another gateway.

Infer supplied scope choices from the request. Ask only for missing decisions that change the intended transport, host, or authority. A plan request produces a plan; an explicit setup request authorizes its scoped implementation.

Use the current repository installer and live help. Keep the gateway policy, durable inbound queue, and channel adapters behind their established contracts. Never create a second poller, socket listener, gateway session, standalone adapter process, or monitoring daemon to work around an unhealthy owner.

Discover current endpoint and model configuration. Do not install historical hostnames, tmux recipes, embedded agents, or model pins from an old example. Verify credentials through the owning secret mechanism without reading them into logs or source files.

Verify readiness, event correlation, and supported health checks. Use synthetic or task-owned fixtures for fault tests. Do not interrupt shared transport or heartbeat processes as routine setup verification. A real outbound canary needs authorization for its destination and content.

Report what was installed or changed, the actual owner and readiness evidence, and unresolved failures. Preserve existing configuration and unrelated work.
