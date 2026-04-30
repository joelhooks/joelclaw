---
name: gateway
displayName: Gateway
description: "Operate the joelclaw gateway daemon — the always-on pi session that receives events, notifications, and messages. Use the joelclaw CLI for ALL gateway operations. Use when: 'restart gateway', 'gateway status', 'is gateway healthy', 'push to gateway', 'gateway not responding', 'telegram not working', 'messages not going through', 'gateway stuck', 'gateway debug', 'check gateway', 'drain queue', 'test gateway', 'stream events', or any task involving the gateway daemon."
version: 1.0.5
author: Joel Hooks
tags: [joelclaw, gateway, daemon, redis, telegram]
---

# Gateway Operations

The gateway daemon is the always-on pi session that receives events from Inngest functions, Telegram, and webhooks. It's the system's notification and communication layer.

**Rule: Always use `joelclaw gateway` CLI. Never use `launchctl`, `curl`, or log file grep directly.**

## CLI Commands

```bash
joelclaw gateway status    # Daemon availability, runtime mode, session pressure, Redis health
joelclaw gateway restart   # Roll daemon, clean Redis, fresh session
joelclaw gateway enable    # Re-enable launch agent + start daemon
joelclaw gateway test      # Push test event, verify delivery (Redis bridge path)
joelclaw gateway push --type <type> [--payload JSON]  # Push an event to all sessions
joelclaw gateway events    # Peek at pending events per session
joelclaw gateway drain     # Clear all event queues
joelclaw gateway stream    # NDJSON stream of all gateway events (ADR-0058)
joelclaw gateway behavior {add|list|promote|remove|apply|stats}  # ADR-0211 behavior control plane
```

`joelclaw gateway restart` is the canonical restart. It kills the process, cleans Redis state, re-enables `com.joel.gateway` if launchd disabled it, waits for launchd to respawn, and verifies the new session. `joelclaw gateway enable` is the direct recovery path when launchd drift disabled the service. Never use `launchctl bootout/bootstrap` directly.

## Quick Triage

Substrate precheck first (avoid chasing secondary gateway symptoms):

```bash
colima status --json
kubectl get nodes -o wide
kubectl get pods -n joelclaw redis-0 inngest-0
```

If Colima is down or node/core pods are not healthy, recover substrate before gateway operations.

Run in order, stop at first failure:

```bash
joelclaw gateway status    # 1. Is it alive? Sessions registered?
joelclaw gateway test      # 2. Can events flow end-to-end?
joelclaw gateway events    # 3. Are events piling up? (backpressure)
joelclaw gateway restart   # 4. If stuck, restart
```

If `joelclaw gateway status` shows pending > 0 on sessions, the agent is mid-stream or stuck. If it persists after a minute, restart.

## Redis-degraded mode (ADR-0214)

`joelclaw gateway status` now distinguishes:

- `mode: normal` — Redis bridge healthy
- `mode: redis_degraded` — daemon/channels/session available, but Redis-backed capabilities are degraded

When `mode=redis_degraded`:

- direct human conversation can still work
- Redis-backed commands/inspections are only partially trustworthy
- `joelclaw gateway test` validates the Redis bridge path, so expect `joelclaw gateway diagnose` to skip that layer intentionally
- use `joelclaw gateway diagnose` to see the degraded capability list and session pressure fields

Do not report `redis_degraded` as “gateway down” unless process/session health is also failing.

## Gateway context refresh scoping (ADR-0204)

Gateway rolling context refresh is useful only when it stays scoped.

Hard rule:
- do **not** treat automated digests, gateway event wrappers, recovery summaries, or terse acknowledgements as recall seeds
- if there is no real conversational topic, skip refresh rather than querying generic global memory

Why:
- a bad hidden `context-refresh` injection poisons the live gateway session even when `joelclaw gateway status` still reports healthy
- this showed up as unrelated voice/livekit notes bleeding into the gateway transcript

If Joel says the gateway session feels "fucked" while health checks look green, inspect the gateway session transcript for hidden `context-refresh` / `gateway-recovery` / `memory-recall` messages before trusting the CLI summary.

## Session pressure visibility (ADR-0218 rank 3 slice)

`joelclaw gateway status` / `joelclaw gateway diagnose` now expose session-pressure specifics instead of just a coarse health word:

- context usage % + next action
- next threshold summary (`compact at 65% ...` / `rotate at 75% ...` / `rotate immediately`)
- last compaction age + session age
- thread counts (`active` / `warm` / `total`)
- fallback state + activation count + consecutive prompt failures
- pressure reasons (`context_usage`, `context_ceiling`, `compaction_gap`, `session_age`)
- last alert health/time + cooldown state

The daemon emits OTEL under `daemon.session-pressure` (`session_pressure.alert.sent|suppressed|failed`). Operator paging is stricter now: only `critical` pressure states page Telegram, while `elevated` / `recovered` transitions stay in status/diagnose/OTEL.

Idle maintenance is autonomous for time-based pressure:
- watchdog evaluates idle session pressure even when no turn is active
- overdue compaction gaps trigger autonomous compaction instead of waiting for the next human/event turn
- age-triggered rotation can also happen from the watchdog path, seeding the fresh session with the compression summary before the next inbound turn
- those watchdog-triggered runs emit the same `daemon.maintenance.started|completed|failed` telemetry as turn-bound maintenance

## Interruptibility and supersession (ADR-0196 / ADR-0218 rank 4 slice)

For direct human turns across Telegram, Discord, iMessage, and Slack invoke paths, the latest message now wins.

Runtime contract:

- new human turns get a short `1.5s` batching window before dispatch
- batching is per source, so rapid follow-ups collapse into one queued prompt
- if that source is already active, gateway supersedes immediately instead of waiting on the timer
- stale queued prompts from that source are dropped
- durable queue replay must not self-drop the freshest human message; supersession only applies when a genuinely newer same-source message exists
- daemon requests `session.abort()` on the stale turn
- stale response text is suppressed instead of being delivered late
- `joelclaw gateway status` exposes `supersession` plus `supersession.batching`
- `joelclaw gateway diagnose` adds an `interruptibility` layer with supersession and batching details

Passive intel / background event routes are excluded from this path.

## Operator ack/timeout tracing (ADR-0218 rank 5 slice)

Telegram operator actions now get trace ids and explicit lifecycle tracking.

Current covered paths:
- `cmd:*` command-menu callbacks
- `worktree:*` callbacks
- `pitch:*` ADR pitch callbacks
- default Telegram callback actions and external callback-route handoffs
- direct Telegram slash commands registered through the command handler
- native Telegram `/stop`, `/esc`, and `/kill` commands

Gateway now tracks `kind=callback|command` plus ack/dispatched/completed/failed/timed_out state for those paths, exposes canonical `operatorTracing` in `joelclaw gateway status` (with `callbackTracing` kept as a compatibility alias), and adds an `operator-tracing` layer in `joelclaw gateway diagnose`.

Queued Telegram agent commands now keep their trace id through downstream gateway execution, complete on the real turn completion path, and fail on prompt error / assistant error / supersession instead of lying at enqueue time. Agent-backed command traces use a longer timeout window than simple callback ack paths.

External callback routes now have a Redis trace-result handoff too: the gateway leaves routed callbacks active, downstream consumers can publish `completed` / `failed` back with the same `traceId`, and the in-tree Restate Telegram route is wired to close traces on real downstream resolution.

Still open: any out-of-tree external callback consumer that doesn't adopt the handoff will still timeout as untracked work.

## Channel runtime contracts (ADR-0218 rank 6 slice)

`joelclaw gateway status` now exposes a canonical `channels` surface plus summarized `channelHealth` for Telegram, Discord, iMessage, and Slack. `joelclaw gateway diagnose` adds a `channel-health` layer so owner/passive/fallback and half-dead channel states are visible before a full outage.

Current rank-6 behavior also sends immediate degrade/recover alerts from the daemon, emits OTEL under `daemon.channel-health`, respects `joelclaw gateway known-issues` mute state so known flaky channels stop crying wolf, and now tracks guarded heal policy state per channel.

`channelHealth.healing` now shows restart/manual policy, degraded streaks, cooldown, attempt counts, last result, plus `manualRepairRequired`, `manualRepairSummary`, and `manualRepairCommands` when the watchdog cannot fix the channel itself. `gateway diagnose` adds `channel-healing`, spells out manual operator repair steps, and the watchdog can attempt guarded restarts for restart-eligible degraded channels while leaving ownership/lease conflicts as manual/operator work.

Telegram retrying `getUpdates` conflicts no longer read as healthy fallback: when polling is down and only retrying, the ownership contract degrades visibly in `/health`, `gateway status`, and `gateway diagnose`.

Low-signal operator-spam guardrails now also apply:
- treat `restate` / `restate/*` sources as automation for batching, so successful queue-dispatch DAG completions don’t hit the live gateway session immediately
- suppress `test.gateway-e2e` from operator delivery by default
- route Joel Slack passive intel through the canonical Redis signal pipeline (`slack.signal.received`) instead of bypassing relay policy
- use `packages/gateway/src/operator-relay.ts` as the single heuristics surface for normalize → score → correlate → route across Slack/email signals
- ingest `vip.email.received` after the VIP pipeline delivers its direct Telegram brief so the gateway keeps correlation context without sending a duplicate alert, while allowing lower-signal email/Slack items to batch into a correlated digest by project/contact/conversation keys
- drop low-signal-only digests (heartbeat-only / queue-dispatch-complete-only) instead of prompting the model for a pointless `HEARTBEAT_OK`
- routine fallback swap/recovery notices are not operator-facing during quiet hours, and recovery notices are log/OTEL-only unless some higher-signal path escalates them
- suppress direct operator-only `Knowledge Watchdog Alert` messages during quiet hours
- add proactive-compaction hysteresis (30m cooldown unless context meaningfully worsens)
- require a minimum dwell on fallback before probing primary again, so fallback swap→restore chatter doesn’t flap immediately
- when the primary model is `claude-opus-4-6`, floor `fallbackTimeoutMs` to `240000`; `120000` is now treated as stale and too aggressive for real Opus TTFT
- clear fallback timeout state immediately on empty/aborted `message_end` events so aborted turns cannot poison the next turn's latency/fallback monitoring
- emit structured fallback decision telemetry (`model_fallback.decision`) with reason buckets / probe counts / probe backoff so OTEL can separate real provider sickness from a noisy control loop
- back off primary recovery probes after transient/persistent probe failures instead of hammering the same sick provider every interval
- treat compaction/rotation as explicit maintenance windows: surface them in gateway status, emit maintenance lifecycle telemetry, and let idle-wait/watchdog logic extend for genuine maintenance work before declaring the turn dead

Muted degraded channels now also flip to `manual` with the known-issue reason surfaced as repair guidance, instead of falsely advertising a restart policy that the watchdog will skip while muted.

Still not done: stricter cross-channel ownership enforcement and richer/native repair automation beyond CLI-guided manual steps.

## Runtime guardrail enforcement (ADR-0189)

Gateway runtime now enforces two operator-visible guardrails:

1. **Tool-budget checkpoint tripwire**
   - channel turns: forced checkpoint after the 2-tool budget is exceeded
   - internal/background turns: forced checkpoint after the 4-tool budget is exceeded
   - telemetry: `daemon.guardrails:guardrail.checkpoint.*`
2. **Automatic post-push deploy verification**
   - after successful `git push` where `HEAD` touched `apps/web/` or root config (`turbo.json`, `package.json`, `pnpm-lock.yaml`)
   - daemon schedules `vercel ls --yes 2>&1 | head -10` after ~75s
   - failures alert Telegram and emit `daemon.guardrails:guardrail.deploy_verification.failed`

Use `joelclaw gateway status` to inspect live `guardrails` state, and `joelclaw gateway diagnose` when a checkpoint or deploy verification is active.

## Behavior Control Plane (ADR-0211)

Gateway behavior is now explicit + deterministic:

- **Runtime authority:** Redis active contract (`joelclaw:gateway:behavior:contract`)
- **History/candidates:** Typesense `gateway_behavior_history`
- **Write authority:** CLI only (`joelclaw gateway behavior ...`)

Operator directives can be entered directly via CLI or in-channel using strict syntax:

- `KEEP: ...`
- `MORE: ...`
- `LESS: ...`
- `STOP: ...`
- `START: ...`

Gateway extension passively captures those lines and shells to `joelclaw gateway behavior add ...`.
It does not write Redis or Typesense directly.

Daily review is advisory-only: candidates are generated by cron and must be promoted manually via `joelclaw gateway behavior promote --id <candidate-id>`.

## Sending Events from Inngest Functions

Every Inngest function receives `gateway` via middleware (ADR-0035):

```typescript
async ({ event, step, ...rest }) => {
  const gateway = (rest as any).gateway as GatewayContext | undefined;

  await step.run("notify", async () => {
    if (!gateway) return;
    await gateway.notify("my.event.type", {
      message: "Human-readable summary",
      data: "structured-payload",
    });
  });
}
```

| Method | Purpose | Routing |
|--------|---------|---------|
| `gateway.progress(msg, extra?)` | Pipeline/loop progress | Origin session + central gateway |
| `gateway.notify(type, payload?)` | Notifications (task done, webhook) | Origin session + central gateway |
| `gateway.alert(msg, extra?)` | System warnings (disk, service down) | Central gateway only |

Import: `import type { GatewayContext } from "../middleware/gateway";`

Always null-check `gateway` — functions can run without a gateway session.

## Low-Level: pushGatewayEvent()

For code outside the middleware:

```typescript
import { pushGatewayEvent } from "./agent-loop/utils";

await pushGatewayEvent({
  type: "video.downloaded",
  source: "inngest/video-download",
  payload: { message: "Downloaded: My Talk" },
  originSession: event.data.originSession,
});
```

## Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Status shows healthy but messages don't arrive | Session stuck mid-stream on hung tool call | `joelclaw gateway restart` |
| Pending events growing on a session | Agent processing or blocked | Wait 1min, then `joelclaw gateway restart` |
| Telegram messages not delivered | HTML parsing error in response | Check `joelclaw gateway status`, restart |
| Telegram is spammed with raw inbound email | `front.message.received` relay gate too permissive or classifier drift | Check `packages/gateway/src/operator-relay.ts`; raw Front email should page only for production/security/money failures or human/project direct asks |
| Slack passive firehose looks dead (mentions still work) | `SLACK_ALLOWED_USER_ID` not derived at startup | Ensure `slack_user_token` lease works; `gateway-start.sh` derives user id via `auth.test`, then `joelclaw gateway restart` |
| Important Slack channels are not being collected | `SLACK_IMPORTANT_CHANNEL_IDS`/`SLACK_IMPORTANT_CHANNEL_NAMES` missing or channel IDs drifted | Check private `~/.joelclaw/scripts/gateway-start.sh`, restart gateway, and verify startup log shows `importantChannelIds > 0` |
| Slack replies have no default target | `SLACK_DEFAULT_CHANNEL_ID` not derived at startup | Ensure `slack_bot_token` lease works; `gateway-start.sh` derives DM channel via `conversations.open`, then restart |
| Gateway restarts every few seconds | Crash loop — bad secret lease or code error | Check `/tmp/joelclaw/gateway.err`, fix cause |
| Redis connection failed | Redis pod down or Colima/k8s substrate down | Check `colima status --json`, then `joelclaw status`/`kubectl` for cluster health |
| `langfuse-cost` optional dependency warning | Langfuse tracing dependency missing for pi extension runtime | Observability degradation only; do not treat as message-path blocker |

## Architecture

```
launchd (com.joel.gateway)
  └─ gateway-start.sh (leases secrets, sets env)
       └─ bun run daemon.ts
            ├─ createAgentSession() → headless pi session (reads SOUL.md)
            ├─ Redis channel (joelclaw:notify:gateway)
            ├─ Telegram channel (@JoelClawPandaBot)
            ├─ Slack channel (invoke on Joel/mentions; collect configured important channels)
            ├─ WebSocket (port 3018, for TUI attach)
            ├─ Command queue (serial — one prompt at a time)
            └─ Heartbeat runner (periodic autonomous checks)
```

Gateway model standard: startup env sets `PI_MODEL_PROVIDER=openai-codex` and `PI_MODEL=gpt-5.5`; Redis config key `joelclaw:gateway:config` should store `model: "gpt-5.5"`. Fallback remains `openai-codex/gpt-5.4` so the fallback controller has a distinct lower-cost/known-good target.

The gateway reads `~/.pi/agent/` at boot for identity/prompt context (SOUL.md, AGENTS.md, MEMORY.md, daily log), but the **gateway extension itself is context-local**:

- Canonical source: `~/Code/joelhooks/joelclaw/pi/extensions/gateway/index.ts`
- Active path: `~/.joelclaw/gateway/.pi/extensions/gateway` (symlink)
- Do **not** install/restore `~/.pi/agent/extensions/gateway` globally

Daemon startup enforces this invariant and will fail if local extension is missing or a global gateway extension is detected.

This keeps gateway automation hooks out of normal interactive pi sessions.

## Key Files

| File | Purpose |
|------|---------|
| `packages/gateway/src/daemon.ts` | Daemon entry — session creation, channels, heartbeat |
| `packages/gateway/src/channels/redis.ts` | Redis subscribe, drain, prompt build |
| `packages/gateway/src/channels/telegram.ts` | Telegram bot channel |
| `packages/gateway/src/command-queue.ts` | Serial FIFO queue → `session.prompt()` |
| `packages/gateway/src/heartbeat.ts` | Periodic autonomous task runner |
| `packages/system-bus/src/inngest/middleware/gateway.ts` | Middleware injecting `gateway` context |
| `packages/cli/src/commands/gateway.ts` | CLI subcommands |
| `~/.joelclaw/scripts/gateway-start.sh` | launchd start script |
| `/tmp/joelclaw/gateway.{log,err,pid}` | Runtime logs and PID |

## ADR anchors

- **ADR-0213** — session lifecycle guards and anti-thrash behavior
- **ADR-0146** — Langfuse observability integration (must fail open when optional dependency is missing)

## Related

- ADR-0038: Gateway daemon architecture
- ADR-0049: Gateway hung session detection + bash timeout
- ADR-0058: Gateway NDJSON streaming
- Skill: [joelclaw](../joelclaw/SKILL.md) — event bus CLI
- Skill: [webhooks](../webhooks/SKILL.md) — inbound webhook providers
