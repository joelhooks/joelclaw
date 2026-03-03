# Gateway Operations & Monitoring

Canonical notes for the always-on gateway daemon (`packages/gateway`) and its automated health checks.

## Extension scope (context-local only)

The `gateway` pi extension is now **context-local**, not global:

- Canonical source: `pi/extensions/gateway/index.ts` (repo-tracked)
- Active install path: `~/.joelclaw/gateway/.pi/extensions/gateway` (symlink to canonical source)
- Global path `~/.pi/agent/extensions/gateway` must stay absent

Daemon startup now enforces this invariant:

- missing local extension → startup fails
- global gateway extension present → startup fails

This prevents non-gateway pi sessions from loading gateway automation hooks.

## Manual CLI checks

```bash
joelclaw gateway status
joelclaw gateway diagnose --hours 1 --lines 120
joelclaw gateway test
joelclaw gateway events
joelclaw gateway restart
joelclaw gateway enable
joelclaw gateway known-issues
joelclaw gateway mute imessage --reason "imsg-rpc reconnect instability"
joelclaw gateway unmute imessage
```

Use `diagnose` first; it runs process/Redis/log/e2e/model checks in one pass.

Restart race hardening: daemon shutdown now removes PID/WS/session files only when the file still belongs to that process. This prevents old-process cleanup from deleting newly written marker files during fast restarts.

Gateway process diagnostics now use exact launchd state inspection (`launchctl print-disabled` + `launchctl print gui/<uid>/com.joel.gateway`) so disabled launch agents are reported explicitly. `joelclaw gateway restart` now re-enables `com.joel.gateway` before bootstrap/kickstart, so a disabled service can recover via the normal restart command.

`joelclaw gateway enable` is a direct launch-agent recovery command: enable service, bootstrap plist, kickstart daemon, then report pid/state.

Watchdog hardening: when a turn is stuck for >10 minutes, the daemon now aborts once and starts a recovery grace timer (90s). If no recovery signal (`turn_end` or next prompt dispatch) arrives before the deadline, the daemon self-restarts via launchd. This prevents the "process alive but session wedged" state where queues stop draining indefinitely.

Stuck detection now only runs while the queue is actively waiting for `turn_end` (`idleWaiter` pending). If the idle waiter itself times out (5 minutes safety valve), the daemon emits `daemon.watchdog:watchdog.idle_waiter.timeout`, releases the drain lock, marks the turn as ended, and clears pending stuck-recovery state. This prevents stale prompt markers from causing repeated false `watchdog.session_stuck` restart loops.

Prompt dispatch tracking now starts **after** `session.prompt()` successfully accepts the prompt (instead of before the call). This prevents immediate auth/model rejection failures from being misclassified as "stuck turn" incidents.

Fallback standardization guard: gateway fallback is now `openai-codex/gpt-5.3-codex`. If Redis still has legacy Anthropic fallbacks (`claude-sonnet-4-6` or `claude-sonnet-4-5`), daemon startup remaps to codex and emits `daemon.fallback:fallback.model.remapped`.

No-op fallback guard: if primary and fallback resolve to the same model ID/provider, fallback swapping is disabled for that session (no `swapped`/`primary_restored` churn). The daemon emits `daemon.fallback:fallback.disabled.same_model` once at startup so operators can spot misconfiguration without alert spam.

Model-failure ping guard: queue-level model failures (auth, missing API key, rate-limit/overload, model-not-found, network unavailable) now send an immediate operator alert to the default channel (Telegram currently). Generic failures also alert when consecutive prompt failures reach 3. Alerts are cooldown-limited per reason/source (2 minutes) and emit OTEL events under `daemon.alerting` (`model_failure.alert.sent|suppressed|failed`).

## Pi-session Langfuse guardrails (alert-only)

The `pi/extensions/langfuse-cost` extension now tracks per-session LLM call count, token totals, and cumulative cost (when usage payloads include cost fields).

- Guardrails emit `console.warn(...)` on first breach per threshold type.
- Guardrails are **alert-only**: no auto-stop, no auto-downgrade, no forced compaction.

Tune thresholds with environment variables on the gateway process:

- `JOELCLAW_LANGFUSE_ALERT_MAX_LLM_CALLS` (default `120`)
- `JOELCLAW_LANGFUSE_ALERT_MAX_TOTAL_TOKENS` (default `1200000`)
- `JOELCLAW_LANGFUSE_ALERT_MAX_COST_USD` (default `20`)

Restart the gateway after changing threshold env vars.

## Gateway operator steering cadence

The gateway role prompt (`roles/gateway.md`) requires proactive steering check-ins during active work:

- one short check-in at start
- another every ~60–120 seconds while work is still active
- never more than 2 autonomous actions in a row without a check-in
- immediate check-in on state changes (delegated, blocked, recovered, done)
- if behavior looks frenzy/noisy, stop and request steering before continuing

Keep updates concise for mobile Telegram reading.

## Availability-first posture (ADR-0189 related)

Gateway operation is orchestration-first, not execution-first:

- stay highly available and interruptible
- avoid heads-down implementation/research in the gateway session
- delegate heavy work immediately, then monitor + report progress
- keep check-ins frequent while delegated tasks are running
- include/suggest required skills in delegation prompts for domain work

If the gateway starts doing long solo work, that is a role failure and should be corrected immediately.

## Message-class triage and operator routing (ADR-0189 related)

Gateway handles two distinct inbound classes:

1. **User/operator messages** (Joel direct chat)
2. **System/automation messages** (`## 🔔`, `## 📋`, `## ❌`, `## ⚠️`, `## VIP`)

Routing rule:

- do **not** forward all system traffic to operator
- escalate to operator only for high-signal/action-required states (blocked flows, repeated unresolved failures, security/safety concerns, or explicit decision points)
- low-signal/transient system chatter is triaged/logged/monitored without operator interruption

This keeps operator channel high signal while preserving autonomous handling.

## Role resolution (gateway/system/interactive)

Gateway sessions run with `GATEWAY_ROLE=central`. System sessions can set `JOELCLAW_ROLE=system` (or another role alias). The `identity-inject` extension resolves the role file in this order:

1. `JOELCLAW_ROLE_FILE` env override (explicit path)
2. `JOELCLAW_ROLE` alias (maps `system` → `~/.joelclaw/roles/system.md`, `<name>` → `~/.joelclaw/roles/<name>.md`)
3. `~/.joelclaw/roles/gateway.md` when `GATEWAY_ROLE=central`
4. fallback to `~/.joelclaw/ROLE.md`

If the selected role file is missing, it falls back to `ROLE.md`.

Identity files are reloaded on each `session_start`, so role changes apply on the next session without requiring a process restart.

Startup logs include `rolePath=...` in the `[identity-inject]` line so role selection is explicit.

## Telegram reply routing guard

The daemon now uses a three-layer source resolution strategy for `message_end` routing:

1. active queue source (`getActiveSource()`)
2. source captured during `message_start`/text deltas
3. **recent prompt source recovery** (30s window, channel-like sources only)

This protects against late assistant segments that arrive after the active source is cleared (observed once at `daemon.response.source_fallback_console`).

- goal: prevent accidental `source: "console"` fallback for Telegram-origin turns
- impact: avoids short trailing replies being dropped by console-channel suppression rules
- telemetry:
  - `daemon.response.source_recovered_recent_prompt` (info) when recovery path is used
  - `daemon.response.source_fallback_console` (warn) only when a recent channel-origin prompt exists but routing still collapses to console
  - `daemon.response.source_console_no_context` (info) for expected startup/background console turns (observable but non-paging)

## Background turn attribution telemetry

To diagnose unsolicited/autonomous user-facing turns without behavior gating, gateway now emits attribution telemetry across classification → dispatch → response → console forwarding:

- `redis-channel:events.triaged` (debug)
  - counts + per-bucket reason counters (`immediate|batched|suppressed`)
  - per-bucket event type counts (`immediateTypes`, `batchedTypes`, `suppressedTypes`)
- `redis-channel:events.dispatched` (info)
  - `source`, `sourceKind`, `originSession`, `eventTypes`, `backgroundOnly`
- `redis-channel:events.dispatched.background_only` (debug)
  - emitted when a dispatch has no human/interactive event in the actionable set
- `daemon.response:response.generated` (debug)
  - source attribution at response synthesis time (`hasActiveSource`, `hasCapturedSource`, recent prompt age)
- `daemon.response:response.generated.background_source` (debug)
  - response source resolved to internal/background (`gateway|console`)
- `daemon.outbound:outbound.console_forward.*`
  - `...skipped` (reasons: `no-telegram-config`, `source-is-telegram`, `filtered-by-forward-rule`)
  - `...suppressed_policy` (reason: `background-internal-no-source-context`)
  - `...attempt`, `...sent`, `...failed`

Quick queries:

```bash
joelclaw otel search "events.dispatched.background_only" --hours 24
joelclaw otel search "response.generated.background_source" --hours 24
joelclaw otel search "outbound.console_forward" --hours 24
```

Runtime suppression guard (minimal behavior gate):

- console→Telegram forwarding is now suppressed when response attribution shows all of:
  - `sourceKind=internal`
  - `backgroundSource=true`
  - `hasActiveSource=false`
  - `hasCapturedSource=false`
  - `recoveredFromRecentPrompt=false`
- suppression is OTEL-visible via `daemon.outbound:outbound.console_forward.suppressed_policy`
- this guard only affects unsolicited background-origin console forwards; explicit channel replies and recovered recent-prompt replies still route normally

## Turn-level knowledge writes (ADR-0202)

Gateway turn-end flow now emits a default-on `knowledge/turn.write.requested` event for every turn:

- meaningful turn → captures `summary/decision/evidence/usefulnessTags`
- non-meaningful turn → sends explicit `skipReason`:
  - `routine-heartbeat`
  - `duplicate-signal`
  - `no-new-information`

Gateway emits eligibility OTEL (`knowledge.turn_write.eligible`) before dispatch so compliance can detect drift when write dispatch fails.

## Interrupt controls by channel

Telegram chat (`@JoelClawPandaBot`):

- `/stop` — aborts the active turn without killing the gateway daemon.
- `/esc` — alias for `/stop`.

iMessage chat (plain text):

- `stop` or `/stop` — aborts the active turn.
- `esc` or `/esc` — alias for stop.

Emergency-only manual control (Telegram only):

- `/kill` — hard stop: disables launchd service and kills the daemon process.

`/kill` is intentionally destructive. Use stop/esc first.

## Automated monitoring

Heartbeat fan-out now includes:

- event: `gateway/health.check.requested`
- function: `check/gateway-health`
- source file: `packages/system-bus/src/inngest/functions/check-gateway-health.ts`

### What it checks

1. **General gateway health (critical layers)** via `joelclaw gateway diagnose`
   - `process`
   - `cli-status`
   - `e2e-test`
   - `redis-state`

2. **Channel-specific degradation** from OTEL events in `otel_events`
   - `telegram-channel`
   - `discord-channel`
   - `imessage-channel`
   - `slack-channel`

### Automated behavior

- Tracks per-incident streaks in Redis (noise suppression)
- Auto-restarts gateway on sustained general failure (cooldown-protected)
- Alerts on sustained unresolved failure/degradation
- Supports muted channel known-issues list; muted channels are still probed + logged, but excluded from channel alert notifications
- Emits OTEL event:
  - component: `check-gateway-health`
  - action: `gateway.health.checked`

## Redis keys used by monitor

- `gateway:health:monitor:general-streak`
- `gateway:health:monitor:general-alert-cooldown`
- `gateway:health:monitor:restart-cooldown`
- `gateway:health:monitor:channel-streak:<channel>`
- `gateway:health:monitor:channel-alert-cooldown`
- `gateway:health:muted-channels` (JSON array of channel IDs)
- `gateway:health:mute-reasons` (JSON object mapping channel → reason)

## Related files

- `packages/system-bus/src/inngest/functions/heartbeat.ts`
- `packages/system-bus/src/inngest/functions/check-gateway-health.ts`
- `packages/cli/src/commands/gateway.ts`
- `packages/gateway/src/daemon.ts`
- `skills/gateway-diagnose/SKILL.md`
