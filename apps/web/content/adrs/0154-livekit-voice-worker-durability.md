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

At incident time, the answering worker code lived at `/Users/joel/Projects/joelclaw-voice-agent` and runtime ownership was ad hoc:
- started manually via `run.sh`
- no launchd service
- no k8s deployment
- no watchdog/auto-heal contract

Follow-up implementation moved the runtime into monorepo-owned paths under `infra/voice-agent` and launchd now executes the monorepo start script.

This is a durability failure, not a LiveKit server failure.

OpenRouter usage in the LiveKit voice path is intentional and remains in scope per ADR-0043.

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
- `infra/voice-agent/main.py`
- `infra/voice-agent/run.sh`
- `infra/voice-agent/start.sh`
- `infra/launchd/com.joel.voice-agent.plist`
- `infra/voice-agent/config.default.yaml` (repo-safe defaults, no caller PII)

Runtime-local caller config lives outside git:
- `~/.config/joelclaw/voice-agent.yaml`

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

### 7) Caller identity matching + PII placement

Allowlist checks must compare normalized caller IDs, not raw room tokens.

Normalization contract:
- strip `tel:` / `sip:` prefixes,
- remove non-digit characters,
- for US numbers, collapse leading `1` on 11-digit numbers to canonical 10-digit form.

Policy is fail-closed: if caller extraction/normalization yields an empty value, reject the call.

Caller PII (allowlist numbers) must live in local runtime config (`~/.config/joelclaw/voice-agent.yaml`) or env, not in repository source files.

Rejection logs must include both raw and normalized caller forms for incident forensics.

## Implementation Plan

1. Keep launchd + runtime assets in repo under `infra/launchd/` and `infra/voice-agent/`.
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
- [ ] Missing/unparseable caller IDs are rejected (fail-closed) with raw+normalized logging.
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
