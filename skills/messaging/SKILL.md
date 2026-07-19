---
name: messaging
displayName: Messaging v2
version: 0.1.0
author: joel
description: Send joelclaw operator messages through contract v2, design button callbacks and replies by flowId, and operate the canonical Chat SDK transport safely. Use for notify send, rich message intents, Telegram inline buttons, callback queries, message replies, Chat SDK, flowId correlation, or messaging transport ownership.
tags:
  - messaging
  - gateway
  - chat-sdk
  - inngest
---

# Messaging v2

joelclaw messaging uses Vercel Chat SDK as the Discord, Telegram, and Slack adapter layer behind joelclaw policy. The SDK owns platform mechanics. joelclaw still owns authorization, routing, suppression, durable queueing, journaling, receipts, health, and transport ownership.

## When to use

Load this skill when an agent needs to:

- DM Joel or send an operator notification
- send a rich message with a stable correlation ID or reply anchor
- consume button callbacks or replies to an outbound message
- inspect a message lifecycle by `flowId`
- change Chat SDK gateway listener ownership or transport wiring
- add or migrate a message producer

Also load `gateway` for daemon operations, `inngest-events` for bus consumers, `telegram` for Telegram-specific behavior, and `system-architecture` for cross-host/runtime changes.

## Send from scripts and agents: keep `notify send`

Existing callers keep using:

```bash
joelclaw notify send "<message>" --priority high
```

The CLI shape is unchanged. The gateway compatibility shim maps the legacy request to contract v2 and sends through Chat SDK. `--channel` and `--telegram-only` remain accepted compatibility inputs, but contract v2 routing is authoritative; do not use those flags as new policy.

Declare meaning with `--kind` (added 2026-07-18). Without it, the shim infers kind from priority/source, and low/normal-priority sends become `digest` — which the Telegram digest lane may batch or **silently suppress**:

```bash
joelclaw notify send "Here is the list you asked for" --kind ask
```

`--kind` accepts `memory | alert | digest | ask | receipt` and overrides inference. Use `ask`/`alert`/`memory` for anything Joel must actually see (operator lane, always delivers). After sending, verify terminal delivery with `joelclaw otel search "<eventId>" --hours 1` — it must show `notify.compat_v2.confirmed`; a queued event with a drained gateway queue is not delivery.

Use `notify send` for simple text from shell scripts, satellites, skills, and packages that do not own the gateway composition root. Do not import gateway internals across package boundaries.

## Send rich intents: use contract v2

Inside the gateway composition root, call the Chat SDK `send()` seam with a contract-v2 intent:

```ts
import { MESSAGE_CONTRACT_VERSION } from "@joelclaw/message-contract";
import { send } from "./chat-sdk";

const receipt = await send({
  contractVersion: MESSAGE_CONTRACT_VERSION,
  kind: "ask",
  content: "Approve the cutover?",
  correlationId: "cutover:messaging-v2:approval",
});

const flowId = receipt.data.flowId;
```

Current public boundary: `@joelclaw/message-contract` exports schemas and types, while the acting `send()` implementation is gateway-local. An external package should use `joelclaw notify send` or add a deliberate composition-root adapter. Never use a cross-package relative import into `packages/gateway`.

A follow-up can anchor to the parent flow:

```ts
await send({
  contractVersion: MESSAGE_CONTRACT_VERSION,
  kind: "receipt",
  content: "Cutover confirmed.",
  correlationId: "cutover:messaging-v2:result",
  replyTo: flowId,
});
```

Every successful or terminal call returns a HATEOAS receipt with `flowId`, route, requested/confirmed timestamps, delivery state, platform message ID, and thread ID. Store the `flowId`; consumers correlate on it, not on a Telegram/Slack/Discord ID.

## Kinds and current routing table

Producers declare meaning. They do not declare platform, lane, urgency, or formatting.

| kind | use it for | current route |
|---|---|---|
| `memory` | a surfaced memory or taste-learning prompt | Telegram, operator lane, normal |
| `alert` | an actionable failure or urgent operator signal | Telegram, operator lane, critical |
| `digest` | batched or low-urgency information | Telegram, digest lane, low |
| `ask` | a decision, approval, or direct question | Telegram, operator lane, high |
| `receipt` | an automation/mutation result | Slack, automation lane, normal |

Source of truth: `packages/message-contract/src/routing.ts`. If the desired destination changes, edit and version the routing table. Do not teach every producer a new set of flags.

### The alert-vs-memory suppression lesson

A neat-memory DM originally used low priority and Telegram-only flags. Low priority entered the gateway agent-prompt lane and policy suppressed it. The producer was forced to reverse-engineer routing from flags.

Contract v2 fixes that: call a memory `memory`, an alert `alert`, and an approval `ask`. Routing policy decides the lane. Do not encode meaning as `priority`, `channel`, or `telegramOnly` in new producers.

## Button callbacks and replies by flowId

Joel rejected emoji reactions as an operator action API on 2026-07-19. Actionable Telegram DMs use labeled inline keyboard buttons. A callback is an action request, not a synthetic reaction and not proof that the action completed.

Accepted target event:

```text
message/action.requested
```

Target data:

```ts
{
  flowId,
  platform: "telegram",
  actionId,
  actor: { id, displayName? },
  rawEventId,          // callback_query.id; idempotency key
  platformMessageId,  // lookup input only
  at
}
```

The existing Chat SDK `callback_query` owner must answer the callback, authorize Joel, resolve the platform message to `flowId`, verify the action was declared on that flow, then publish the request. Consumers subscribe by `flowId` and `actionId`. They emit a truthful receipt only after their append, schedule, or mutation has been read back.

The button-native source path uses `kind: "callback"`, stable `learner-flow.*` IDs, and `message/action.requested`. It is not earned live truth until the gateway and host worker are deployed and one `Seen` tap reaches the `learner-flow/action` receipt. Never treat a reaction event, queue acceptance, or Telegram spinner acknowledgement as button proof. Design source: `.brain/projects/messaging-stabilization/design-button-native-interactions.svx`.

`message/reply.received` exists in the contract, but verify an acting publisher/live canary before building a critical consumer around replies.

Inspect one lifecycle with:

```bash
joelclaw messages trace <flowId>
joelclaw otel search "<flowId>" --hours 24
```

## Canonical ownership and rollback

The live gateway embeds one Chat SDK instance. It starts directly as the only Telegram poller and Slack Socket Mode owner. There are no acting or shadow flags and no start-then-stop handover.

Telegram-specific commands, callbacks, media intake, journaling, formatting, streaming, and direct Bot API side effects live in `packages/gateway/src/telegram-runtime.ts`. That runtime never polls; Chat SDK feeds it canonical command, button-action, and attachment events. Slack Reply Grant/passive-intel policy and Web API side effects live in `packages/gateway/src/slack-runtime.ts`, backed by the SDK adapter's `webClient`.

Rollback is source control: review and revert the legacy-transport deletion, then run one supervised `joelclaw gateway restart`. Never clear Redis or start a second listener beside the SDK owner.

Historical cutover receipts: `.brain/projects/messaging-stabilization/run-shadow-window-cutover.svx`.

## Rules

- One gateway process and one listener owner per platform.
- `command-queue` is the only path into the Pi session.
- Chat SDK publishes observe-only bus copies; only the canonical dispatcher executes.
- Producers use kinds; the routing table owns platforms and lanes.
- Store and correlate by `flowId`.
- A receipt without visible delivery is a rollback trigger, not success.
- Pin all Chat SDK packages to the same exact release and re-run platform canaries on upgrades.
- iMessage remains hand-rolled; do not pretend Chat SDK owns it.
