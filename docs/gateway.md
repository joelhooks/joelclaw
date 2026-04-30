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

## Thread-oriented demand context (ADR-0237)

Demand-driven context gathering in `pi/extensions/gateway/index.ts` now prefers `conversation_threads` over flat `slack_messages` / `email_threads` snippets.

Current operator-facing priorities are:

- **project momentum** — recent threads already linked to active projects
- **relationship threads** — important people, email threads, and anything explicitly waiting on Joel
- **momentum risks** — vault gaps or `needs_joel` threads that imply dropped balls, missing capture, or stalled progress

Contract:

- query `conversation_threads` first
- keep `slack_messages` + `email_threads` only as warm-up fallback while the new collection backfills
- format summaries for actionability, not transcript archaeology
- only inject these sections for real operator turns, preserving ADR-0235's silent accumulation model

## Gateway context refresh scoping (2026-03-09)

ADR-0204 rolling context refresh in `pi/extensions/gateway/index.ts` must stay scoped to **real conversational topics**, not automated gateway envelopes.

Observed failure mode:
- hidden `context-refresh` custom messages injected unrelated memory into the live gateway session
- session transcripts showed garbage from unrelated voice/livekit work inside the gateway session
- root cause was the refresh path harvesting topic seeds from automated digests (`## 📋 Batch Digest`, `## 🔔 Gateway`, `> ⚡ Automated gateway event`, recovery messages, terse `Noted.` replies) and then running broad global recall queries

Current contract:
- only seed `gwRecentTopics` from non-automated message content
- skip terse acknowledgements and gateway-generated recovery/context blocks
- if there is no scoped topic seed, skip rolling recall instead of querying generic global memory
- compaction recovery may reuse cached scoped recall, but must not invent fresh generic recall context
- boot-time `memory-enforcer` retrieval for the gateway session must also use a gateway-scoped recall query (`gateway daemon telegram redis session routing compaction`) instead of the generic interactive recall query
- hidden startup recall should filter obvious meta-junk (`## Plan Summary`, "Should I:", etc.) so the gateway does not inject procedural transcript sludge as memory

This is a safety fix: better to inject no extra memory than poison the gateway session with unrelated context.

## Embedded pi dependency skew + prompt-budget guard (2026-03-09)

Two real gateway failures were fixed together:

1. **Embedded pi deps were stale inside `packages/gateway/`**
   - The gateway package was still pinned to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.52.12`.
   - `pi --version` on the machine can say `0.57.x` and still not reflect what the gateway daemon imports at runtime.
   - Symptom: fallback recovery probes spam `model_fallback.probe_failed` with `pi model not found: openai-codex/gpt-5.4` even though upstream pi already supports GPT-5.4.
   - Fix: keep `packages/gateway/package.json` aligned with the actual pi-mono model catalog when gateway model/fallback policy changes.
   - Guardrail: if the active primary model already equals the configured fallback, the daemon now remaps fallback to a distinct compatible model instead of silently running with a no-op fallback.

2. **Prompt budget now gets checked before dispatch, not only after provider rejection**
   - The command queue now runs a pre-dispatch maintenance hook before `session.prompt()`.
   - If the projected prompt budget would land near the model ceiling, the gateway compacts first.
   - If the session age already crossed the rotation limit or the projected prompt would still be too close to the ceiling, the gateway rotates to a fresh session first and seeds it with the compression summary.
   - This is meant to stop repeated `prompt is too long` poison-loop failures before the provider has to say it.

3. **Resumed sessions can carry stale model state across daemon restarts**
   - Redis config is the operator contract, but a resumed pi session can still come back on the last fallback/manual model if startup does not explicitly reconcile it.
   - Symptom: gateway looks healthy but keeps behaving like the wrong model, fallback decisions stop matching Redis config, and session-pressure context windows can be computed against stale/default values.
   - Fix: daemon startup now reconciles the resumed session back to the requested primary model before fallback control initializes, and context-window checks resolve from the active model registry when the live session object omits that field.

Operator note: when diagnosing fallback weirdness, check both the machine `pi --version` **and** the versions pinned in `packages/gateway/package.json`. If those drift, the daemon can lie about model availability. Also compare Redis gateway config to the actual live session model after restart — a resumed session can otherwise preserve stale model state and make the daemon look sane while running the wrong thing.

## Redis-degraded mode (ADR-0214, 2026-03-06)

Gateway runtime now distinguishes **availability** from **Redis health**.

`joelclaw gateway status` reports:

- `mode: normal` — Redis bridge healthy
- `mode: redis_degraded` — daemon/session/channels still available, but Redis-backed capabilities are degraded

In `redis_degraded` mode:

- direct channel conversation stays online
- `gateway status` falls back to daemon health instead of pretending the gateway is dead
- `gateway diagnose` marks the Redis bridge as degraded and skips Redis-dependent E2E testing
- degraded capabilities are listed explicitly (event bridge, replay, Redis-backed operational commands, Telegram poll-owner lease durability)

Session pressure is now surfaced in status payloads as first-class data:

- context usage %
- queue depth
- last compaction age
- session age
- next action (`observe` / `compact` / `rotate`)
- next threshold summary (`compact at 65% ...` / `rotate at 75% ...` / `rotate immediately`)
- thread counts (`active` / `warm` / `total`)
- fallback state + activation count + consecutive prompt failures
- pressure signals (`context_usage`, `context_ceiling`, `compaction_gap`, `session_age`)
- alert state (`lastNotifiedHealth`, `lastNotifiedAt`, cooldown)

`joelclaw gateway diagnose` now includes a dedicated `session-pressure` layer instead of burying pressure state inside generic status findings.

The daemon emits OTEL under `daemon.session-pressure` (`session_pressure.alert.suppressed|failed`). Session-pressure states do **not** page Telegram; rotation/compaction pressure stays in status/diagnose/OTEL because it is gateway maintenance, not Joel action.

Idle maintenance is now autonomous for time-based pressure too:

- watchdog evaluates session pressure even when no turn is active
- if the idle session crosses `compaction_gap`, the daemon runs compaction without waiting for another message
- if the idle session crosses `session_age` and rotation is the next action, the daemon rotates to a fresh session with the compression summary before the next inbound turn arrives
- those idle maintenance runs emit the same `daemon.maintenance.started|completed|failed` lifecycle telemetry with `source: watchdog`

Operator rule: if status says `redis_degraded`, do **not** treat that as a full gateway outage. Diagnose substrate/Redis separately while using direct conversation paths if needed.

## Interruptibility and supersession (ADR-0196 / ADR-0218 rank 4)

Latest direct human turns now win by contract across Telegram, Discord, iMessage, and Slack invoke paths.

Current runtime contract:

- direct human turns get a short `1.5s` batching window before dispatch so rapid follow-ups land as one prompt
- batching is keyed per source (`telegram:<chat>`, `discord:<thread|dm>`, `imessage:<chat>`, `slack:<channel[:thread]>`)
- if the source is already active, the gateway does **not** wait on the batch timer — it supersedes immediately
- queued stale prompts for that source are dropped
- durable queue replay must not self-drop the freshest human message; only genuinely newer same-source messages may supersede it
- the daemon requests `session.abort()` on the stale active turn
- stale response output is suppressed instead of being delivered after the newer ask
- Telegram, Discord, Slack, and iMessage get a short supersession acknowledgement when possible
- passive intel / background event routes are excluded from the human batching path

`joelclaw gateway status` now exposes `supersession` with both latest-wins state and `batching` state:

- `activeRequest` / `lastEvent` — supersession details for the stale active turn
- `batching.windowMs` — current batch window
- `batching.pendingCount` / `batching.pendingSources` — human sources currently being held before dispatch
- `batching.lastFlush` — most recent batched flush source/time/message count

`joelclaw gateway diagnose` adds an `interruptibility` layer that shows whether a supersession is active plus current/last batching details.

Current boundary of the slice:

- shipped: cross-channel human latest-wins supersession + batching window + stale-response suppression
- still open: richer interruptibility coverage for non-message operator actions

## Operator ack/timeout tracing (ADR-0218 rank 5)

Telegram operator actions now get trace ids and an explicit lifecycle instead of blind button toasts or silent slash-command hangs.

Current runtime slice covers:

- command-menu callbacks (`cmd:*`)
- worktree callbacks (`worktree:*`)
- ADR pitch callbacks (`pitch:*`)
- default Telegram callback actions and external callback-route handoffs
- direct Telegram slash commands registered through the command handler
- native Telegram `/stop`, `/esc`, and `/kill` operator commands

For those paths, the gateway now tracks:

- `traceId`
- `kind` (`callback` / `command`)
- ack state (`pending` / `succeeded` / `failed`)
- dispatch/completion/failure timestamps
- timeout state (`15s` default, longer for downstream agent/external callback paths)
- route + chat/message metadata

Operator surfaces:

- `joelclaw gateway status` exposes canonical `operatorTracing`
- `callbackTracing` remains as a compatibility alias for the same snapshot
- `joelclaw gateway diagnose` adds an `operator-tracing` layer
- timeout/failure paths send an explicit Telegram follow-up with route + trace id instead of silently relying on spinners or missing command replies

Current deeper rank-5 slice now also carries queued Telegram agent-command trace ids through downstream gateway execution:

- queued `/command` and `cmd:*` agent executions keep the same trace id through queue dispatch
- traces complete on downstream turn completion instead of lying at enqueue time
- prompt failure, assistant error, and supersession paths fail the trace explicitly
- agent-backed command traces use a longer timeout window (`120s`) because downstream execution is real work, not just callback ack latency

External callback-route consumers now also have a real completion handoff path:

- routed external callbacks stay active after the gateway publishes them instead of being marked complete immediately
- the gateway advertises a Redis trace-result channel with the routed callback payload
- downstream consumers can publish `completed` / `failed` back with the same `traceId`
- the in-tree Restate Telegram route now uses that handoff, so external callback traces close on real downstream resolution instead of publish-time fiction
- timeout stays terminal if the external consumer never reports back

Still open: any out-of-tree external callback consumer has to adopt the same trace-result handoff or it will still timeout as untracked work.

## Channel runtime contracts (ADR-0218 rank 6)

Gateway status now exposes a canonical `channels` surface so Telegram ownership semantics stop being a bespoke one-off.

Current runtime slice exposes per-channel runtime snapshots for:

- `telegram` — configured/started/healthy, owner state, polling state, retry attempts, conflict streak, last lease status
- `discord` — configured/started/healthy, ready state, bot user id
- `imessage` — configured/started/healthy, connected state, reconnect attempts/delay, healing state
- `slack` — configured/started/healthy, connected state, bot/allowed user ids

Operator surfaces:

- `joelclaw gateway status` exposes raw `channels` plus summarized `channelHealth`
- `channelHealth` carries degraded/muted channel lists plus last degrade/recover event and per-channel transition timestamps
- `joelclaw gateway diagnose` adds a `channel-health` layer with current contract state, muted known issues, and last alert event
- `/health` components now reflect per-channel contract state instead of just a Telegram boolean
- Telegram `fallback` with `leaseEnabled=false` is expected local mode, not a degraded owner contract

Daemon behavior now includes immediate channel-health transition handling:

- detect configured channel `healthy ↔ degraded` transitions
- emit OTEL under `daemon.channel-health` (`channel_health.state.changed`, `channel_health.alert.sent|suppressed|failed`)
- send direct Telegram degrade/recover alerts unless that channel is muted as a known issue
- reuse the same known-issues keys as the autonomous monitor (`gateway:health:muted-channels`, `gateway:health:mute-reasons`)

The deeper rank-6 slice now adds active heal policy state:

- each channel carries `healPolicy` (`restart` / `manual` / `none`) and `healReason`
- `channelHealth.healing` exposes degraded streak count, cooldown, attempts, last heal result, plus `manualRepairRequired`, `manualRepairSummary`, and `manualRepairCommands` when the watchdog cannot fix the channel itself
- `joelclaw gateway diagnose` adds a `channel-healing` layer and now spells out manual repair steps instead of vague `armed` wording
- watchdog attempts guarded restarts for restart-eligible degraded channels after `2` consecutive degraded checks with a `10m` cooldown
- ownership/lease problems (for example Telegram passive poll ownership or retrying `getUpdates` conflicts) stay visible as `manual` instead of triggering dumb restart churn
- degraded channels that are muted as known issues now also flip to `manual` instead of quietly advertising a restart policy that the watchdog will never actually execute while muted
- Telegram retry/conflict states no longer read as healthy local fallback: `/health`, `gateway status`, and `gateway diagnose` now degrade the contract when polling is down and only retrying

Current boundary of this rank-6 slice:

- shipped: reusable channel runtime health/ownership snapshots, immediate degrade/recover alerting with known-issue suppression, guarded per-channel heal policy state with restart attempts for restart-eligible channels, and explicit manual repair guidance for manual-policy degradations
- still open: stricter single-owner semantics beyond Telegram and any richer/native repair automation beyond CLI-guided operator steps

## Telegram multi-instance polling ownership (2026-03-05)

Gateway Telegram ingress now uses a Redis lease so multiple gateway instances can coexist without all trying to long-poll the same bot token.

- Poll owner lease key: `joelclaw:gateway:telegram:poll-owner:<tokenHash>`
- Only the lease owner starts `getUpdates` polling.
- Non-owners stay in passive/send-only mode and retry lease acquisition with backoff.
- Lease owner renews periodically; on lease loss it stops polling and re-enters passive mode.
- Poll status key: `joelclaw:gateway:telegram:poll-status:<tokenHash>` (owner/passive/fallback/stopped snapshots)

Telemetry:
- `telegram.channel.poll_owner.acquired`
- `telegram.channel.poll_owner.passive`
- `telegram.channel.poll_owner.retry_scheduled`
- `telegram.channel.poll_owner.lost`
- `telegram.channel.poll_owner.fallback`

Conflict guard remains in place:
- If Bot API returns `409: Conflict: terminated by other getUpdates request`, gateway retries with exponential backoff (`telegram.channel.retry_scheduled`) instead of one-shot disable.
- `telegram.channel.start_failed` carries retry metadata (`attempt`, `retryDelayMs`, `conflict`, `pollLeaseOwned`).
- Recovery after transient conflicts emits `telegram.channel.polling_recovered`.

Important: Telegram phone/desktop clients are **not** Bot API pollers. `getUpdates` contention only happens between bot processes using the same token.

## Redis reconnect hardening (2026-03-05)

Gateway lockups during Redis link flaps were caused by `MaxRetriesPerRequestError` storms from ioredis command clients. Hardening now in place:

- Redis channel clients use `maxRetriesPerRequest: null` to avoid command-queue flush storms during reconnect churn.
- Gateway mode reads/writes fail open (`active`) with warn-level OTEL (`mode.read.failed`, `mode.write.failed`) instead of throwing.
- Heartbeat interval wraps `tickHeartbeat()` in a local try/catch so transient Redis failures cannot leak as unhandled promise rejections.
- Duplicate daemon-level `unhandledRejection` handlers were collapsed to one. It now suppresses known TUI-only noise (`Theme not initialized`) and rate-limits repeated Redis max-retry rejections into `daemon.redis.max_retries_rejection` telemetry.

Result: Redis transport blips may degrade event throughput briefly, but should no longer wedge the process or spam unbounded unhandled-rejection logs.

## Behavior control plane (ADR-0211)

Gateway behavior preservation is now deterministic and operator-controlled.

### Control lane (runtime-authoritative)

```bash
joelclaw gateway behavior add --type keep|more|less|stop|start --text "..."
joelclaw gateway behavior list
joelclaw gateway behavior remove --id <directive-id>
joelclaw gateway behavior apply
joelclaw gateway behavior stats
```

- Active contract is stored in Redis (`joelclaw:gateway:behavior:contract`).
- Runtime injection reads Redis on each turn and injects:

```text
<GATEWAY_BEHAVIOR_CONTRACT version="..." hash="...">
- KEEP: ...
- LESS: ...
</GATEWAY_BEHAVIOR_CONTRACT>
```

- Injection placement is deterministic: before `# Role` in prompt assembly (below identity, above role).
- Injection telemetry emits `behavior.contract.injected` with `behavior_contract_hash`.

### Capture lane (extension -> CLI only)

Gateway extension passively scans operator prompts for:

- `KEEP: ...`
- `MORE: ...`
- `LESS: ...`
- `STOP: ...`
- `START: ...`

On match it shells to `joelclaw gateway behavior add ...`.
It does **not** write Redis/Typesense directly.

### Learning lane (advisory only)

A daily Inngest cron (`gateway/behavior.daily-review`) analyzes last 24h gateway sessions + OTEL and writes `good_patterns` / `bad_patterns` candidates to Typesense (`gateway_behavior_history`, `kind=candidate`, `status=pending`).

- No auto-activation.
- Operators must promote manually: `joelclaw gateway behavior promote --id <candidate-id>`.
- Stale pending candidates expire automatically via TTL governance.

### Slack passive firehose prerequisites

The launchd start script now derives Slack routing env vars at boot from existing Slack secrets:

- `slack_user_token` → `auth.test` → `SLACK_ALLOWED_USER_ID`
- `slack_bot_token` + resolved user ID → `conversations.open` → `SLACK_DEFAULT_CHANNEL_ID`

This removes dependency on non-existent `slack_allowed_user_id` / `slack_default_channel_id` secrets and restores passive firehose routing after restarts.

Joel-authored non-mention Slack channel messages now enter the canonical gateway signal pipeline as Redis events (`slack.signal.received`) instead of freelancing a direct gateway turn. That means Slack passive intel and email now share the same relay heuristics:

- normalize into one signal shape
- score with explicit rules (VIP sender, Joel signal, action/decision keywords, project cues, low-signal/noise patterns)
- correlate by project/contact/conversation keys
- route as `immediate`, `batched`, or `suppressed`

Canonical implementation lives in `packages/gateway/src/operator-relay.ts`.

Current contract:
- `vip.email.received` is ingested by relay policy so the gateway keeps correlation context without announcing a duplicate operator alert after the VIP pipeline delivers the richer brief directly to Telegram
- raw `front.message.received` no longer pages by default; it pages only for production/security/money failures or a human/project direct ask
- lower-signal project/person email and passive Slack intel batch into correlated signal digests instead of paging immediately
- obvious email noise (`newsletter`, `unsubscribe`, shopping/restock/cart, bot review-in-progress, weekly summaries) is suppressed before it reaches the gateway session
- meta-system chatter (`gateway.*`, session pressure, channel degradation, friction/check-gateway-health noise) is suppressed from Telegram; it remains available through status/diagnose/OTEL/logs
- low-signal `recovered` automation events are suppressed instead of paging Telegram just because a daemon became healthy again
- digest prompts must ask for an operator brief, not `HEARTBEAT_OK` sludge
- outbound operator relay strips leaked `HEARTBEAT_OK` prefixes from non-heartbeat content before Telegram delivery
- if Redis is unavailable, Joel-authored Slack passive intel falls back to direct enqueue rather than disappearing

### Slack important-channel intelligence

The Slack live listener still only invokes the gateway for Joel DMs, explicit bot mentions, and tracked mention threads. Important channels are different: they are **collected**, not auto-answered.

Configure selected channels with private runtime env vars:

- `SLACK_IMPORTANT_CHANNEL_IDS` — comma-separated Slack channel IDs; preferred because IDs survive renames
- `SLACK_IMPORTANT_CHANNEL_NAMES` — comma-separated names or `#names`; fallback for local/dev use

For messages in important channels:

1. every non-bot message is indexed through `channel/message.received` for `channel_messages` / `conversation_threads` context
2. every non-bot message is queued as `slack.signal.received` with `passiveIntel: true` and `importantChannel: true`
3. Joel-authored messages also carry `joelSignal: true`
4. relay policy batches normal important-channel chatter, escalates only when score crosses the immediate threshold, and suppresses low-signal noise
5. if Redis is unavailable, non-Joel important-channel messages stay index-only rather than directly invoking the gateway session

This gives the gateway working memory of important channels without turning Slack into an operator notification sewer pipe.

If either derivation fails, startup logs explicit warnings in `/tmp/joelclaw/gateway.log` so degraded Slack behavior is visible immediately.

Gateway now exposes `GET /health/slack` on port `3018` (same Bun server as the WS bridge). It returns:
- `200` when Slack channel is started
- `503` when Slack channel is not started

Talon dynamic services now probe this endpoint via `http.gateway_slack` in `~/.joelclaw/talon/services.toml` with `critical = true` and `critical_after_consecutive_failures = 3` (debounced alerting for brief reconnect churn).

Slack channel-name resolution now classifies `channel_not_found` as a permanent resolve error and applies long cooldown (`slack.channel.resolve_unavailable`) instead of spamming transient `resolve_failed` warnings.

Restart race hardening: daemon shutdown now removes PID/WS/session files only when the file still belongs to that process. This prevents old-process cleanup from deleting newly written marker files during fast restarts.

Gateway process diagnostics now use exact launchd state inspection (`launchctl print-disabled` + `launchctl print gui/<uid>/com.joel.gateway`) so disabled launch agents are reported explicitly. `joelclaw gateway restart` now re-enables `com.joel.gateway` before bootstrap/kickstart, so a disabled service can recover via the normal restart command.

`joelclaw gateway enable` is a direct launch-agent recovery command: enable service, bootstrap plist, kickstart daemon, then report pid/state.

## Outbound media payload support

`gateway/send.message` now supports optional media fields in addition to text/keyboard:

- `media_url` (remote URL)
- `media_path` (local file path)
- `mime_type` (routing hint, e.g. `image/png`, `video/mp4`, `audio/ogg`)
- `caption` (optional media caption)

Gateway daemon outbound drain now checks media payloads and calls `channel.sendMedia()` when available. Channels without `sendMedia()` fall back to text delivery with the media link/path. Telegram routes media by MIME type (`image/*` → photo, `video/*` → video, `audio/*` → audio/voice for `audio/ogg`, else document).

Watchdog hardening: when a turn is stuck for >10 minutes, the daemon now aborts once and starts a recovery grace timer (90s). If no recovery signal (`turn_end` or next prompt dispatch) arrives before the deadline, the daemon self-restarts via launchd. This prevents the "process alive but session wedged" state where queues stop draining indefinitely.

Stuck detection now only runs while the queue is actively waiting for `turn_end` (`idleWaiter` pending). If the idle waiter itself times out (5 minutes safety valve), the daemon emits `daemon.watchdog:watchdog.idle_waiter.timeout`, releases the drain lock, marks the turn as ended, and clears pending stuck-recovery state. This prevents stale prompt markers from causing repeated false `watchdog.session_stuck` restart loops.

Prompt dispatch tracking now starts **after** `session.prompt()` successfully accepts the prompt (instead of before the call). This prevents immediate auth/model rejection failures from being misclassified as "stuck turn" incidents.

Gateway primary standard: the gateway agent primary model is `openai-codex/gpt-5.5`. Startup env (`~/.joelclaw/scripts/gateway-start.sh`) sets `PI_MODEL_PROVIDER=openai-codex` and `PI_MODEL=gpt-5.5`; Redis config key `joelclaw:gateway:config` should store `model: "gpt-5.5"`. The inference-router catalog allows explicit GPT-5.5 gateway config while keeping older codex aliases on GPT-5.4 for non-gateway compatibility.

Fallback standardization guard: gateway fallback remains `openai-codex/gpt-5.4` so fallback is not identical to the GPT-5.5 primary. If Redis still has legacy Anthropic fallbacks (`claude-sonnet-4-6` or `claude-sonnet-4-5`), daemon startup remaps to codex and emits `daemon.fallback:fallback.model.remapped`.

Opus timeout floor guard: when the primary model is `claude-opus-4-6`, gateway config now floors `fallbackTimeoutMs` to `240000` even if Redis still says `120000`. ADR-0091 already recorded real Opus first-token latency beyond 120s, so 120s had become a stale SLA that caused avoidable fallback churn.

Aborted-turn monitor guard: `message_end` with no text (especially `stopReason: aborted`) now clears the fallback timeout watch immediately instead of waiting on a later `turn_end` that may never arrive. Without this, aborted turns could poison `_promptDispatchedAt` and make the next successful turn inherit absurd fake `prompt.latency` / fallback timing.

Fallback decision telemetry guard: fallback control now emits structured `model_fallback.decision` events alongside the coarse swap/probe actions. Activation reasons are bucketed (`timeout`, `consecutive_failures`, `rate_limit`, `provider_overloaded`, etc.), recovery probes record `probeCount`, and probe failures include `error_kind` plus `backoff_ms` so OTEL can tell the difference between a legitimately sick provider and a noisy control loop.

Fallback watchdog grace guard: when ADR-0091 fallback has just activated, the watchdog now gives the swapped model a short grace window before declaring the session dead on the same consecutive-failure counter. This stops auth/provider failures from triggering `fallback activated` and `watchdog.session_dead` in the same breath, which previously restarted the daemon before fallback could earn a successful turn.

Recovery probe backoff guard: when the primary model recovery probe fails for transient/persistent reasons, the gateway now backs off future probes instead of mindlessly retrying every interval. This borrows the OpenClaw pattern of “don’t keep probing the same sick provider in the same failure window” and cuts swap↔probe churn without disabling recovery entirely.

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

Runtime dependency note: `pi/extensions/langfuse-cost` resolves the optional `langfuse` package from the repo root, not from a workspace package. If root install drift drops `langfuse` from `package.json` / `node_modules`, the gateway will log `langfuse-cost: cannot load optional dependency 'langfuse'; telemetry disabled.` until the root dependency is restored.

Secret fallback note: shared joelclaw Langfuse loaders now shell to `secrets lease --json` and only accept `result.value`. This is deliberate — when the agent-secrets daemon is down, `secrets lease` prints an `ok:false` JSON error envelope to stdout **and still exits 0**. Raw stdout must never be trusted as `LANGFUSE_HOST` / `LANGFUSE_BASE_URL` or credential material.

## Gateway operator steering cadence

The gateway role prompt (`roles/gateway.md`) requires proactive steering check-ins during active work:

- one short check-in at start
- another every ~60–120 seconds while work is still active
- never more than 2 autonomous actions in a row without a check-in
- immediate check-in on state changes (delegated, blocked, recovered, done)
- if behavior looks frenzy/noisy, stop and request steering before continuing

Keep updates concise for mobile Telegram reading.

## Runtime guardrail enforcement (ADR-0189, 2026-03-06)

Prompt guidance is no longer the only line of defense.

Runtime guardrails now add two daemon-level tripwires:

1. **Tool-budget checkpoint tripwire**
   - channel turns get a budget of 2 tool actions before a forced status checkpoint
   - background/internal turns get a budget of 4 tool actions before a forced checkpoint
   - the daemon sends the checkpoint directly to Telegram and emits OTEL under `daemon.guardrails`
2. **Post-push deploy verification**
   - after a successful `git push` whose latest commit touched `apps/web/` or root config (`turbo.json`, `package.json`, `pnpm-lock.yaml`)
   - the daemon schedules `vercel ls --yes 2>&1 | head -10` after ~75 seconds
   - failures page the operator and emit `guardrail.deploy_verification.failed`

`joelclaw gateway status` exposes the live guardrail state under `guardrails`, including whether a checkpoint already fired this turn and any pending deploy verifications.

## Session lifecycle guards (ADR-0213)

Three guards prevent context bloat and overnight fallback thrash:

### Compaction circuit breaker (4h max gap)
After every `turn_end`, if >4 hours since last compaction, force `session.compact()` regardless of token count. Prevents the scenario where context grows unchecked when pi's auto-compaction misses (e.g. model_change entries disrupting threshold calculation).

### Session age limit (8h max)
After every `turn_end`, if session is >8 hours old, create a fresh session with compression summary. Prevents multi-day JSONL growth before fallback thrash starts. Session recycle is no longer an operator-facing Telegram notice by default; it stays in logs/OTEL/status unless a higher-signal failure path escalates it.

### Quiet hours auto-batching (11 PM – 7 AM PST)
During quiet hours, all non-interactive events are batched (not immediate). Batch digest flush is deferred until wake hours. Human messages (telegram, imessage, etc.) and error events always process immediately.

Additional low-signal guards now apply:
- `restate` / `restate/*` sources count as automation for batching, so successful queue-dispatch DAG completions do not hit the live gateway session immediately
- `test.gateway-e2e` is suppressed from operator delivery by default (internal probe, not a human-facing notification)
- `cron.heartbeat` events are excluded from operator signal digests entirely, even when mixed with real project signals, so digests stop growing junk `misc:cron.heartbeat` sections
- low-signal-only digests (for example heartbeat-only or queue-dispatch-complete-only batches) are dropped instead of prompting the model just to say `HEARTBEAT_OK`
- gateway heartbeat treats Talon reachability as advisory telemetry, not operator-facing degradation by itself; local gateway health still escalates, Talon-only misses stay in logs/OTEL
- fallback swap/recovery notices no longer page Telegram during quiet hours, and routine recovery notices are log/OTEL-only instead of operator spam
- direct operator-only `Knowledge Watchdog Alert` messages are suppressed during quiet hours so degraded turn-write accounting doesn’t page overnight unless some higher-signal path escalates it
- proactive compaction now has hysteresis: after a successful proactive compact, the gateway waits for either a 30m cooldown or a meaningful usage jump before compacting again
- fallback recovery now requires a minimum dwell on the fallback model before probing primary again, which prevents immediate swap→restore chatter when a recovery probe tick lands right on top of a fresh fallback activation
- maintenance windows (compact/rotate) are now first-class runtime state: the daemon emits `daemon.maintenance.started|completed|failed`, surfaces maintenance activity in gateway status, and watchdog/idle-wait logic treats active compaction/rotation as busy work instead of a dead turn
- idle waiter now uses bounded maintenance extensions: if compaction/rotation is genuinely in flight when the normal `turn_end` safety valve would fire, the drain lock extends in 60s slices up to a 15m aggregate ceiling before giving up

`subscription.updated` events are rendered as dedicated "📡 Feed Update" automated messages instead of being folded into batch digests, so feed changes stay visible even when digest-only pressure controls are active.

**Incident context (2026-03-05):** Without these guards, the gateway entered a thrash loop: 92 fallback activations, 83 timeouts, 128 model swaps over 11 hours. Root cause: 12h without compaction → context bloat → Opus first-token > 120s → positive feedback loop.

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

## System-session relay packets

System sessions should treat the gateway as the operator relay, not as another mailbox.

- use `joelclaw notify send ...` for operator-facing progress, status, and reports
- use `joelclaw mail ...` for agent coordination, file reservations, and handoffs
- relay packets from `system` sessions should include: session handle (when present), current objective, touched surfaces, interesting memory/slog references, desired improvements, blockers, and next move
- gateway applies ADR-0189 routing policy before anything reaches Joel; low-signal packets may be summarized or suppressed

This keeps the transport split clean: mail for agents, notify for operator relay.

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
- Auto-restarts gateway on sustained **restart-eligible** general failures (`process`, `cli-status`, `redis-state`) with cooldown protection
- `e2e-test` failures still mark health degraded and alert, but no longer trigger auto-restart by themselves
- Alerts on sustained unresolved failure/degradation
- Supports muted channel known-issues list; muted channels are still probed + logged, excluded from autonomous monitor channel alert notifications, and also suppress the daemon's immediate rank-6 degrade/recover Telegram alerts
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
