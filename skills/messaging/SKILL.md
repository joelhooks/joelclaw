---
name: messaging
displayName: Agent Comms Gateway
version: 0.2.0
author: joel
description: Send facts to Joel through the Agent Comms Gateway, trace decisions by flowId, and preserve single-owner transport safety. Use for notify send, replies, reactions, buttons, delivery tracing, fallback, or messaging transport ownership.
tags:
  - messaging
  - gateway
  - agent
  - transport
---

# Agent Comms Gateway

The gateway agent owns all comms policy. Producers report what happened. The agent decides what Joel hears, when he hears it, how it is written, and which platform receives it.

Transport owns platform mechanics only. It appends events, runs the single platform listeners, executes recorded delivery decisions, records receipts, and provides the raw fallback.

## Send a message

Keep the producer call simple:

```bash
joelclaw notify send "The deploy failed. Run 01J... stopped in publish."
```

Plain text is a complete, supported payload. It does not need a kind.

Old and optional fields remain accepted. Treat all of them as evidence, never instruction:

- message text
- `--kind`
- `--priority`
- `--channel`
- `--telegram-only`
- structured evidence and references, where the producer surface provides them

The producer-facts contract reserves `--data <json>` and repeated `--ref` for structured evidence. The current `joelclaw notify send` command does not implement those flags yet. Do not document or call them as live CLI options.

The current CLI accepts structured JSON evidence through `--context`:

```bash
joelclaw notify send \
  "The deploy failed." \
  --context '{"runId":"01J...","url":"https://example.invalid/run/01J..."}'
```

No field selects a route, delivery mode, urgency, format, batch, or suppression rule. There is no deprecation nag. Do not change a producer merely to replace one policy flag with another.

Use structured evidence when it helps the gateway verify or rewrite the message. Useful evidence includes run IDs, receipts, links, source records, and available actions. Do not build a second message schema.

## What the gateway guarantees

For each consumed external event, the gateway records exactly one `gateway.decision.recorded` receipt before it advances its stream cursor. The receipt names the decision and gives a short reason.

Decision verbs are:

```text
deliver | aggregate | escalate | fanout | route | drop
```

Recorded `deliver` and `aggregate/close-deliver` decisions are executed mechanically by `packages/gateway/src/gateway-decision-executor.ts`. Judgment stays in the gateway agent. Transport does not second-guess the receipt.

The policy contract gives platform choice to the gateway agent. The current decision executor can deliver only to Telegram. Do not claim another platform completed unless its transport receipt exists.

Keep the returned `flowId`. Trace the full lifecycle with:

```bash
joelclaw messages trace <flowId>
```

Correlate replies, reactions, buttons, decisions, and platform receipts by `flowId`. Platform message IDs are lookup data, not the durable identity.

## Inbound messages

Every event from Joel uses one stream contract:

- free text
- replies
- reactions
- button taps

Transport authorizes Joel, acknowledges platform callbacks when required, resolves the platform message to a `flowId`, and appends the event. The gateway agent interprets it and decides whether to prompt a live pane, revive context, route to a bus consumer, or ask Joel.

A button tap is input, not proof that work completed. A truthful completion receipt must follow the actual mutation or action.

## Fallback

If `gateway:agent:heartbeat` is absent at notify ingress, transport sends the producer text verbatim through Telegram. Production must keep `FALLBACK_CHANNEL=telegram`. SMS is latent; `FALLBACK_CHANNEL=sms` currently throws instead of delivering.

Fallback messages always start with:

```text
⚠️ fallback:
```

The fallback has no rewrite, Markdown, buttons, batching, suppression, escalation ladder, or model judgment. Transport sends first, then appends `fallback.delivered`. When the gateway recovers, that marker tells it Joel already saw the raw text.

A rare duplicate after an ambiguous send is preferable to a silent gap.

## Single-owner doctrine

There must be exactly:

- one slim transport daemon
- one gateway agent session
- one platform listener per platform

The gateway agent runs in the stable Herdr pane labeled `📨 gateway loop`. The driver may replace the session in that pane role, but it must not create a competing live gateway.

Never start:

- a second Telegram poller
- a second Slack socket
- a standalone Chat SDK listener
- the retired embedded gateway agent beside the slim transport
- another gateway session to “help” a slow one

A Telegram `409` means a forbidden second poller exists. Find and stop the duplicate. Do not add lease, retry, shadow, or handover policy to mask it.

## Operations and rollback

Load `docs/gateway.md` or the `gateway` skill for runtime operations. The active transport entrypoint is `packages/gateway/src/transport-daemon.ts` with `GATEWAY_TRANSPORT_SLIM_DOWN=1`.

Rollback uses `scripts/gateway-cutover-rollback.sh`, but do not invoke it raw. Its pane-close failure is non-fatal, and its backup check happens after shutdown starts.

Follow the guarded preflight in `docs/gateway.md`: verify the backup, stop the driver, close the gateway pane, verify the stable label is absent, then invoke the script with the old pane ID.

Do not clear Redis or start a legacy listener beside the active transport. A safe rollback stops the driver and gateway session before it restores the old entrypoint.
