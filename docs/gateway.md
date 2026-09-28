# Agent Comms Gateway operations

The Agent Comms Gateway is the sole comms policy owner. It runs on flagg as one long-lived Claude Code session plus a zero-policy driver. A separate slim transport daemon owns platform mechanics.

The gateway agent pins Claude Sonnet 4.6. It handles fast comms judgment and dispatches harder work to Herdr workers:

```bash
MESSAGE_EVENT_CONVEX_URL=http://127.0.0.1:3210 \
  cswap run "$GATEWAY_CLAUDE_ACCOUNT" --require-session --share-history -- \
  --model claude-sonnet-4-6 \
  --effort medium \
  --plugin-dir prototypes/agent-comms-gateway/claude-plugin \
  --agent joelclaw-gateway
```

`infra/agent-comms-driver-daemon.sh` builds this command into `GATEWAY_SUCCESSOR_COMMAND`. The driver package default is still bare `claude`; start the driver through the launcher, not the package command, so successors never land on the shared login.

Do not use the moving `sonnet` alias here. Pin `MESSAGE_EVENT_CONVEX_URL` locally so a stale fleet `JOELCLAW_CENTRAL_URL` cannot send the plugin to the ghost `flagg` node. A Herdr-restored bare `claude --resume` process is not healthy because it lacks the gateway plugin tools.

The gateway lives in Herdr's `default` session, inside workspace `[jc] gateway agent`. Its stable pane label is `📨 gateway loop`. Other automation stays in the named `system` session. After a reboot, the gateway starts only after Joel logs into the Mac; until then transport delivers raw fallback messages.

## Claude login

The gateway runs on its own claude-swap account in a session profile (`cswap run`), never on the default Claude login that `cswap switch` swaps. Two failures forced this on 2026-09-28:

- Claude refresh tokens are one-time-use. A long-lived gateway on the shared login refreshed whichever account was active at launch and wrote that token over later switches, so another account's stored token went stale and needed a re-login.
- Processes in the system launch domain cannot read the login Keychain reliably. cSwap logged `find-generic-password timed out`, then refused switches with `Current account credential is empty (Keychain unreadable?)`.

`GATEWAY_CLAUDE_ACCOUNT` in the driver LaunchAgent names the dedicated cSwap slot. Keep that slot disabled from auto-rotation (`cswap disable <slot>`) and never `cswap switch` the default login to it. `--require-session` refuses to launch if it already is the default login.

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

### Recurring incident contract

Recurring alarm producers put stable incident facts in the canonical
`message.requested` envelope:

```text
source                              # message.requested.source
anomalyId                           # payload.evidence.anomalyId
state = open | changed | resolved   # payload.evidence.state
severity                            # payload.evidence.severity
observedAt                          # payload.evidence.observedAt
evidence                            # payload.evidence.evidence
```

Use a condition ID such as `welcome-email-backlog`. Never put a run ID in
`anomalyId`. Producers report transitions. They do not choose delivery.

`@joelclaw/gateway-incident-latch` folds canonical
`gateway.decision.recorded` receipts into state keyed by `(source, anomalyId)`.
The receipt keeps first and last observation times, evidence hash, repeat
count, aggregate ID, delivery times, platform anchor, resolution tombstone,
and `follows` for a reopened successor. Redis is optional cache only.

The first occurrence delivers and opens an incident aggregate. Identical
repeats join without another DM. One material `changed` transition and one
`resolved` transition can deliver. Resolved repeats record a drop. Per anomaly,
the immediate cap is three Telegram DMs per Pacific day: open, one change, and
resolution. A distinct critical condition must use and name its distinct
`anomalyId`. Routine all-good evidence joins one dated daily digest.

The policy contract gives platform choice to the gateway agent. The current decision executor delivers only to Telegram. Another platform is not complete without its own transport receipt.

### Driver

`packages/agent-comms-driver` is a zero-policy host process. It:

- pokes the settled gateway pane when stream work exists
- limits one poke to 20 inputs or four minutes
- requires the pinned model, gateway plugin, and gateway agent launch arguments
- treats a settled poke as healthy only when the authoritative cursor moves
- retires and replaces sessions that stall or return as bare Herdr resumes
- appends due `aggregate.deadline.reached` events
- refreshes the heartbeat only while the gateway session is healthy
- spawns a successor directly through Herdr when the session disappears

Successor creation is Herdr-native. It does not use the wake registry. The target is the stable pane label `📨 gateway loop`. The driver launcher sets the successor command to the `cswap run` launch command shown above.

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

The gateway pane lives in Herdr's `default` session. Check the target session,
not bare Herdr commands:

```bash
launchctl print user/$(id -u)/com.joelclaw.agent-comms-driver
herdr --session default pane list
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

## Move automation out of Herdr default

Historical. On 2026-09-28 the gateway itself moved back to `default` (see Claude login); other automation stays in `system`.

This is a single-owner cutover. Do not start the gateway in `system` while the
old gateway is live in `default`.

1. Install and verify `com.joelclaw.herdr-system-server`. Do not start a gateway yet.
2. Record `joelclaw wake list --format json` and the legacy `pane:beats:lanes` hash.
3. Stop the host system-bus worker. Let any working beat lane settle.
4. Boot out `user/$(id -u)/com.joelclaw.agent-comms-driver`. Verify no driver process remains.
5. Close the old gateway with `herdr --session default pane close <verified-pane-id>`.
6. Verify no gateway pane exists in `default`, `observer`, or `system`.
7. Install the corrected driver launcher and bootstrap exactly one driver LaunchAgent.
8. Verify one canonical `📨 gateway loop` pane exists only in `system`.
9. Restart the host system-bus worker. Do not copy old pane IDs into `pane:beats:lanes:system`.
10. Prove one scheduled SPAWN and one gateway decision before closing old automation panes.

Pending schedules stay in `pane:schedules:pending`. A stopped worker does not delete
them. The reconciler fires overdue schedules after the worker returns.

## Start the driver

The production target is the stable pane label in Herdr's `default` session. The supervised LaunchAgent runs the launcher, which refuses to start without `GATEWAY_CLAUDE_ACCOUNT`. The successor brief remains required by the package interface, even though successor spawning is now Herdr-native.

```bash
GATEWAY_CLAUDE_ACCOUNT='<dedicated cswap slot>' infra/agent-comms-driver-daemon.sh
```

Optional defaults:

- `GATEWAY_HERDR_SESSION=default` (launcher; the package default is `system`)
- `GATEWAY_HEARTBEAT_KEY=gateway:agent:heartbeat`
- `GATEWAY_HEARTBEAT_REFRESH_MS=15000`
- `GATEWAY_HEARTBEAT_TTL_MS=60000`
- `GATEWAY_POKE_DEADLINE_MS=120000`
- `GATEWAY_SUCCESSOR_DEADLINE_MS=120000`
- `GATEWAY_DRIVER_RECEIPT_PATH=/tmp/joelclaw/agent-comms-driver.jsonl`
- `GATEWAY_DEADLINE_LOOKBACK_MS=259200000` (72 hours). A cold start replays only this much stream history into the backstop deadline index. The gateway's `wake_schedule_aggregate_deadline` timer is the primary deadline path. Replaying the full stream once took hours and kept the driver from spawning a gateway.

Do not point scratch tests at the production pane or heartbeat key. Tests must use a `test:*` key.

## Kill drill

The kill drill proves the real fallback. It closes the real gateway pane and sends a real message to Joel. Run it only as a supervised operation.

```bash
GATEWAY_AGENT_TARGET='📨 gateway loop' \
GATEWAY_HERDR_SESSION='default' \
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

Rollback is scripted. It boots out the supervised driver and scopes pane closure
to the named Herdr session. First, record the live gateway pane ID. Then run:

```bash
PANE_ID='<verified gateway pane id>'
BACKUP="$HOME/.joelclaw/scripts/gateway-start.sh.pre-cutover"

test -f "$BACKUP" || { echo "missing rollback backup: $BACKUP" >&2; exit 1; }
herdr --session default pane get "$PANE_ID" >/dev/null
scripts/gateway-cutover-rollback.sh "$PANE_ID"
```

The script stops the supervised driver, closes and verifies the gateway pane,
restores the pre-cutover start script, restarts the gateway daemon, and sends a probe.

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
