---
status: shipped
date: 2026-02-20
decision-makers: joel
consulted: agent
tags: [telnyx, voice, sms, notification, infrastructure]
---

# ADR-0079: Telnyx Voice & SMS Notification Channel

## Context

joelclaw needed outbound notification beyond Telegram — a way to phone-call or text Joel when time-sensitive work completes. The system already had:

- Telegram bot for async text/media
- Todoist for task-based Q&A
- Gateway for event delivery

None of these interrupt. A phone call does.

## Decision

Use **Telnyx** as the outbound voice and SMS provider via their REST API v2.

### Why Telnyx (not Twilio)

- Already configured: SIP connection (`joelclaw-livekit-sip`), OVP, phone number (`<redacted-phone>`) provisioned for LiveKit SIP bridge (ADR-0043)
- TeXML support for TTS calls without webhook infrastructure
- SMS on the same number (if enabled)
- Cheaper than Twilio for low-volume

### Architecture

```
joelclaw call "message"
  → notification/call.requested event
    → telnyx-notify Inngest function
      → step: place TeXML TTS call
      → step: wait 30s
      → step: check call status
      → step: if unanswered → send SMS fallback
```

### Components

| File | Purpose |
|------|---------|
| `packages/system-bus/src/lib/telnyx.ts` | API client (placeCall, sendSMS, checkSMSEnabled, getCall) |
| `packages/system-bus/src/inngest/functions/telnyx-notify.ts` | Durable call→SMS flow |
| `packages/cli/src/commands/call.ts` | `joelclaw call "message"` CLI |

### Secrets

| Name | Purpose |
|------|---------|
| `telnyx_api_key` | API authentication |
| `telnyx_connection_id` | SIP connection for calls |
| `telnyx_phone_number` | FROM number |
| `telnyx_ovp_id` | Outbound voice profile |
| `joel_phone_number` | TO number ((stored in agent-secrets as joel_phone_number)) |

### Security

- Joel's phone is the only allowed destination (caller allowlist already configured on Telnyx side)
- Secrets leased via agent-secrets CLI with env var fallback
- OVP whitelisted to US/CA only

## Consequences

- System can now interrupt Joel for urgent completions
- SMS fallback ensures delivery even if call is missed
- TeXML means no webhook server needed for TTS
- Future: could add inbound call handling (already have LiveKit SIP bridge)
