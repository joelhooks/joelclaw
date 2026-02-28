---
status: accepted
date: 2026-02-26
decision-makers: joel
parent: ADR-0043
related:
  - ADR-0121
  - ADR-0148
---

# ADR-0154: LiveKit Voice Worker Durability Contract

## Context

Live voice calls previously worked end-to-end, but regressed to "ringing with no answer."

Observed failure pattern on 2026-02-26:
- LiveKit and SIP were healthy.
- Rooms were created and SIP participants joined.
- `NON_SIP_PARTICIPANTS=0` in LiveKit stats during failed windows.
- Calls ended after SIP participant departure timeout.

The answering worker code still exists at `/Users/joel/Projects/joelclaw-voice-agent`, but runtime ownership is ad hoc:
- started manually via `run.sh`
- no launchd service
- no k8s deployment
- no watchdog/auto-heal contract

This is a durability failure, not a LiveKit server failure.

OpenRouter usage in the LiveKit voice path is intentional and remains in scope per ADR-0043.

Observed follow-up issue on 2026-02-27: strict raw caller matching rejected legitimate Joel calls when caller ID arrived in variant formats (`+1`, punctuation, or SIP/tel prefixes).

## Decision

Adopt a first-class durability contract for the LiveKit voice worker.

### 1) Runtime owner

The voice worker runs as a launchd-managed host service on Panda:
- Label: `com.joel.voice-agent`
- Domain: `gui/<uid>`
- Startup: `RunAtLoad=true`
- Restart: `KeepAlive=true`

### 2) Source-of-truth ops artifacts

Service assets are versioned in the joelclaw repo (not hand-managed in `~/Library/LaunchAgents`):
- `ops/voice-agent/com.joel.voice-agent.plist`
- `ops/voice-agent/run-voice-agent.sh`
- `ops/voice-agent/install.sh`

### 3) Health + telemetry contract

Voice worker must emit structured telemetry:
- `voice.worker.started`
- `voice.worker.heartbeat` (every 60s)
- `voice.worker.error`
- `voice.worker.stopped`

Telemetry goes through the joelclaw OTEL pipeline for queryable runtime state.

### 4) Auto-heal contract

When either condition is detected:
- heartbeat stale (`>180s`), or
- repeated SIP-only call windows with no non-SIP participant join,

system triggers:
- `launchctl kickstart -k gui/<uid>/com.joel.voice-agent`

and emits:
- `voice.worker.heal.attempt`
- `voice.worker.heal.success`
- `voice.worker.heal.failed`

### 5) Operator surface

Expose voice runtime controls as first-class CLI commands:
- `joelclaw voice status`
- `joelclaw voice restart`
- `joelclaw voice logs`
- `joelclaw voice test-call`

### 6) Provider stance for voice

For the LiveKit voice worker, OpenRouter remains explicitly allowed until superseded by a new ADR. This avoids policy drift against ADR-0043.

### 7) Caller identity matching contract

Allowlist checks must compare normalized caller IDs, not raw room tokens.

Normalization contract:
- strip `tel:` / `sip:` prefixes,
- remove non-digit characters,
- for US numbers, collapse leading `1` on 11-digit numbers to canonical 10-digit form.

Rejection logs must include both raw and normalized caller forms for incident forensics.

## Implementation Plan

1. Add launchd assets to repo under `ops/voice-agent/`.
2. Install and load `com.joel.voice-agent` from repo-owned assets.
3. Update voice worker code to emit heartbeat and lifecycle telemetry.
4. Add watchdog logic in system-bus for stale heartbeat / SIP-only detection.
5. Add `joelclaw voice` command group for runtime operations.
6. Add runbook updates to the relevant skill(s) and ADR index entry.

## Verification Checklist

- [ ] `launchctl print gui/$(id -u)/com.joel.voice-agent` shows `state = running` after install.
- [ ] Service survives reboot and restarts automatically.
- [ ] Killing the worker process results in automatic recovery (`KeepAlive`/kickstart).
- [ ] Inbound test call shows non-SIP participant join in LiveKit for answered calls.
- [ ] Caller allowlist accepts equivalent Joel number formats (`817...`, `+1817...`, punctuation variants) after normalization.
- [ ] `joelclaw otel search "voice.worker.heartbeat" --hours 1` returns fresh events.
- [ ] `joelclaw otel search "voice.worker.heal" --hours 1` shows attempt/success/failure when forced.
- [ ] `joelclaw voice status` reports launchd state + heartbeat age.

## Consequences

### Positive
- Voice answering path becomes durable across shell exits, crashes, and reboots.
- Failures become visible through OTEL instead of silent regressions.
- Recovery path is codified and automatable.
- Runtime ownership is explicit and scriptable.

### Negative / Tradeoffs
- Adds service lifecycle code and watchdog maintenance burden.
- Launchd remains host-coupled; this is not a full k8s migration.
- Requires discipline to keep repo assets and loaded launchd config in sync.

## Status

Accepted.
