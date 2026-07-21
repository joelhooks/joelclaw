# Agent Comms Gateway operations

The Agent Comms Gateway is the sole comms policy owner. It runs on flagg as one long-lived Claude Code session plus a zero-policy driver. A separate slim transport daemon owns platform mechanics.

The gateway agent runs Opus 4.8 through the Claude Code `opus` alias:

```bash
claude --model opus \
  --plugin-dir prototypes/agent-comms-gateway/claude-plugin \
  --agent joelclaw-gateway
```

The Herdr workspace is `[jc] gateway agent`. Its stable gateway pane label is `📨 gateway loop`. Keep the gateway session and driver in that workspace as separate panes.

## Runtime split

### Gateway agent

The gateway agent decides:

- whether Joel hears a message
- when it is delivered
- how it is rewritten and formatted
- which platform receives it
- whether related events become an aggregate
- how replies, reactions, and button taps route back to their origin

Its policy lives only in:

```text
prototypes/agent-comms-gateway/claude-plugin/prompts/
```

The message stream is durable memory. `gateway.handoff` is advisory. Stream replay wins when the two disagree.

Every consumed external event must get exactly one `gateway.decision.recorded` receipt before the gateway cursor advances. Recorded `deliver` and `aggregate/close-deliver` decisions are executed mechanically by `packages/gateway/src/gateway-decision-executor.ts`.

The policy contract gives platform choice to the gateway agent. The current decision executor delivers only to Telegram. Another platform is not complete without its own transport receipt.

### Driver

`packages/agent-comms-driver` is a zero-policy host process. It:

- pokes the settled gateway pane when stream work exists
- appends due `aggregate.deadline.reached` events
- refreshes the heartbeat only while the gateway session is healthy
- spawns a successor directly through Herdr when the session disappears

Successor creation is Herdr-native. It does not use the wake registry. The target is the stable pane label `📨 gateway loop`. The default successor command is the Opus launch command shown above.

The driver must never inspect message text or choose delivery, routing, grouping, suppression, or escalation.

### Slim transport

The active entrypoint is:

```text
packages/gateway/src/transport-daemon.ts
```

It refuses to start unless:

```bash
GATEWAY_TRANSPORT_SLIM_DOWN=1
```

The package command is:

```bash
pnpm --filter @joelclaw/gateway start:transport-slim
```

In normal operation, use the supervised gateway start script and `joelclaw gateway restart`. Do not run the package command beside the supervised daemon.

Transport owns:

- the single Chat SDK listener for each configured platform
- notify ingress and origin stamping
- inbound authorization and stream append
- `flowId` correlation
- raw fallback delivery
- Telegram execution of recorded deliver decisions
- platform and stream receipts

Transport owns no comms policy. It must not route by kind, priority, lane, digest rules, source strings, or suppression tables.

## Heartbeat and fallback

The Redis heartbeat key is:

```text
gateway:agent:heartbeat
```

The driver refreshes it about every 15 seconds with a 60-second TTL. It refreshes only when:

1. the Herdr pane exists;
2. the Claude session exists;
3. the session is idle or settled;
4. the latest poke completed before its deadline;
5. no poke is stuck.

A crash, wedge, retired session, exhausted Max window, or active turn beyond the TTL stops refreshes. The key expires without a latch or mode transition.

Transport checks key existence for each outbound message after it appends the producer event. If the key is absent, transport sends the producer text verbatim through Telegram.

Production must keep `FALLBACK_CHANNEL=telegram`. SMS is latent. `FALLBACK_CHANNEL=sms` currently throws instead of delivering.

Every fallback message starts with:

```text
⚠️ fallback:
```

After a successful platform send, transport appends `fallback.delivered`. The recovered agent must not redeliver the same raw text.

Do not write the heartbeat by hand to make a red check green. That would hide a dead gateway session.

## Routine checks

Inspect the three runtime parts:

```bash
herdr pane list
joelclaw gateway status
joelclaw gateway diagnose --hours 1 --lines 120
```

Find the gateway pane by its stable label, not by a pane ID from an old session.

Trace a message with:

```bash
joelclaw messages trace <flowId>
```

A healthy trace contains the producer event, one decision receipt, and any applicable platform delivery receipt. `fallback.delivered` means Joel saw the raw fallback text.

Single-owner rule:

- one slim transport daemon
- one gateway agent session
- one poller or socket owner per platform

Never start another listener or gateway session as a repair. A Telegram `409` is evidence of a duplicate poller.

## Start the driver

The production target is the stable pane label. The successor brief remains required by the package interface, even though successor spawning is now Herdr-native.

```bash
GATEWAY_AGENT_TARGET='📨 gateway loop' \
GATEWAY_HERDR_WORKSPACE='[jc] gateway agent' \
GATEWAY_SUCCESSOR_BRIEF_PATH="$PWD/.brain/tasks/gateway-session-boot.svx" \
pnpm --filter @joelclaw/agent-comms-driver start
```

Optional defaults:

- `GATEWAY_HEARTBEAT_KEY=gateway:agent:heartbeat`
- `GATEWAY_HEARTBEAT_REFRESH_MS=15000`
- `GATEWAY_HEARTBEAT_TTL_MS=60000`
- `GATEWAY_POKE_DEADLINE_MS=120000`
- `GATEWAY_SUCCESSOR_DEADLINE_MS=120000`
- `GATEWAY_DRIVER_RECEIPT_PATH=/tmp/joelclaw/agent-comms-driver.jsonl`

Do not point scratch tests at the production pane or heartbeat key. Tests must use a `test:*` key.

## Kill drill

The kill drill proves the real fallback. It closes the real gateway pane and sends a real message to Joel. Run it only as a supervised operation.

```bash
GATEWAY_AGENT_TARGET='📨 gateway loop' \
GATEWAY_HERDR_WORKSPACE='[jc] gateway agent' \
GATEWAY_SUCCESSOR_BRIEF_PATH="$PWD/.brain/tasks/gateway-session-boot.svx" \
pnpm --filter @joelclaw/agent-comms-driver kill-drill
```

The drill must prove all eight steps:

1. close the gateway session;
2. wait for the 60-second heartbeat TTL;
3. send the real drill message;
4. read back `fallback.delivered` for its `flowId`;
5. read back the platform receipt;
6. spawn the successor through Herdr;
7. read back the heartbeat;
8. send a fresh message and read back its gateway decision.

The exact visible text starts with `⚠️ fallback: weekly kill-test drill`. There is no test channel, mock, or drill-aware transport path.

After a supervised drill passes, arm the weekly recurrence:

```bash
pnpm --filter @joelclaw/agent-comms-driver arm-weekly-drill
```

A failed weekly drill does not arm its successor.

## Rollback

Rollback is scripted, but the current script has two unsafe edges: it checks the backup after shutdown starts, and pane-close failure is non-fatal. Do not invoke it without this preflight.

First, record the live gateway pane ID. Then run:

```bash
PANE_ID='<verified gateway pane id>'
BACKUP="$HOME/.joelclaw/scripts/gateway-start.sh.pre-cutover"

test -f "$BACKUP" || { echo "missing rollback backup: $BACKUP" >&2; exit 1; }
pkill -f agent-comms-driver || true
herdr pane close "$PANE_ID"
test -z "$(herdr pane list | jq -r '.result.panes[]? | select(.label == "📨 gateway loop") | .pane_id')" || {
  echo "gateway pane is still live; aborting rollback" >&2
  exit 1
}
scripts/gateway-cutover-rollback.sh "$PANE_ID"
```

The script repeats the driver stop and pane close, restores the pre-cutover start script, restarts the gateway daemon, and sends a probe. Re-closing the verified-absent pane is harmless.

After success, verify the probe appeared in Telegram and inspect its receipt.

Do not clear Redis. Do not start the legacy daemon beside slim transport. Do not run rollback halfway and leave two listener owners alive.

## Source map

- Gateway brief: `.brain/projects/agent-comms-gateway/agent-comms-gateway-brief.svx`
- Decision loop: `~/Vault/docs/decisions/0249-agent-comms-gateway-decision-loop.md`
- Claude plugin: `prototypes/agent-comms-gateway/claude-plugin/`
- Driver: `packages/agent-comms-driver/`
- Slim transport: `packages/gateway/src/transport-daemon.ts`
- Decision executor: `packages/gateway/src/gateway-decision-executor.ts`
- Producer procedure: `skills/messaging/SKILL.md`
