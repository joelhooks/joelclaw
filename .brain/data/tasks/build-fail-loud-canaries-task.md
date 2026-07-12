# Worker brief — build the fail-loud voice canary layer

You are a pi worker in a herdr pane. Work autonomously in this repo. **Do not commit
(no git, no jj), do not run launchctl, do not make live Telnyx API mutations.** The
steering Claude session reviews and commits.

Do not disturb unrelated dirty/untracked files: `wiki-edition-build.ts`, `.pi-subagents/`,
`pipe`, and the existing uncommitted hunks in `index.host.ts` (append your registrations,
never revert other hunks).

Implement ALL 8 pieces of the spec below. Read the pattern files it names before writing.
Run every acceptance command yourself and fix failures until all are green. When finished,
print a DONE summary: files touched, acceptance output, any spec deviations with one-line
reasons.

---

# SPEC: Fail-Loud Canaries + Boot Verification for the joelclaw Voice Agent

Repo: /Users/joel/Code/joelhooks/joelclaw (work in place — this is the live deployed tree).

## Objective

Build the fail-loud layer for the voice agent (LiveKit Cloud + Telnyx phone agent, worker at
`infra/voice-agent/main.py`): boot verification script, worker-registration canary, daily
synthetic call, Telnyx balance monitor, and missed-call paging via Telnyx webhooks.

## Hard constraints

- **NO commits, NO pushes, NO `launchctl` invocations, NO live Telnyx API mutations.**
  The setup script below must be written but NOT executed. Joel's reviewer installs/restarts.
- **Do not touch** these dirty/untracked files' existing content: `packages/system-bus/src/inngest/functions/wiki-edition-build.ts`, `.pi-subagents/`, `pipe`, and the existing uncommitted +2 lines in `index.host.ts` (append your registrations; never revert other hunks).
- **Answering must depend on nothing but LiveKit + the LLM key** — nothing you add may put a new dependency in the call-answering path. Canary code lives beside it, not inside it. The only `main.py` change allowed is the synthetic-canary caller branch (below).
- Follow existing patterns exactly; read the pattern files listed per piece before writing.
- Style: TypeScript strict, plain TS matching sibling Inngest functions (not Effect), no fluffy comments.

## Recorded facts (use these, do not re-derive)

- DID: `+13603894321` (leased as `telnyx_phone_number`)
- LiveKit outbound trunk: `ST_KAQ9ZS6xW6Fo`; inbound trunk `ST_sp5bRD9369Di`; dispatch rule `SDR_NqfyvnCWAA7j` (rooms `call-` prefix)
- Telnyx FQDN connection id: `3002093382945212121`
- `lk` CLI at `/opt/homebrew/bin/lk`; secrets CLI is `secrets lease <name> --ttl <dur>` (a failed lease prints a JSON error envelope to stdout — value starting `{` or empty is INVALID; see `infra/voice-agent/run.sh` `lease()` guard)
- The Inngest **host-role worker runs on flagg as joel via launchd** — Inngest functions may `execSync` `secrets`, `lk`, `launchctl`, `curl` and touch `~/.joelclaw` (pattern: `packages/system-bus/src/lib/telnyx.ts` `leaseSecret`)
- Hard-page primitive exists: send Inngest event `notification/call.requested` `{ message, to? }` → `telnyx-notify.ts` places a call, falls back to SMS
- Soft notify: gateway `notify.message` — from CLI `joelclaw notify send "<msg>" --priority urgent`; from Inngest functions inspect how other functions notify the gateway (see `front-notify.ts` / `vercel-notify.ts` for the in-process pattern)
- Public webhook ingress: `https://hooks.joelclaw.com/webhooks/:provider` proxies to the local webhook server `packages/system-bus/src/webhooks/server.ts`, providers in `packages/system-bus/src/webhooks/providers/`
- Telnyx signs webhooks with Ed25519: headers `telnyx-signature-ed25519` (base64) + `telnyx-timestamp`, message = `${timestamp}|${rawBody}`; account public key comes from env `TELNYX_PUBLIC_KEY` (base64 raw 32-byte key)
- Telnyx balance: `GET https://api.telnyx.com/v2/balance` with `Authorization: Bearer <telnyx_api_key>` → `data.available_credit` (string USD)
- LiveKit worker uses **automatic dispatch** (no `agent_name` in `WorkerOptions`) → the agent joins EVERY new room in the project, including API-created rooms, then waits up to 90s for a participant and leaves. So: "create bare room → agent participant appears within seconds" IS the registration probe.

## Piece 1 — `infra/voice-agent/verify-voice.sh` (new, executable)

Pattern: `infra/central/scripts/verify-nas.sh` (probe/warn_probe helpers, accumulated status, `exit "$status"`). Self-contained (don't source central's common.sh).

Checks (probe = hard fail unless noted):
1. Plist installed at `~/Library/LaunchAgents/com.joel.voice-agent.plist` AND `launchctl print gui/$(id -u)/com.joel.voice-agent` shows state = running.
2. GUI session assumption the user-LaunchAgent depends on: `launchctl print gui/$(id -u)` succeeds.
3. `secrets health` succeeds.
4. Each secret leases clean (non-empty, not starting `{`), TTL 5m: `livekit_url livekit_api_key livekit_api_secret openrouter_api_key deepgram_api_key elevenlabs_api_key gog_keyring_password slack_user_token telnyx_api_key telnyx_phone_number joel_phone_number`. This is the namespaced-vs-bare regression check — bare names must lease from this host.
5. Live dispatch probe: with leased LiveKit env, `lk room create canary-verify-$(date +%s)` (JSON output ok), then poll `lk room participants list <room>` every 2s up to 20s for a participant whose identity starts with `agent-`; always `lk room delete <room>` in cleanup (trap). Fail if no agent joined → worker not registered.
6. Recent crash-loop scan: fail if `~/.local/log/voice-agent.err` contains `FATAL: lease` with a timestamp-agnostic heuristic — er, logs aren't timestamped per-line reliably; instead fail if the err file was modified in the last 10 min AND its tail -50 contains `FATAL:`.
7. Typesense health — find the URL/API-key convention in `packages/system-bus/src/lib/typesense.ts` and curl its `/health`.
8. Wiki edition endpoint `http://127.0.0.1:8790/latest.json` returns 200 — **warn only** (tool fails soft on calls).
9. Telnyx balance: fail if `available_credit < 10`, warn if `< 25`.
10. `~/.config/joelclaw/voice-agent.yaml` exists and `allowed_callers` is non-empty.

On any hard failure, best-effort page before exiting non-zero (both, `|| true`):
- `joelclaw send notification/call.requested '{"message":"verify-voice FAILED on flagg: <joined failure list>"}'`
- `joelclaw notify send "verify-voice FAILED: <list>" --priority urgent`

## Piece 2 — `infra/launchd/com.joel.verify-voice.plist` (new)

Pattern: `infra/launchd/com.joel.voice-agent.plist`. RunAtLoad true, StartInterval 1800, runs verify-voice.sh, logs to `~/.local/log/verify-voice.{log,err}`, same PATH env block as the voice-agent plist. Do not install it.

## Piece 3 — shared probe lib `packages/system-bus/src/lib/voice-canary.ts` (new)

Exports used by the two canary functions:
- `leaseSecretStrict(name)` — reuse/wrap the `leaseSecret` pattern from `lib/telnyx.ts` but throw on empty/`{`-prefixed values.
- `livekitEnv()` — leases the three livekit secrets, returns env map.
- `probeWorkerDispatch()` — the room-create/poll/delete probe from Piece 1 implemented via `execSync` on `lk` (absolute path `/opt/homebrew/bin/lk`, pass env). Returns `{ ok: true, joinMs } | { ok: false, cause: "lease_failed" | "livekit_unreachable" | "worker_not_dispatched", detail }`. Always attempts room delete (finally).
- `launchAgentState(label)` — `execSync launchctl print gui/501/<label>`, returns running/not-running/not-loaded (best-effort, for cause enrichment).
- `pageJoel(inngestSendFn, message)` helper is NOT needed — functions send events via `step.sendEvent` directly.
- Cooldown state: `readCanaryState()/writeCanaryState()` on `~/.joelclaw/state/voice-canary.json` `{ lastPageAt, lastCause, lastOk }`.
- `OUTBOUND_TRUNK_ID = "ST_KAQ9ZS6xW6Fo"` constant (comment: must match call-joel.sh).

## Piece 4 — `voice-worker-canary.ts` Inngest fn (new)

Pattern for cron: `conversation-thread-stale-sweep.ts`. id `voice-worker-canary`, cron `*/5 * * * *`, concurrency 1, retries 0.
Flow: `probeWorkerDispatch()` → on ok: if state had `lastOk === false`, send gateway recovery notice (soft only), write state, done.
On failure: enrich cause with `launchAgentState("com.joel.voice-agent")`; page **both** `notification/call.requested` and the gateway urgent path, message includes cause + detail + "restart: launchctl kickstart -k gui/501/com.joel.voice-agent"; cooldown — skip paging (but still log/return failure) if `lastPageAt` < 30 min ago AND cause unchanged; write state.

## Piece 5 — `voice-synthetic-call.ts` Inngest fn (new)

id `voice-synthetic-call`, cron `TZ=America/Los_Angeles 5 12 * * *`, concurrency 1, retries 0.
Flow: lease livekit env + `telnyx_phone_number`; room `canary-synthetic-<epoch>`; build CreateSIPParticipant JSON exactly like `infra/voice-agent/call-joel.sh` but `sip_call_to` = own DID, `participant_identity` `synthetic-canary`, `wait_until_answered: true`; run `lk sip participant create -` via exec with the JSON on stdin, 60s timeout, measure elapsed ms. Success = command succeeds (answered); record `answerMs`; then `lk room delete <room>` (finally). Assert `answerMs <= 30000` — slower is a soft warn (gateway notice), not a page.
On failure: fetch balance via `getTelnyxBalance()` (Piece 7) and include it — if `< 10`, cause = `telnyx_balance_lapsed` ("this is how the old number died"). Page both channels (no cooldown — it's daily).

## Piece 6 — `main.py` synthetic-canary branch (only allowed main.py change)

In `entrypoint`, after computing `caller_raw`/normalization but BEFORE the allowlist judgment: if the normalized caller equals the agent's own DID (env `TELNYX_PHONE_NUMBER`, may be unset → skip branch), log `SYNTHETIC CANARY ANSWERED room=<room>`, start a minimal AgentSession like the voicemail path at main.py:1087-1094 but say exactly: "Canary check confirmed. All systems nominal." then `await asyncio.sleep(4)` and return. No tools, no context, no transcript event.
Also add to `infra/voice-agent/run.sh` next to the other leases: `export TELNYX_PHONE_NUMBER="$(lease telnyx_phone_number)"`.

## Piece 7 — `getTelnyxBalance()` + `voice-telnyx-balance.ts` (new)

Add `getTelnyxBalance(): Promise<{ availableCredit: number; currency: string }>` to `packages/system-bus/src/lib/telnyx.ts` following its existing fetch/leaseSecret style.
New fn id `voice-telnyx-balance`, cron `0 */6 * * *`, retries 1: warn (gateway notify, normal priority) if `< 25`, page both channels if `< 10`. Include the balance figure in messages.

## Piece 8 — Telnyx webhook provider + missed-call detector

- `packages/system-bus/src/webhooks/providers/telnyx.ts` (new). Pattern: `mux.ts` + `types.ts`. id `telnyx`, eventPrefix `telnyx`. Verify Ed25519 per the facts above using `node:crypto` (`createPublicKey` on the 32-byte raw key wrapped in SPKI DER prefix `302a300506032b6570032100`, then `verify(null, msg, key, sig)`). Missing `TELNYX_PUBLIC_KEY` env → warn-once and reject (mirror mux's missing-secret behavior). Normalize `data.event_type` `call.initiated|call.answered|call.hangup` → events `call.initiated` etc. with the Telnyx `data.payload` as event data; ignore other event types.
- Register in `packages/system-bus/src/webhooks/server.ts` providers map.
- Event catalog: add `telnyx/call.initiated`, `telnyx/call.answered`, `telnyx/call.hangup` to the catalog in `packages/system-bus/src/inngest/client.ts` (follow how `notification/call.requested` is declared).
- `voice-missed-call.ts` (new): trigger `telnyx/call.initiated`; ignore unless `direction === "incoming"` and `to` == our DID; skip if `from` == our DID (synthetic canary). `step.waitForEvent` for `telnyx/call.answered` matching `data.call_session_id`, timeout `45s`. If timeout → page both channels: "Missed call from <from> — voice worker did not answer within 45s". retries 0.
- `infra/voice-agent/setup-telnyx-webhooks.sh` (new, executable, **do not run**): leases `telnyx_api_key`, PATCHes `https://api.telnyx.com/v2/fqdn_connections/3002093382945212121` with `{"webhook_event_url":"https://hooks.joelclaw.com/webhooks/telnyx","webhook_api_version":"2"}`, prints the response and a reminder to set `TELNYX_PUBLIC_KEY` in the host worker env.
- `telnyx.test.ts` beside the provider, patterned on `vercel.test.ts`/`front.test.ts`: signature verify (valid/invalid/missing-key) with a locally generated ed25519 keypair, and event normalization mapping.

## Registration

Export all new functions from `packages/system-bus/src/inngest/functions/index.ts` barrel AND append to the `hostFunctionDefinitions` array in `index.host.ts` (host role — they must run on flagg). Do not add to `index.cluster.ts`.

## Acceptance criteria (all must pass; run them)

```bash
cd /Users/joel/Code/joelhooks/joelclaw
bunx tsc --noEmit
pnpm biome check packages/
bun test packages/system-bus/src/webhooks/providers/telnyx.test.ts
bash -n infra/voice-agent/verify-voice.sh infra/voice-agent/setup-telnyx-webhooks.sh
```

Do NOT run verify-voice.sh itself, launchctl, or any Telnyx mutation. Report: files touched, test output, and any spec deviation with a one-line reason.
