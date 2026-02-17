---
status: implemented
date: 2026-02-14
accepted: 2026-02-15
decision-makers: Joel Hooks
consulted: Claude (pi sessions 2026-02-14, 2026-02-15)
informed: All agents operating on this machine
related:
  - "[ADR-0003 — Build joelclaw instead of deploying OpenClaw](0003-joelclaw-over-openclaw.md)"
  - "[ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md)"
  - "[ADR-0010 — Central system loop gateway](0010-system-loop-gateway.md)"
  - "[ADR-0011 — Redis-backed loop state](0011-redis-backed-loop-state.md)"
  - "[ADR-0035 — Central + satellite session routing](0035-gateway-session-routing-central-satellite.md)"
---

# Adopt pi-native gateway pattern with Redis event bridge for system orchestration

## Context and Problem Statement

ADR-0010 established the need for a central system loop gateway — an autonomous orchestrator that runs SENSE→ORIENT→DECIDE→ACT→LEARN and chose a hybrid event-driven + cron heartbeat approach. It left implementation open.

Deep research into OpenClaw's actual implementation reveals the core mechanism is simpler than expected: a single process owns the LLM session, a timer periodically injects a checklist prompt, and an in-memory queue collects external signals for the next turn. Everything serializes through one command queue. The "gateway" concept maps to 8 concrete responsibilities (session owner, boot sequence, heartbeat scheduler, system events queue, inbound router, outbound delivery, presence/health, config/reload).

We already have pi running as our interactive agent — it owns the session, has a TUI, supports extensions, and has `sendUserMessage()` for programmatic prompt injection. The question is: how do we bridge Inngest (durable workflows, event routing) into pi's session without building a separate gateway process?

### What OpenClaw Does (Research Summary)

OpenClaw embeds the entire pi SDK (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) as npm dependencies. Its gateway is a single Node.js process that:

1. **Creates pi sessions** via `createAgentSession()` from `@mariozechner/pi-coding-agent`
2. **Serializes all access** through a `CommandLane.Main` queue — TUI input, heartbeat prompts, and channel messages all go through `getReplyFromConfig()` → `runEmbeddedPiAgent()`
3. **Runs a heartbeat timer** (`setInterval`) that reads `HEARTBEAT.md`, drains an in-memory system events queue, builds a prompt, and injects it into the same session
4. **Filters responses** — `HEARTBEAT_OK` = silent ack (suppressed), anything else = alert (delivered to channel)
5. **Routes inbound** from WhatsApp/Telegram/Slack/Signal/etc. through normalized message contexts into the same session
6. **Delivers outbound** through channel-specific plugins

The TUI connects via WebSocket to the gateway. It uses `pi-tui` components (`TUI`, `ChatLog`, `CustomEditor`) but talks to OpenClaw's gateway, not pi's native session.

**Key architectural insight**: The "global session REPL" is not a separate concept — it's just the fact that the heartbeat, TUI chat, and channel messages all use the same pi JSONL session file, serialized through one queue.

### What We Already Have

| Capability | Status | Notes |
|---|---|---|
| pi (interactive TUI + session ownership) | ✅ Running | Already the primary interface |
| pi extension API (`sendUserMessage`, `sendMessage`, events, custom tools) | ✅ Available | Can inject prompts, register tools, hook lifecycle |
| Inngest (durable workflows, event routing, cron) | ✅ Running | Event bus, coding loops, media pipelines |
| Redis (persistent state, pub/sub, caching) | ✅ Running | Already used for loop state (ADR-0011) |
| Tailscale mesh | ✅ Running | Network layer between Mac and three-body (home server: 70TB NAS running Inngest, Redis, Qdrant, PDS containers) |
| slog (observability) | ✅ Running | Structured system log (`slog write --action ACTION --tool TOOL --detail "..." --reason "..."`) at `~/Vault/system/system-log.jsonl` — infrastructure changes only, not routine file edits |

### What We Don't Have

- A bridge between Inngest events and pi's session
- A heartbeat mechanism inside pi
- A system events queue that Inngest can write to and pi can read from
- Response routing from pi to external channels (Signal, push, etc.)

## Decision Drivers

- **Simplicity**: Must not turn the system a distinct shade of brown. Start with the least complex option that works, graduate when real pressure demands it.
- **Use what exists**: pi already owns the session. Don't build a second session owner.
- **Inngest for durability**: Background workflows, retries, event chains stay in Inngest. Don't replicate that inside a pi extension.
- **Clean interface boundary**: The bridge between Inngest and pi should be a well-defined protocol, not tangled shared state.
- **Incremental**: Must work in days, not weeks. Phase 1 should be < 200 lines of extension code.

## Non-goals (Phase 1)

- **No separate gateway process.** Pi IS the gateway. Do not build a standalone Node.js server that competes for session ownership.
- **No Inngest client inside the pi extension.** The extension speaks Redis only. Inngest speaks Redis only. They share no code.
- **No outbound delivery in Phase 1.** Alert routing to Signal/push is Phase 3. Phase 1 only injects events into the session and suppresses HEARTBEAT_OK.
- **No HTTP/RPC server in Phase 1.** Synchronous request-response is Phase 4, driven by native app needs (ADR-0004).
- **No multi-channel routing.** Phase 1 has one session key (`main`). Multi-agent sessions with per-agent keys are future work.
- **No replacing Inngest's event bus.** The Redis bridge is a last-mile delivery mechanism from Inngest → pi session. Inngest remains the durable workflow engine.

## Considered Options

### Option A: File trigger (simplest)

Inngest writes to `/tmp/joelclaw-trigger.txt`. A pi extension watches the file with `fs.watch()`, reads content, calls `sendUserMessage()`, clears the file. This is the `file-trigger.ts` pattern from pi's examples.

**Pros**: ~20 lines. Zero dependencies beyond filesystem. Works today.
**Cons**: No structured events. Race conditions on rapid writes. No pub/sub fanout. No persistence across pi restarts. No acknowledgment — Inngest doesn't know if pi processed it.

### Option B: Redis pub/sub + list bridge

Inngest functions LPUSH structured events to a Redis list (`joelclaw:events:{sessionKey}`). A pi extension subscribes to a Redis pub/sub channel for real-time notification. An Inngest cron provides the periodic sweep. Events are structured JSON with type, payload, timestamp. Extension drains the list, builds a prompt, calls `sendUserMessage()`.

**Pros**: Structured events. Persistent (list survives pi restart). Real-time via pub/sub. Inngest already talks to Redis. Clean interface: both sides speak Redis, neither knows the other's internals. At-least-once delivery via read-then-clear pattern (LRANGE+DEL after successful injection).
**Cons**: Requires `ioredis` dependency in the pi extension. Slightly more complex than file trigger. Pub/sub requires a persistent connection from the extension.

### Option C: HTTP/RPC endpoint (most capable)

Pi runs in RPC mode or a pi extension starts an HTTP server. Inngest functions POST structured requests to `http://localhost:PORT/prompt`. Pi processes in session, returns result. Full request-response cycle.

**Pros**: Synchronous acknowledgment. Inngest can wait for result. Structured API. Supports future features (status queries, session inspection). Closest to OpenClaw's WebSocket gateway pattern.
**Cons**: More complex setup. Pi needs to expose a port (security surface). RPC mode changes pi's interactive behavior. Need health checks, auth, error handling. Overkill for Phase 1.

## Decision Outcome

**Start with Option B (Redis bridge). Graduate to Option C (RPC) when the system needs synchronous request-response semantics — likely when building the native iPhone app or multi-agent coordination.**

Option B is chosen because:

1. **Redis is already the shared state bus** (ADR-0011). Both Inngest and the pi extension can talk to it without new infrastructure.
2. **The list + pub/sub pattern gives both persistence and real-time** — events survive pi restarts (list), and pi reacts immediately when events arrive (pub/sub), but the Inngest cron heartbeat catches anything missed (periodic sweep fallback).
3. **The interface is clean** — Inngest writes JSON to a Redis list, pi reads JSON from a Redis list. Neither side imports the other's code. The Redis key schema IS the API contract.
4. **It's incrementally upgradeable** — Option C adds an HTTP layer in front of the same Redis queue. The extension's core logic (drain events → build prompt → sendUserMessage) doesn't change.

### Why Not Option A

File triggers are fragile for anything beyond simple string messages. No structured typing, no persistence, no acknowledgment, race conditions on concurrent writes. Fine for a demo; not for a system we'll live in.

### Why Not Option C (Yet)

RPC/HTTP is the right end state for the native app and multi-agent scenarios. But it's premature complexity now. We don't need synchronous request-response for heartbeats and event injection. When we do — likely Phase 4 (native app) per ADR-0004 — we'll upgrade. The Redis bridge ensures we aren't locked out of that path.

### Consequences

**Good:**
- pi remains the single session owner. No competing processes.
- Inngest workflows can inject events into the interactive session without knowing pi's internals.
- The heartbeat mechanism lives inside pi's process, sharing memory with the session (same serialization guarantees as OpenClaw).
- External events (loop completions, media pipeline results, system health) reach the agent in real-time.

**Bad:**
- The pi extension needs an `ioredis` dependency and persistent connection. *Mitigation*: ioredis has built-in reconnect with exponential backoff. Extension degrades gracefully — if Redis is unreachable, heartbeat skips event drain and logs a slog error, but pi continues functioning normally for interactive use.
- Redis becomes a harder dependency (was already true per ADR-0011, but now pi depends on it too). *Mitigation*: Redis runs with AOF persistence and `restart: unless-stopped` in docker-compose. If Redis is down, pi still works — just no event injection until it reconnects.
- No synchronous acknowledgment — Inngest fires and forgets. If pi is down, events queue in Redis until it comes back. *Mitigation*: Redis list has no TTL (events persist indefinitely). Monitor queue depth via `LLEN joelclaw:events:main` in the health check cron. Alert if depth exceeds 50 (indicates pi hasn't drained in a long time).

**Neutral:**
- The heartbeat cron is durable in the Inngest sense — it fires regardless of pi's state. If pi is down when the cron fires, the event queues in the Redis list and drains when pi reconnects. If pi crashes mid-drain (after LRANGE but before DEL), events remain in the list and are re-read on the next drain — at-least-once delivery, possible duplicate prompt, but heartbeats are idempotent by design so this is safe.

## The Gateway Shape (Responsibility Mapping)

OpenClaw's gateway has 8 responsibilities. Here's how each maps:

| # | Responsibility | OpenClaw | joelclaw (this ADR) |
|---|---|---|---|
| 1 | **Session Owner** | `SessionManager` + JSONL + `CommandLane` | pi process (native session ownership) |
| 2 | **Boot Sequence** | `BOOT.md` → `agentCommand()` | pi extension `session_start` → reads `BOOT.md` → `sendUserMessage()` |
| 3 | **Heartbeat** | `setInterval` → `runHeartbeatOnce()` | Inngest cron (`*/30 * * * *`) → LPUSH heartbeat event → PUBLISH notify → pi extension wakes, drains Redis, reads `HEARTBEAT.md` → `sendUserMessage()` |
| 4 | **System Events** | In-memory `Map<sessionKey, SystemEvent[]>` | Redis list `joelclaw:events:{sessionKey}` |
| 5 | **Inbound Router** | WhatsApp/Telegram/etc. monitors | Inngest functions → Redis LPUSH + PUBLISH |
| 6 | **Outbound Delivery** | Channel plugins → `deliverOutboundPayloads()` | pi extension `agent_end` hook → emit Inngest event → Inngest delivers |
| 7 | **Presence & Health** | In-memory Map + WS broadcast | Redis keys with TTL + Inngest cron health check |
| 8 | **Config & Reload** | File watcher → `updateConfig()` | pi `/reload` command + Redis config channel |

## Redis Event Schema

```typescript
// Key: joelclaw:events:{sessionKey}
// Type: Redis List (LPUSH to add, LRANGE 0 -1 to read, DEL to clear after successful injection)

type SystemEvent = {
  id: string;          // ULID for ordering + dedup
  type: string;        // "loop.complete" | "media.ready" | "health.alert" | "cron.trigger" | "manual"
  source: string;      // "inngest" | "slog" | "cron" | "manual"
  payload: Record<string, unknown>;
  ts: number;          // Unix ms
};

// Pub/sub channel: joelclaw:notify:{sessionKey}
// Message: JSON-encoded { eventId: string, type: string }
// Purpose: wake the extension immediately (vs. waiting for heartbeat poll)
```

### Heartbeat Interval Rationale

Default: **30 minutes** via Inngest cron (`TZ=America/Los_Angeles */30 * * * *`), matching OpenClaw's default. This balances token cost against responsiveness. The pub/sub channel handles urgent events between ticks — the cron is the guaranteed periodic sweep, not the primary delivery path. Unlike OpenClaw's `setInterval`, Inngest cron is durable (fires even if pi restarted), retryable, observable in the Inngest dashboard, and timezone-aware. Schedule changes are code changes in the cron function definition, not env vars — consistent with how all joelclaw scheduling works.

### Heartbeat Response Contract

Following OpenClaw's proven pattern:
- `HEARTBEAT_OK` at start/end of reply → silent ack, no external delivery. Reply is dropped if remaining content is ≤ 300 chars (OpenClaw's `ackMaxChars` default).
- Anything else → alert, route to outbound delivery (Phase 3)
- **Deduplication window: 30 minutes** (matches heartbeat interval). OpenClaw stores `lastHeartbeatText` + `lastHeartbeatSentAt` per session and suppresses identical alert text within the window. We replicate this with a Redis key: `joelclaw:heartbeat:last:{sessionKey}` with 30-min TTL.
- Heartbeats do NOT extend session idle timers

## Implementation Plan

### Required Skills

An implementing agent MUST read these skills before writing code. They contain conventions, patterns, and gotchas that govern how the system works:

| Skill | Location | Governs |
|---|---|---|
| **cli-design** | `~/.pi/agent/skills/cli-design/SKILL.md` | All `joelclaw gateway *` commands — JSON envelope, HATEOAS, error format, Effect CLI patterns |
| **inngest** | `~/.pi/agent/skills/inngest/SKILL.md` | Event types, function patterns, `serveHost` gotcha, worker restart procedure, key paths |
| **inngest-debug** | `~/.pi/agent/skills/inngest-debug/SKILL.md` | GraphQL API for checking cron runs, inspecting failures — used by `joelclaw gateway health` |
| **agent-loop** | `~/.pi/agent/skills/agent-loop/SKILL.md` | PRD format, loop pipeline flow — the gateway's `loop.complete` events come from this pipeline |
| **caddy** | `~/.pi/agent/skills/caddy/SKILL.md` | Tailscale HTTPS endpoints — relevant for Phase 4 (RPC) and for `joelclaw gateway health` checking worker via HTTPS |

These are all symlinked into `~/.pi/agent/skills/` and available to any pi session via `/skill:name`.

### Phase 1: Core Extension (Target: < 200 lines)

**File**: `~/.pi/agent/extensions/gateway/index.ts`

**What it does:**
1. On `session_start`: connect to Redis, subscribe to `joelclaw:notify:main` pub/sub channel
2. On pub/sub message (from Inngest cron heartbeat, loop completions, media pipeline, or any event source): if `ctx.isIdle()`, drain events using **read-then-trim** pattern (not bare RPOP):
   - `LRANGE joelclaw:events:main 0 -1` → read all events
   - Build composite prompt from events + `~/Vault/HEARTBEAT.md`
   - `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` → inject into session
   - Only after successful injection: `DEL joelclaw:events:main` → clear the list
   - If `sendUserMessage` throws, events remain in the list for next drain (at-least-once, not at-most-once)
3. Register `/heartbeat` command for manual trigger (same drain-build-send logic, bypasses cron)
4. Register `/events` command to peek at pending events without draining
5. On `session_shutdown`: disconnect Redis, unsubscribe pub/sub

**No timer in the extension.** All scheduling lives in Inngest. The extension is purely reactive — it wakes when PUBLISH arrives on the notify channel. The Inngest cron heartbeat function (see Phase 2) is just one more event source alongside loop completions, media pipelines, etc.

**Idle gating**: if `ctx.isIdle()` returns false when a pub/sub notification arrives (pi is mid-stream), the extension sets a `pendingDrain = true` flag. It hooks `agent_end` and checks the flag — when the current turn finishes and pi becomes idle, it drains immediately. This ensures events are never silently dropped and latency is bounded to the current turn duration, not the next 30-min cron tick.

**Concurrent drain guard**: the extension uses an in-process `draining = true` flag to prevent overlapping drains. If a second pub/sub notification arrives while a drain is in progress, it's a no-op — the in-flight drain will pick up everything via `LRANGE 0 -1`. This is safe because the list is append-only (LPUSH) and cleared atomically (DEL) after successful injection.

**Dependencies:**
- `ioredis` ^5.x (npm, in extension's package.json)
- `REDIS_HOST` / `REDIS_PORT` from `~/.config/system-bus.env` (already exists for Inngest worker — do NOT use `REDIS_URL`; match the `host`/`port` pattern in `utils.ts`)

**Redis client pattern** (follow existing convention from `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/utils.ts`):

⚠️ **Two clients required.** ioredis enters subscriber mode on `.subscribe()` — a subscribed client cannot run `RPOP`, `LRANGE`, or any non-pub/sub command. The extension MUST create two separate Redis connections:

```typescript
import Redis from "ioredis";

const redisOpts = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
};

// Client 1: pub/sub subscriber (dedicated — enters subscriber mode, cannot run commands)
const sub = new Redis(redisOpts);

// Client 2: commands (LRANGE, DEL, LLEN, GET, SET — all non-pub/sub operations)
const cmd = new Redis(redisOpts);
```
Both use ioredis default reconnect strategy (exponential backoff, max ~30s delay). No custom retry logic needed in Phase 1. Disconnect both on `session_shutdown`.

**Patterns to avoid:**
- Do NOT import Inngest client inside the pi extension. The extension speaks Redis only. Inngest speaks Redis only. They never import each other's code.
- Do NOT write directly to pi's JSONL session files from Inngest. Session ownership belongs to pi's `SessionManager`. External systems inject events, not session entries.
- Do NOT make the heartbeat prompt chatty. Keep it clinical: checklist + events + timestamp. Let the LLM decide what matters.

**Configuration matrix:**

| Env Var | Default | Source | Read By |
|---|---|---|---|
| `REDIS_HOST` | `localhost` | `~/.config/system-bus.env` | gateway extension, Inngest worker |
| `REDIS_PORT` | `6379` | `~/.config/system-bus.env` | gateway extension, Inngest worker |
| `GATEWAY_SESSION_KEY` | `main` | extension env or hardcoded | gateway extension, Inngest functions |
| `GATEWAY_EVENT_LIST_PREFIX` | `joelclaw:events:` | hardcoded | gateway extension, Inngest functions |
| `GATEWAY_NOTIFY_PREFIX` | `joelclaw:notify:` | hardcoded | gateway extension, Inngest functions |

Heartbeat interval is defined in the Inngest cron schedule (`*/30 * * * *` in `heartbeat.ts`), not as an env var. Changing cadence is a code change deployed via worker restart — consistent with how all Inngest cron schedules are managed.

**Affected paths:**
- `~/.pi/agent/extensions/gateway/` (new)
- `~/.pi/agent/extensions/gateway/index.ts` (new — core extension)
- `~/.pi/agent/extensions/gateway/package.json` (new — `ioredis` dependency)
- `~/Vault/HEARTBEAT.md` (new — the checklist)
- `~/Vault/BOOT.md` (new — one-time startup prompt)
- `~/.pi/agent/extensions/system-context.ts` (existing — reference for extension pattern: `pi.on("before_agent_start", ...)` with `sendMessage` conventions)
- `~/Code/joelhooks/joelclaw/packages/cli/src/cli.ts` (add `gateway` subcommand tree — `status`, `events`, `push`, `drain`, `test`)
- `~/Code/joelhooks/joelclaw/packages/cli/src/gateway.ts` (new — gateway command implementations, follows `respond()` envelope from `response.ts`)
- `~/.pi/agent/skills/cli-design/SKILL.md` (existing — design contract, already symlinked)

**HEARTBEAT.md skeleton** (adapted from OpenClaw's template at `docs/reference/templates/HEARTBEAT.md`):
```markdown
# Heartbeat Checklist

## System Health
- [ ] Redis is reachable (`redis-cli ping`)
- [ ] Inngest worker is responding (check `http://localhost:3111/` — returns JSON with `status: "running"`)
- [ ] No stuck agent loops (check `joelclaw:events:main` queue depth)

## Pending Work
- [ ] Check ~/Vault/inbox/ for unprocessed notes
- [ ] Check slog for recent errors (`slog tail --count 5`)

## Human Check-in
- [ ] If daytime (8am-10pm PST): brief status update if anything meaningful changed
- [ ] If nighttime: skip — reply HEARTBEAT_OK

# If nothing needs attention, reply HEARTBEAT_OK.
```

**BOOT.md skeleton** (adapted from OpenClaw's template at `docs/reference/templates/BOOT.md`):
```markdown
# Boot Sequence

On startup, perform these checks in order:

1. Verify Redis connection — report any connection failures
2. Read `~/.joelclaw/workspace/MEMORY.md` for persistent context
3. Check `slog tail --count 3` for recent infrastructure changes
4. Report ready status, then reply HEARTBEAT_OK
```

### Phase 2: Inngest Integration

**What it does:**
1. **Heartbeat cron** — the clock that drives the entire heartbeat loop:
   ```typescript
   export const heartbeatCron = inngest.createFunction(
     { id: "system-heartbeat" },
     { cron: "TZ=America/Los_Angeles */30 * * * *" },
     async ({ step }) => {
       await step.run("push-heartbeat", async () => {
         await pushGatewayEvent({ type: "cron.heartbeat", source: "inngest", payload: {} });
       });
     }
   );
   ```
   This is ~10 lines. It LPUSH's a heartbeat event to the Redis list and PUBLISH's to the notify channel. The pi extension (Phase 1) wakes and drains. Inngest gives us: durable scheduling (fires even if pi restarted), automatic retries, timezone support, observability in the dashboard, and the ability to trigger manually from the Inngest UI.

2. **Gateway event helper** — shared by all functions that push to the gateway:
   ```typescript
   // In utils.ts — reuses existing getRedis() singleton
   export async function pushGatewayEvent(event: Omit<SystemEvent, "id" | "ts">) {
     const redis = getRedis();
     const full = { ...event, id: ulid(), ts: Date.now() };
     const key = `joelclaw:events:${process.env.GATEWAY_SESSION_KEY ?? "main"}`;
     await redis.lpush(key, JSON.stringify(full));
     await redis.publish(key.replace("events:", "notify:"), JSON.stringify({ eventId: full.id, type: full.type }));
   }
   ```

3. **Add `pushGatewayEvent()` calls** to existing Inngest functions. Add as a new `step.run("emit-gateway-event", ...)` — placement per function:
   - `agent-loop-complete` (in `complete.ts`) → add after the existing `push-branch` step (the only step in this function). Push `{ type: "loop.complete", source: "inngest", payload: { loopId, storiesCompleted, storiesFailed } }`
   - `transcriptProcess` (in `transcript-process.ts`) → add after existing `emit-events` step (line 205). Push `{ type: "media.ready", source: "inngest", payload: { vaultPath, title, source } }`
   - `videoDownload` (in `video-download.ts`) → add after existing `emit-events` step (line 101). Push `{ type: "media.ready", source: "inngest", payload: { slug, title, nasPath } }`

4. **Health check cron** — periodic infrastructure health sweep:
   ```typescript
   export const healthCheckCron = inngest.createFunction(
     { id: "system-health-check" },
     { cron: "TZ=America/Los_Angeles */15 * * * *" },
     async ({ step }) => {
       await step.run("check-and-push", async () => {
         const redis = getRedis();
         const queueDepth = await redis.llen("joelclaw:events:main");
         await pushGatewayEvent({
           type: "health.status", source: "inngest",
           payload: { redis: "ok", queueDepth, ts: Date.now() }
         });
       });
     }
   );
   ```

5. **Manual wake** — `system/heartbeat.wake` event-triggered function for on-demand heartbeat (same as cron body, but fired by `inngest.send()` or the Inngest dashboard).

**Redis client pattern to follow**: use the existing singleton `getRedis()` from `utils.ts` (already used by `seedPrd`/`readPrd`/`writePrd`). Import and reuse — do not create a second Redis client.

**Affected paths:**
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/utils.ts` (export `getRedis()` + add `pushGatewayEvent()` helper)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/complete.ts` (add gateway event step)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/transcript-process.ts` (add gateway event step)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/video-download.ts` (add gateway event step)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/heartbeat.ts` (new — cron + manual wake)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/health-check.ts` (new — cron function)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` (add `system/heartbeat.wake` event type — `system/health.check` already exists)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/index.ts` (export new functions)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts` (import + register new functions in the `inngestServe({ functions: [...] })` array AND update the root `/` health JSON — required by inngest skill `references/adding-functions.md` step 4)

### Phase 3: Outbound Delivery

**What it does:**
1. pi extension hooks `agent_end` event
2. If response is an alert (not HEARTBEAT_OK) AND delivery is configured:
   - Emit Inngest event `system/message.deliver` with payload + target channel
3. Inngest function receives event, delivers via Signal CLI / push notification / etc.

**Affected paths:**
- `~/.pi/agent/extensions/gateway/index.ts` (add `agent_end` hook — pi extension API provides `pi.on("agent_end", async (event, ctx) => { ... })` where `event.messages` contains the response)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/deliver-message.ts` (new)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` (add `system/message.deliver` event type)

### Phase 4: Graduate to RPC (Future — when native app needs it)

- Pi extension starts HTTP server on Tailscale-only interface
- Inngest functions switch from Redis LPUSH to HTTP POST
- Adds synchronous request-response for mobile app interactions
- Redis list remains as fallback/queue for burst scenarios

## Verification — `joelclaw gateway` CLI

Every phase is verified by an agent running `joelclaw gateway *` commands that return HATEOAS JSON (`ok: true/false` + `result` + `next_actions`). Same pattern as the existing `igs loop status`, `igs runs`, `igs status` commands. No dashboards, no "watch pi", no human eyeballs.

**Design contract**: all `joelclaw gateway` commands follow the cli-design skill at `~/.pi/agent/skills/cli-design/SKILL.md` (symlinked from `~/Code/joelhooks/joelclaw/.agents/skills/cli-design/`). JSON envelope, HATEOAS next_actions, context-protecting output, errors suggest fixes. Read the skill before implementing any command.

**Implementation**: add `gateway` as a new subcommand tree in `~/Code/joelhooks/joelclaw/packages/cli/src/cli.ts`, following the same `Command.make` + `respond()` + `Effect.gen` pattern as `loop`, `send`, `status`. Build with `bun build src/cli.ts --compile --outfile joelclaw && cp joelclaw ~/.bun/bin/`.

### `joelclaw gateway` subcommands (new — added to CLI in Phase 1)

```
joelclaw gateway status          # Redis connection, pub/sub, extension loaded, queue depth
joelclaw gateway events          # Peek at pending events (non-destructive)
joelclaw gateway push <json>     # LPUSH + PUBLISH a test event to the queue
joelclaw gateway drain           # Trigger heartbeat drain via PUBLISH (like /heartbeat but from CLI)
joelclaw gateway test            # End-to-end: push → notify → drain → verify consumed
joelclaw gateway health          # Phase 2: check cron registered, last cron run, queue depth trend
```

All commands output the standard `respond()` envelope:
```json
{
  "ok": true,
  "command": "joelclaw gateway test",
  "result": { ... },
  "next_actions": [
    { "command": "joelclaw gateway status", "description": "Check gateway health" }
  ]
}
```

### Phase 1 Verification: `joelclaw gateway test`

An agent runs this single command. It exercises the full chain and reports pass/fail:

```bash
joelclaw gateway test
```

**What it does internally** (sequentially, with timeouts):

1. **Check Redis** — connect, PING, report latency
2. **Check extension** — verify `~/.pi/agent/extensions/gateway/index.ts` exists, `package.json` has `ioredis`
3. **Check pub/sub subscriber** — `redis-cli PUBSUB NUMSUB joelclaw:notify:main` returns subscriber count ≥ 1 (proves extension subscribed)
4. **Push test event** — `LPUSH joelclaw:events:main '{"id":"test-{ulid}","type":"gateway.test","source":"cli","payload":{"smoke":true},"ts":{now}}'`
5. **Notify** — `PUBLISH joelclaw:notify:main '{"eventId":"test-{ulid}","type":"gateway.test"}'`
6. **Poll for consumption** — poll `LLEN joelclaw:events:main` every 500ms for up to 15s, waiting for queue to drain to 0
7. **Check slog** — read last slog entry, verify `action=heartbeat, tool=gateway`
8. **Report result**

```json
{
  "ok": true,
  "command": "joelclaw gateway test",
  "result": {
    "redis": { "ok": true, "latencyMs": 1 },
    "extension": { "ok": true, "path": "~/.pi/agent/extensions/gateway/index.ts" },
    "pubsub": { "ok": true, "channels": ["joelclaw:notify:main"] },
    "push": { "ok": true, "eventId": "test-01JKXYZ..." },
    "drain": { "ok": true, "drainedInMs": 2300, "queueDepth": 0 },
    "slog": { "ok": true, "lastEntry": { "action": "heartbeat", "tool": "gateway", "detail": "1 events processed, result: HEARTBEAT_OK" } }
  },
  "next_actions": [
    { "command": "joelclaw gateway events", "description": "Peek at any pending events" },
    { "command": "joelclaw gateway status", "description": "Full gateway health check" }
  ]
}
```

**Failure output** (if extension isn't subscribed to pub/sub — follows cli-design error envelope contract):
```json
{
  "ok": false,
  "command": "joelclaw gateway test",
  "error": {
    "message": "Queue not drained after 15s — no subscriber on joelclaw:notify:main",
    "code": "PUBSUB_NO_SUBSCRIBER"
  },
  "fix": "Start pi with the gateway extension loaded, then re-run this test",
  "result": {
    "redis": { "ok": true, "latencyMs": 1 },
    "extension": { "ok": true },
    "pubsub": { "ok": false, "subscriberCount": 0 },
    "push": { "ok": true, "eventId": "test-01JKXYZ..." },
    "drain": { "ok": false, "queueDepth": 1 }
  },
  "next_actions": [
    { "command": "redis-cli PUBSUB NUMSUB joelclaw:notify:main", "description": "Check subscriber count" },
    { "command": "ls ~/.pi/agent/extensions/gateway/", "description": "Verify extension is installed" },
    { "command": "redis-cli DEL joelclaw:events:main", "description": "Clean up stuck test event" }
  ]
}
```

### `joelclaw gateway status`

Quick health check — no test events, just inspection:

```bash
joelclaw gateway status
```

```json
{
  "ok": true,
  "command": "joelclaw gateway status",
  "result": {
    "redis": { "ok": true, "latencyMs": 1 },
    "pubsub": { "ok": true, "subscriberCount": 1 },
    "queueDepth": 0,
    "lastHeartbeat": { "action": "heartbeat", "tool": "gateway", "ts": "2026-02-15T07:30:00Z", "detail": "0 events processed, result: HEARTBEAT_OK", "reason": "cron" },
    "dedupKey": { "exists": false },
    "extension": { "installed": true, "ioredisVersion": "^5.4.0" }
  },
  "next_actions": [
    { "command": "joelclaw gateway test", "description": "Run end-to-end smoke test" },
    { "command": "joelclaw gateway events", "description": "Peek at pending events" }
  ]
}
```

### `joelclaw gateway events`

Non-destructive peek — same as `/events` in pi, but from CLI for agents:

```bash
joelclaw gateway events
```

```json
{
  "ok": true,
  "command": "joelclaw gateway events",
  "result": {
    "queueDepth": 2,
    "events": [
      { "id": "01JKX...", "type": "loop.complete", "source": "inngest", "ts": "2026-02-15T07:12:00Z", "payload": { "loopId": "loop-abc", "storiesCompleted": 4 } },
      { "id": "01JKX...", "type": "cron.heartbeat", "source": "inngest", "ts": "2026-02-15T07:30:00Z", "payload": {} }
    ]
  },
  "next_actions": [
    { "command": "joelclaw gateway drain", "description": "Force heartbeat drain now" },
    { "command": "joelclaw gateway push '{\"type\":\"test\"}'", "description": "Add another event" }
  ]
}
```

### Phase 2 Verification: `joelclaw gateway health`

Extends `status` to check Inngest cron registration and run history:

```bash
joelclaw gateway health
```

```json
{
  "ok": true,
  "command": "joelclaw gateway health",
  "result": {
    "redis": { "ok": true },
    "pubsub": { "ok": true },
    "queueDepth": 0,
    "inngest": {
      "heartbeatCron": {
        "registered": true,
        "schedule": "TZ=America/Los_Angeles */30 * * * *",
        "lastRun": { "id": "run-xyz", "status": "COMPLETED", "at": "2026-02-15T07:30:00Z" },
        "runsLast24h": 48,
        "failuresLast24h": 0
      },
      "healthCheckCron": {
        "registered": true,
        "schedule": "TZ=America/Los_Angeles */15 * * * *",
        "lastRun": { "id": "run-abc", "status": "COMPLETED", "at": "2026-02-15T07:45:00Z" }
      },
      "pushGatewayEvent": {
        "functionsWithHook": ["agent-loop-complete", "transcript-process", "video-download"],
        "totalPushesLast24h": 7
      }
    },
    "slog": {
      "heartbeatEntriesLast24h": 48,
      "lastEntry": { "action": "heartbeat", "tool": "gateway", "reason": "cron" }
    }
  },
  "next_actions": [
    { "command": "joelclaw gateway test", "description": "End-to-end smoke test" },
    { "command": "igs send system/heartbeat.wake -d '{}'", "description": "Manually trigger heartbeat via Inngest" },
    { "command": "igs runs --count 5", "description": "Recent Inngest runs" }
  ]
}
```

**Failure case** (cron not registered):
```json
{
  "ok": false,
  "result": {
    "inngest": {
      "heartbeatCron": {
        "registered": false,
        "error": "Function 'system-heartbeat' not found — did you deploy heartbeat.ts and restart the worker?"
      }
    }
  },
  "next_actions": [
    { "command": "igs functions", "description": "List registered functions" },
    { "command": "launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker", "description": "Restart worker" }
  ]
}
```

### Phase 3 Verification: `joelclaw gateway test --alert`

Extends the Phase 1 test to verify outbound delivery:

```bash
joelclaw gateway test --alert
```

**What it does internally:**

1. Backs up `~/Vault/HEARTBEAT.md`
2. Writes a HEARTBEAT.md that forces an alert (not HEARTBEAT_OK)
3. Pushes a heartbeat event + notifies
4. Polls for queue drain (same as Phase 1)
5. Checks slog for `result: alert` (not `HEARTBEAT_OK`)
6. Checks Inngest for a `system/message.deliver` event within last 60s
7. Checks dedup: pushes same alert again, verifies NO second `system/message.deliver` event
8. Restores original HEARTBEAT.md

```json
{
  "ok": true,
  "command": "joelclaw gateway test --alert",
  "result": {
    "drain": { "ok": true, "drainedInMs": 3100 },
    "alertDetected": { "ok": true, "slogDetail": "1 events processed, result: alert" },
    "deliveryEvent": { "ok": true, "inngestEventId": "evt-01JKX...", "name": "system/message.deliver" },
    "dedup": { "ok": true, "secondAlertSuppressed": true, "dedupKeyTTL": 1780 },
    "heartbeatRestored": true
  },
  "next_actions": [
    { "command": "igs runs --count 3", "description": "Check deliver-message function ran" },
    { "command": "redis-cli TTL joelclaw:heartbeat:last:main", "description": "Check dedup key TTL" }
  ]
}
```

### Structural Checks (run once, automated)

```bash
# These can be part of `joelclaw gateway status` or a separate `joelclaw gateway lint`

# No inngest imports in the extension
grep -r "from.*inngest" ~/.pi/agent/extensions/gateway/ ; echo "exit:$?"
# Expected: exit:1 (no matches)

# No direct JSONL writes from Inngest functions
grep -r "\.jsonl" ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/ ; echo "exit:$?"
# Expected: exit:1 (no matches)

# Extension uses same Redis pattern as utils.ts
grep -c "lazyConnect" ~/.pi/agent/extensions/gateway/index.ts
# Expected: 1
```

## More Information

### Evaluated Alternative: Inngest Realtime (WebSocket pub/sub)

**Evaluated**: 2026-02-15. **Verdict**: Defer to Phase 4+. Keep Redis pub/sub for Phase 1–3.

Inngest Realtime (`@inngest/realtime` v0.4.6) provides WebSocket-based pub/sub where Inngest functions call `publish({ channel, topic, data })` and subscribers receive messages via `subscribe()` → `ReadableStream<Message>`. It was evaluated as a potential replacement for the Redis pub/sub notification channel.

**Confirmed working on our self-hosted Inngest (v1.17.0)**:
- Token endpoint (`POST /v1/realtime/token`) returns JWT when `INNGEST_SIGNING_KEY` is provided ✅
- WebSocket connects successfully to `ws://localhost:8288/v1/realtime/connect` (Bun native WebSocket) ✅
- Port 8289 exposed for Connect WebSocket gateway ✅
- Signing key already configured in `~/.config/system-bus.env` ✅

**How it would work**: Inngest functions call `publish()` (via `realtimeMiddleware()`) instead of `redis.publish()`. Pi extension uses `subscribe()` to open a WebSocket to the Inngest server, receives structured messages, triggers drain of the Redis event list. Redis list is still needed for persistence (events when pi is down).

**Why deferred — 5 reasons**:

1. **60-second token TTL**. Subscription tokens expire in 60s. The pi extension would need a token refresh loop running continuously — significant complexity for a notification channel that currently takes 5 lines of ioredis `.subscribe()`.

2. **No auto-reconnect**. `TokenSubscription.onclose` calls `this.close()` which is terminal — it closes the StreamFanout and stops. ioredis has built-in exponential backoff reconnect (max ~30s delay). We'd have to build reconnect + token refresh ourselves.

3. **Doesn't reduce dependencies**. We still need ioredis for `LRANGE`, `DEL`, `LLEN`, `GET`, `SET` — the command client. Adding `@inngest/realtime` (which pulls in `inngest` as a dependency) just to replace the subscriber client is a net complexity increase, and violates the "no Inngest imports in extension" design boundary.

4. **Pre-1.0 API surface**. v0.4.6 with `TODO` comments throughout the source. Channel/topic builder API, token format, and WebSocket protocol may change. Redis pub/sub SUBSCRIBE has been stable for 15 years.

5. **Wrong layer for complexity**. The notification channel is the simplest part of the gateway — a "wake up and check your queue" signal. It doesn't need typed channels, schema validation, or streaming. Redis PUBLISH/SUBSCRIBE is exactly right for this: fire-and-forget notification, auto-reconnect, zero auth overhead on localhost.

**When it WOULD fit**: Phase 4+ (native app). When the iPhone app needs real-time updates from Inngest functions (LLM streaming, progress updates), Inngest Realtime is the right tool — it's designed for browser/app → server streaming with auth tokens. At that point, the signing key infrastructure and token refresh lifecycle are justified by the use case.

**Source files examined** (from `inngest/inngest-js` repo, `packages/realtime/`):
- `src/middleware.ts` — `publish()` via `client["inngestApi"].publish()`, auto-wraps in `step.run()`
- `src/subscribe/TokenSubscription.ts` — WebSocket lifecycle, StreamFanout, no reconnect
- `src/subscribe/helpers.ts` — `subscribe()` and `getSubscriptionToken()`
- `src/api.ts` — Token endpoint with signing key auth + fallback
- `src/types.ts` — Full `Realtime` type namespace (channels, topics, messages)
- `src/hooks.ts` — React hooks (confirms browser-first design intent)

### Research Source

This ADR is based on deep analysis of OpenClaw's actual codebase (commit from 2026-02-13, cloned to `/Users/joel/Code/openclaw/openclaw/`). Key files studied:

- `src/infra/heartbeat-runner.ts` — The heartbeat scheduling and execution engine
- `src/infra/system-events.ts` — In-memory session-scoped event queue
- `src/infra/system-presence.ts` — Presence tracking with TTL
- `src/web/auto-reply/heartbeat-runner.ts` — WhatsApp-specific heartbeat delivery
- `src/web/auto-reply/monitor.ts` — Connection lifecycle with heartbeat integration
- `src/agents/pi-embedded-runner/run/attempt.ts` — How pi is embedded as the agent runtime
- `src/tui/tui.ts` — TUI as WebSocket client to gateway
- `src/gateway/server.impl.ts` — Full gateway boot sequence and responsibility orchestration
- `src/gateway/boot.ts` — BOOT.md one-time startup mechanism
- `docs/gateway/heartbeat.md` — Heartbeat configuration and response contract
- `docs/concepts/session.md` — Session management and key resolution
- `docs/concepts/agent-loop.md` — Agent loop lifecycle
- `docs/pi.md` — Pi integration architecture document

### Credit

- **Nick Steinberger** ([OpenClaw](https://github.com/openclaw/openclaw)) — gateway pattern, heartbeat mechanism, session REPL, HEARTBEAT.md checklist, BOOT.md startup, HEARTBEAT_OK response contract, system events queue, presence tracking
- **Mario Zechner** ([pi](https://github.com/badlogic/pi-mono)) — extension API, `sendUserMessage()`, event hooks, TUI components that make this integration possible

### Existing Vault Research

- `~/Vault/projects/openclaw/ideas-from-swarm-tools.md` — swarm-tools patterns (decision traces, coordinator guards, worker handoff contracts) applicable to the gateway's DECIDE phase
- `~/Vault/projects/09-joelclaw/index.md` — joelclaw architecture overview and component map
- `~/Vault/projects/09-joelclaw/ralph-inngest.md` — Durable coding loop design that this gateway orchestrates
