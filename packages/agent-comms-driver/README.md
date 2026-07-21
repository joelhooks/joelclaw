# @joelclaw/agent-comms-driver

Zero-policy host driver for the Agent Comms Gateway.

It does four mechanical jobs:

- Pokes one settled Herdr session when `gateway/agent` has pending stream events.
- Appends due `aggregate.deadline.reached` events from agent-authored `holdUntil` values.
- Refreshes a Redis heartbeat only after Herdr proves the pane and session exist and the latest poke settled before its deadline.
- Requests a wake-registry `SPAWN` when the session disappears. It retries if no successor appears within the configured deadline.

It never reads message text and never chooses delivery, routing, grouping, suppression, or escalation.

## Run

```bash
GATEWAY_AGENT_TARGET='<herdr pane id or unique agent name>' \
GATEWAY_SUCCESSOR_BRIEF_PATH='<absolute gateway boot brief>' \
pnpm --filter @joelclaw/agent-comms-driver start
```

Optional settings:

- `GATEWAY_HEARTBEAT_KEY` defaults to `gateway:agent:heartbeat`.
- `GATEWAY_HEARTBEAT_REFRESH_MS` defaults to `15000`.
- `GATEWAY_HEARTBEAT_TTL_MS` defaults to `60000`.
- `GATEWAY_POKE_DEADLINE_MS` defaults to `120000`.
- `GATEWAY_SUCCESSOR_DEADLINE_MS` defaults to `120000`.
- `GATEWAY_DRIVER_RECEIPT_PATH` defaults to `/tmp/joelclaw/agent-comms-driver.jsonl`.

Tests and scratch proofs must set a `test:*` heartbeat key. Never run a proof against the production gateway target.

## Kill drill

The live drill is destructive. It closes the configured gateway pane and sends a real Telegram DM. Run it only during the supervised cutover sitting:

```bash
GATEWAY_AGENT_TARGET='<gateway pane id or unique agent name>' \
GATEWAY_SUCCESSOR_BRIEF_PATH='<absolute gateway boot brief>' \
pnpm --filter @joelclaw/agent-comms-driver kill-drill
```

The script waits for the 60 s heartbeat TTL, runs all eight fallback-contract assertions, and exits non-zero if any stream or receipt evidence is missing. Receipts default to `/tmp/joelclaw/agent-comms-kill-drill.jsonl`.

The weekly drill is ready but unarmed. Arm its first run only after the supervised live drill passes:

```bash
pnpm --filter @joelclaw/agent-comms-driver arm-weekly-drill
```

The arm command schedules `.brain/tasks/agent-comms-gateway-weekly-kill-drill.svx` through `joelclaw wake`, then verifies the `scheduleId` by registry readback. A passing weekly task arms its successor seven days later. A failed drill does not re-arm itself.
