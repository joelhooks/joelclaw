# Worker brief — Convex call tracker, quality analyzer, live dashboard

You are a pi worker in a herdr pane, repo `~/Code/joelhooks/joelclaw`. Work
autonomously. **No commits, no launchctl, do NOT edit `infra/voice-agent/main.py`**
(the steering session wires the tracker in afterward). Do not disturb unrelated
dirty/untracked files; in `index.host.ts` append around the uncommitted
`wikiEditionBuild` hunks, never revert them.

Design contract (read first): `~/Code/joelhooks/joelclaw-voice/.brain/projects/live-call-dashboard.svx`
— Convex is a **live view, never a system of record**. Fire-and-forget writes,
heartbeat liveness, 7-day self-purge.

Context: the voice agent now has a PUBLIC line (+1 360 925 8342, `pubcall-` rooms)
whose entire point is benchmarking conversational UX. Public calls fire a
`voice/public-call.completed` Inngest event (transcript, room, caller, duration_s,
turns, timestamp) — nothing consumes it yet. Private calls fire `voice/call.completed`
(existing, memory pipeline — DO NOT TOUCH).

## Step 0 — find the Convex deployment

Read `~/.claude/skills/local-convex/SKILL.md` fully. A launchd job
`com.joelclaw.local-convex.lan-forwarder` exists, suggesting a deployment.
Locate its URL/ports and auth (deploy key / admin key). If it is not running or
not standable without sudo, build everything against documented env vars, test
with mocks, and say so LOUDLY in your DONE summary — do not yak-shave Docker.

## Deliverable 1 — Convex schema + functions

Colocate with the dashboard app (`apps/live-dashboard/convex/`). Tables:
- `sessions`: room, tier ("private"|"guest"|"public"|"synthetic"), callerHash,
  startedAt, endedAt?, hangupReason?, lastHeartbeat, turnCount, transcriptTail
  (rolling last ~12 lines, updated in place)
- `turns`: sessionRoom, idx, eouDelayMs?, llmTtftMs?, ttsTtfbMs?, toolCalls?, ts
- `analyses`: room, objective stats (turns, durationS, turnsPerMin), judgeStatus
  ("pending"|"done"), scores? (coherence, warmth, notes), createdAt

Mutations: upsertSessionStart, heartbeat, addTurn, endSession, addAnalysis.
Queries (reactive): activeSessions (heartbeat < 15s stale = ended), recentSessions,
sessionDetail. Scheduled function: purge rows older than 7 days.

## Deliverable 2 — `infra/voice-agent/call_tracker.py`

Standalone module (new file only). `convex` pip client (add via uv to the
voice-agent pyproject). API:
`track_session_start(room, tier, caller)`, `track_turn(room, **metrics)`,
`track_session_end(room, reason)`, `start_heartbeat(room) -> asyncio.Task`.
Every call fire-and-forget: background thread/task, 1s timeout, silent drop on
failure, circuit breaker (3 consecutive failures → disable until a success or
process restart). Caller identity stored as a short hash, never raw number.
Config via env (CONVEX_URL, key if needed) — document at module top. Answering
must never block on this module, by construction. `py_compile` clean + a small
mocked unit test.

## Deliverable 3 — `voice-public-call-analyze` Inngest function

`packages/system-bus/src/inngest/functions/voice-public-call-analyze.ts`:
trigger `voice/public-call.completed` (add the event to `client.ts` Events).
v1: compute objective stats from the payload, write an `analyses` row to Convex
(HTTP mutation), judgeStatus pending. LLM judging: repo rule is NO OpenRouter or
paid keys in system-bus — if an existing in-repo inference pattern (pi dispatch)
is cheap to wire, add a rubric judge (coherence 1-5, warmth 1-5, one-line notes);
otherwise leave pending with a TODO comment. Register in functions `index.ts` +
`index.host.ts` (append-only). Follow `voice-call-completed.ts` style.

## Deliverable 4 — `apps/live-dashboard`

Vite + React + convex react client. Single dark page: active calls strip
(live, tier-badged, elapsed timers), recent calls list with per-call cards
(duration, turns, latency stats from turns, analysis scores when present,
expandable transcript tail). Runs with `bun dev`; tailnet serving is the
steering session's job later. Keep deps minimal; no UI framework beyond
plain CSS or one tiny lib.

## Acceptance

- `bunx tsc --noEmit` green; `pnpm biome check` green on touched packages
- `bun test` green on anything you add
- `infra/voice-agent/.venv/bin/python -m py_compile infra/voice-agent/call_tracker.py`
- Dashboard builds (`bun run build` in apps/live-dashboard)

DONE summary must include: Convex deployment status you found (URL, auth story),
env vars the steering session must set, files touched, anything mocked.
