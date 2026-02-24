---
title: "ADR-0122: Multi-Node Channel Identity Config"
status: proposed
date: 2026-02-24
tags: [gateway, channels, identity, multi-node]
---

# ADR-0122: Multi-Node Channel Identity Config

## Status

proposed

## Context

Channel configs (Telegram user ID, Discord user ID, iMessage sender) are currently hardcoded in `gateway-start.sh` or leased from agent-secrets per-node. This works for a single owner but doesn't compose when other people want to run their own joelclaw node — they'd have to fork and edit the startup script.

## Decision

TBD. Options:
- Extend `GatewayConfig` (Redis-backed) to include per-channel identity config
- Add a `~/.joelclaw/channels.json` config file read at daemon startup
- Keep env vars but provide a `joelclaw gateway configure` CLI wizard that writes to secrets + a portable config

## Deferred Until

There are at least 2 non-Joel nodes running joelclaw, or someone asks.
