---
status: shipped
date: 2026-02-22
deciders: Joel
tags:
  - gateway
  - heartbeat
  - architecture
  - reliability
---

# ADR-0103: Gateway Session Isolation — No Background Work in the Pi Session

## Context

The gateway daemon runs an embedded pi session that serves as Joel's primary interactive channel (Telegram, Redis events, CLI). This session is **single-threaded** — only one prompt can be processed at a time. While streaming a response, all other messages queue behind an idle waiter that resolves on `turn_end`.

Three overlapping heartbeat paths were injecting HEARTBEAT.md checklist prompts into this session every 15 minutes:

1. **Gateway `heartbeat.ts`** — `setInterval(15min)` → reads HEARTBEAT.md → enqueues prompt into pi session
2. **Inngest `system-heartbeat`** cron — fans out 10 `check/*` events → **also** pushes `cron.heartbeat` to gateway via Redis
3. **Gateway Redis channel** — receives `cron.heartbeat` → builds HEARTBEAT.md prompt → enqueues into pi session

Each heartbeat prompt runs tool calls (kubectl, redis-cli, curl) that take 30–90 seconds. During this time, Telegram messages hit "Agent is already processing" errors. After 3 failed retries (6 seconds total — far shorter than a heartbeat turn), the model fallback controller activates. The session becomes effectively unresponsive.

Meanwhile, the 10 Inngest `check/*` functions already perform all the same health checks independently in the worker and push results to the gateway only when actionable. The gateway-side HEARTBEAT.md processing was entirely redundant.

**Root cause incident (2026-02-22)**: Gateway restarted at 08:15 PST. Heartbeat prompt was processing when Telegram messages arrived. Three retry attempts failed with "Agent is already processing." Fallback activated (3rd time this session). Gateway unresponsive to Telegram until manual restart.

## Decision

**The gateway pi session must never be blocked by background work.**

Specifically:

1. **Remove all heartbeat prompt injection** from the gateway daemon. No HEARTBEAT.md processing in the pi session.
2. **Remove the `push-gateway-heartbeat` step** from the Inngest heartbeat cron. No `cron.heartbeat` events pushed to gateway.
3. **Gateway heartbeat runner reduced to**: tripwire file writer (for launchd watchdog) + local health snapshot (in-process state only, no tool calls) + batch digest flush.
4. **Check functions remain the sole health-check path.** They run in the Inngest worker and push to gateway only when something is actionable. This was already the stated design (ADR-0062) but not fully implemented.

**Principle**: The gateway pi session is a scarce interactive resource. It handles user messages, event routing, and actionable notifications. Background computation (health checks, audits, triage) belongs in Inngest functions running in the worker.

## Consequences

### Positive

- Gateway responds to Telegram messages immediately — no 30–90s heartbeat blocking
- Eliminates the "already processing" race condition entirely
- Reduces gateway session token burn (~2 heartbeat prompts × 4/hour = 8 tool-heavy turns/hour removed)
- Completes the ADR-0062 intent: heartbeat is pure fan-out, checks are independent

### Negative

- Gateway pi session no longer has direct awareness of system health (it receives health alerts from check functions instead of running checks itself)
- If all check functions fail silently, the gateway won't know — mitigated by the watchdog timer and OTEL

### Non-goals

- Not changing the check function architecture (ADR-0062 covers that)
- Not adding `streamingBehavior: 'followUp'` to the command queue (the root cause is architectural, not a race condition to patch)
- Not removing HEARTBEAT.md from Vault (it documents what the check functions verify, useful as reference)

## Implementation Plan

### Files Changed

| File | Change |
|------|--------|
| `packages/gateway/src/heartbeat.ts` | Remove prompt injection. Keep tripwire, watchdog, digest flush. Add local health OTEL snapshot. |
| `packages/system-bus/src/inngest/functions/heartbeat.ts` | Remove `push-gateway-heartbeat` step from both `heartbeatCron` and `heartbeatWake`. Remove unused `pushGatewayEvent` import. |
| `packages/gateway/src/channels/redis.ts` | Filter out `cron.heartbeat` events in `buildPrompt()`. Return empty string (no-op) if only heartbeat events remain. |

### Verification

- [ ] Gateway processes Telegram messages without "already processing" errors during check function execution
- [ ] No `cron.heartbeat` events appear in gateway Redis queue after Inngest heartbeat cron fires
- [ ] Gateway heartbeat tripwire file still updates every 15 minutes
- [ ] Check functions still push actionable findings to gateway (verify with `joelclaw otel search "check" --hours 1`)
- [ ] `joelclaw gateway status` shows healthy with 0 pending after heartbeat cron fires

## Related

- **ADR-0062**: Heartbeat-Driven Task Triage — established fan-out pattern
- **ADR-0037**: Three-layer gateway watchdog — tripwire mechanism preserved
- **ADR-0038**: Embedded pi gateway daemon — session architecture
- **ADR-0091**: Model fallback controller — activated by the failures this ADR prevents
