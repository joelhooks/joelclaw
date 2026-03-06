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

## Session pressure visibility (ADR-0218 rank 3 slice)

`joelclaw gateway status` / `joelclaw gateway diagnose` now expose session-pressure specifics instead of just a coarse health word:

- context usage % + next action
- next threshold summary (`compact at 65% ...` / `rotate at 75% ...` / `rotate immediately`)
- last compaction age + session age
- thread counts (`active` / `warm` / `total`)
- fallback state + activation count + consecutive prompt failures
- pressure reasons (`context_usage`, `context_ceiling`, `compaction_gap`, `session_age`)
- last alert health/time + cooldown state

The daemon also pushes direct Telegram alerts when session pressure escalates or recovers, and emits OTEL under `daemon.session-pressure` (`session_pressure.alert.sent|failed`).

## Interruptibility and supersession (ADR-0196 / ADR-0218 rank 4 slice)

For direct human turns across Telegram, Discord, iMessage, and Slack invoke paths, the latest message now wins.

Runtime contract:

- new human turns get a short `1.5s` batching window before dispatch
- batching is per source, so rapid follow-ups collapse into one queued prompt
- if that source is already active, gateway supersedes immediately instead of waiting on the timer
- stale queued prompts from that source are dropped
- daemon requests `session.abort()` on the stale turn
- stale response text is suppressed instead of being delivered late
- `joelclaw gateway status` exposes `supersession` plus `supersession.batching`
- `joelclaw gateway diagnose` adds an `interruptibility` layer with supersession and batching details

Passive intel / background event routes are excluded from this path. Still open: callback ack/timeout tracing and richer interruptibility coverage for non-message operator actions.

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
| Slack passive firehose looks dead (mentions still work) | `SLACK_ALLOWED_USER_ID` not derived at startup | Ensure `slack_user_token` lease works; `gateway-start.sh` derives user id via `auth.test`, then `joelclaw gateway restart` |
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
            ├─ WebSocket (port 3018, for TUI attach)
            ├─ Command queue (serial — one prompt at a time)
            └─ Heartbeat runner (periodic autonomous checks)
```

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
