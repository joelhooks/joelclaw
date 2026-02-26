---
status: deferred
date: 2026-02-19
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-19)"
informed: "All agents consuming joelclaw CLI"
related:
  - "0009-rename-igs-cli-to-joelclaw"
---

# 58. Streamed NDJSON Protocol for Agent-First CLIs

## Context

The joelclaw CLI follows the cli-design skill: every command returns a single JSON envelope (`{ ok, command, result, next_actions }`). This works for point-in-time queries — "what's the status now?" — but joelclaw is fundamentally a temporal system. Events, pipelines, loops, gateway messages all happen over time.

The design already strains:

1. **`watch` breaks Principle #1 ("JSON always").** It polls Redis every 15 seconds in a while loop and outputs formatted plain text — not JSON envelopes — because the envelope format has no streaming semantics.

2. **`send` is fire-and-forget.** Agent sends an event, gets an envelope back, then must manually poll `runs` → `run <id>` → `runs` again to follow execution. Each poll is a separate tool call burning agent context.

3. **Agents pay a polling tax.** Pi, Claude, and codex consume CLI stdout. For anything temporal, they're forced into poll loops inside their own context — wasting tokens on repeated `joelclaw runs --count 3` calls that return mostly-unchanged state.

4. **The gateway already streams.** The Redis pub/sub bridge (ADR-0018) pushes events to the gateway extension in real-time. But the CLI — the primary agent interface — can't tap into that same flow.

The existing infrastructure supports streaming: `pushGatewayEvent()` middleware writes to Redis pub/sub on every Inngest step. The CLI just needs a protocol to consume it.

## Decision

Add a **streamed NDJSON protocol** alongside the existing request-response envelope. Commands that involve temporal operations (watching, following, streaming) emit one JSON object per line on stdout, with the final line being the standard HATEOAS envelope.

### Protocol Shape

```
{"type":"start","command":"joelclaw send video/download --follow","ts":"2026-02-19T08:25:00Z"}
{"type":"step","name":"download","status":"started","ts":"..."}
{"type":"progress","name":"download","percent":45,"ts":"..."}
{"type":"step","name":"download","status":"completed","duration_ms":3200,"ts":"..."}
{"type":"step","name":"transcribe","status":"started","ts":"..."}
{"type":"log","level":"warn","message":"Large file, chunked transcription","ts":"..."}
{"type":"step","name":"transcribe","status":"completed","duration_ms":45000,"ts":"..."}
{"type":"result","ok":true,"command":"...","result":{...},"next_actions":[...]}
```

### Type Discriminator

The `type` field is a discriminated union:

| Type | Meaning | Terminal? |
|------|---------|-----------|
| `start` | Stream begun, echoes command | No |
| `step` | Inngest step lifecycle (started/completed/failed) | No |
| `progress` | Progress update (percent, bytes, message) | No |
| `log` | Diagnostic message (info/warn/error level) | No |
| `event` | An Inngest event was emitted (fan-out visibility) | No |
| `result` | HATEOAS success envelope — always last | **Yes** |
| `error` | HATEOAS error envelope — always last | **Yes** |

Stream terminates when `result` or `error` appears. Consumers read lines until they see a terminal type.

### TypeScript Types

```typescript
// ADR-0058: packages/cli/src/stream.ts
type StreamEvent =
  | { type: "start"; command: string; ts: string }
  | { type: "step"; name: string; status: "started" | "completed" | "failed"; duration_ms?: number; error?: string; ts: string }
  | { type: "progress"; name: string; percent?: number; message?: string; ts: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; ts: string }
  | { type: "event"; name: string; data: unknown; ts: string }
  | { type: "result"; ok: true; command: string; result: unknown; next_actions: NextAction[] }
  | { type: "error"; ok: false; command: string; error: { message: string; code: string }; fix: string; next_actions: NextAction[] }
```

### Backwards Compatibility

- **Non-streaming commands** remain unchanged — single JSON envelope, no `type` field.
- **Streaming commands** (`--follow`, `watch`) emit NDJSON where the last line is the standard envelope.
- **Tools that don't understand streaming** can read the last line only and get the same envelope they expect.
- **No `--stream` flag** — streaming is activated by command semantics (`--follow`, `watch`, `gateway stream`), not a global switch.

### Implementation: Redis Subscription

Streaming commands subscribe to the same Redis pub/sub channels the gateway extension uses:

```
joelclaw:notify:{session-id}  — targeted events
joelclaw:notify:gateway        — all events (for gateway stream)
joelclaw:run:{run-id}          — run-specific events (for send --follow)
```

The `pushGatewayEvent()` middleware already writes to these channels. The CLI is just another subscriber.

### Commands That Stream

| Command | Behavior |
|---------|----------|
| `joelclaw send <event> --follow` | Send event, subscribe to run channel, stream step completions until done |
| `joelclaw watch [loop-id]` | Subscribe to loop state changes via Redis, emit NDJSON (replaces polling) |
| `joelclaw logs --follow` | Tail log file, emit each new line as `{"type":"log",...}` |
| `joelclaw gateway stream` | Subscribe to gateway pub/sub, emit all events |

## Alternatives Considered

### SSE (Server-Sent Events)
HTTP-native streaming. Would require running an HTTP server in the CLI or proxying through the Inngest server. Adds infrastructure for a problem that pipe-native NDJSON solves with zero dependencies.

### WebSocket subscription
Bidirectional, which we don't need. CLI only reads. Adds ws dependency and connection management for no benefit over Redis SUBSCRIBE → stdout.

### Status quo (keep polling)
Works but wastes agent context, adds latency (up to poll interval), and forces `watch` to violate JSON-only principle. The polling hack in watch.ts is evidence the design needs this.

## Non-goals

- Not replacing the request-response envelope — it stays for point-in-time queries
- Not adding streaming to every command — only temporal operations
- Not building a general pub/sub client — scoped to CLI consumption of existing Redis channels
- Not changing the gateway extension — it already emits events; CLI just subscribes

## Consequences

### Positive
- `watch` can finally be JSON-only (fixing Principle #1 violation)
- Agents stop paying the polling tax — real-time feedback through the same CLI interface
- Pipeline observability through `send --follow` — see video ingest, meeting analysis, email triage step-by-step
- Gateway tap from any terminal — `joelclaw gateway stream` for debugging
- Composable with Unix tools — `joelclaw watch | jq --unbuffered 'select(.type == "step")'`

### Negative
- Streaming commands hold a Redis connection open — need cleanup on SIGINT/SIGTERM
- Agents must handle line-by-line reads (most already do for long-running commands)
- Two output modes to document and test (envelope vs NDJSON stream)

### Follow-up
- [ ] Update cli-design skill with streaming protocol section
- [ ] Implement `StreamEvent` types and `emit()` helper in `packages/cli/src/stream.ts`
- [ ] Refactor `watch.ts` to use NDJSON stream
- [ ] Add `--follow` flag to `send.ts`
- [ ] Add `joelclaw gateway stream` command
- [ ] Add `--follow` to `logs` command
- [ ] Extend `pushGatewayEvent()` to also publish to run-specific channels (`joelclaw:run:{runId}`)
- [ ] Write article on CLI design for agents (joelclaw.com)

## Implementation Plan

### Affected paths
- `packages/cli/src/stream.ts` — new: StreamEvent types, `emit()`, `streamFromRedis()`
- `packages/cli/src/response.ts` — unchanged (envelope stays)
- `packages/cli/src/commands/watch.ts` — refactor: NDJSON instead of polling+text
- `packages/cli/src/commands/send.ts` — add `--follow` flag
- `packages/cli/src/commands/logs.ts` — add `--follow` flag
- `packages/cli/src/commands/gateway.ts` — add `stream` subcommand
- `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` — extend `pushGatewayEvent` to publish run-specific channels
- `.agents/skills/cli-design/SKILL.md` — add streaming protocol section

### Pattern
All streaming commands use the same `streamFromRedis()` utility that:
1. Emits `{"type":"start",...}` on connect
2. Subscribes to the appropriate Redis channel
3. Parses gateway events and re-emits as typed `StreamEvent` lines
4. Emits `{"type":"result",...}` on completion or `{"type":"error",...}` on failure
5. Cleans up Redis connection on SIGINT/SIGTERM/stream-end

### Tests
- Unit: `StreamEvent` type discrimination, `emit()` output format
- Integration: subscribe to Redis channel, verify NDJSON lines match expected types
- Structural: `watch.ts` no longer uses `Console.log` with plain text

### Verification
- [ ] `joelclaw send test/ping --follow` streams step events and terminates with HATEOAS envelope
- [ ] `joelclaw watch` outputs NDJSON (each line parses as valid JSON with `type` field)
- [ ] Last line of any stream is `type: "result"` or `type: "error"`
- [ ] `joelclaw status` (non-streaming) output is unchanged
- [ ] `ctrl-c` during stream cleanly disconnects Redis
- [ ] `joelclaw watch | jq .type` works (composable with pipes)
