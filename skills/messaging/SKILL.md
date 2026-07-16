---
name: messaging
displayName: Messaging v2
version: 0.1.0
author: joel
description: Send joelclaw operator messages through contract v2, consume reaction/reply events by flowId, and operate the Chat SDK acting/shadow cutover safely. Use for notify send, rich message intents, message reactions, message replies, Chat SDK, flowId correlation, or messaging transport ownership.
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
- consume reactions or replies to an outbound message
- inspect a message lifecycle by `flowId`
- change Chat SDK acting/shadow flags or gateway listener ownership
- add or migrate a message producer

Also load `gateway` for daemon operations, `inngest-events` for bus consumers, `telegram` for Telegram-specific behavior, and `system-architecture` for cross-host/runtime changes.

## Send from scripts and agents: keep `notify send`

Existing callers keep using:

```bash
joelclaw notify send "<message>" --priority high
```

The CLI shape is unchanged. When `CHAT_SDK_ACTING_ENABLED=1`, the gateway compatibility shim maps the legacy request to contract v2 and sends through Chat SDK. `--channel` and `--telegram-only` are accepted during migration, but contract v2 routing is authoritative; do not use those flags as new policy.

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

## Reactions and replies by flowId

Return-path events are:

```text
message/reaction.received
message/reply.received
```

Reaction data:

```ts
{
  flowId,
  platform,
  emoji,
  action: "added" | "removed",
  actor: { id, displayName? },
  at
}
```

Reply data:

```ts
{
  flowId,
  platform,
  text,
  actor: { id, displayName? },
  at
}
```

Create an ordinary Inngest function, trigger on the event name, and match the stored `flowId` from the original receipt:

```ts
import { MESSAGE_REACTION_RECEIVED } from "@joelclaw/message-contract";

export const consumeReaction = inngest.createFunction(
  { id: "my-message-reaction" },
  { event: MESSAGE_REACTION_RECEIVED },
  async ({ event, step }) => {
    const owner = await step.run("resolve-flow-owner", () => lookupOwner(event.data.flowId));
    if (!owner) return { status: "ignored", flowId: event.data.flowId };
    return step.run("apply-reaction", () => applyReaction(owner, event.data));
  },
);
```

Do not subscribe by platform message ID. The gateway journals that ID and resolves it back to `flowId` before publishing the bus event.

Current earned truth: reaction-to-`flowId` publication is wired in the acting inbound dispatcher. `message/reply.received` exists in the contract, but verify an acting publisher/live canary before building a critical consumer around replies.

Inspect one lifecycle with:

```bash
joelclaw messages trace <flowId>
joelclaw otel search "<flowId>" --hours 24
```

## Acting, shadow, and rollback

The live gateway embeds one Chat SDK instance. Never start a second platform listener or standalone Chat SDK daemon.

| flag | meaning |
|---|---|
| `CHAT_SDK_ACTING_ENABLED=1` | Chat SDK owns the acting Telegram/Slack transport path after supervised handover |
| `CHAT_SDK_INBOUND_SHADOW_ENABLED=1` | keep in-process normalized inbound comparison taps on |
| `CHAT_SDK_OUTBOUND_SHADOW_ENABLED=1` | run outbound comparison where explicitly enabled |

Transport handover order is legacy active → stop legacy Telegram/Slack → register acting handlers → start SDK with `legacyTransportsStopped: true`. Require ordered `chat_sdk.handover.*` OTEL receipts.

Rollback is `CHAT_SDK_ACTING_ENABLED=0` in the existing gateway start environment plus one supervised `joelclaw gateway restart`. Preserve journal, diff, OTEL, and unacked queue evidence. Never clear Redis or start legacy listeners beside an SDK owner to make a health check look green.

Legacy channel deletion is gated on the accepted acting observation window. Until burst, restart/replay, reaction correlation, clean diff, and daily-use proofs are accepted, legacy code is rollback equipment.

Canonical runbook: `.brain/projects/messaging-stabilization/run-shadow-window-cutover.svx`.

## Rules

- One gateway process and one listener owner per platform.
- `command-queue` is the only path into the Pi session.
- Chat SDK events may observe on the bus; shadow events never execute.
- Producers use kinds; the routing table owns platforms and lanes.
- Store and correlate by `flowId`.
- A receipt without visible delivery is a rollback trigger, not success.
- Pin all Chat SDK packages to the same exact release and re-run platform canaries on upgrades.
- iMessage remains hand-rolled; do not pretend Chat SDK owns it.
