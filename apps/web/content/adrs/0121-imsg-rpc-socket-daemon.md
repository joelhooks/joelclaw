---
status: accepted
date: 2026-02-24
deciders: joel, panda
tags: [gateway, imessage, macos, tcc, launchd, fda]
---

# ADR-0121: iMessage Channel via imsg-rpc FDA Sidecar on macOS

## Context

The gateway daemon needs iMessage inbound/outbound support, but reading `~/Library/Messages/chat.db` requires Full Disk Access (FDA). We do not want the main Bun/Node gateway process to hold FDA.

On macOS Tahoe/Sequoia-class behavior, FDA grants were inconsistent for plain binaries and repeated rebuilds caused identity drift during troubleshooting. A minimal app bundle (`/Applications/imsg-rpc.app`) plus launchd sidecar process proved to be the stable model.

During diagnosis, TCC logs showed the launchd-spawned helper was evaluated as subject `com.steipete.imsg` and granted `authValue=2` for `kTCCServiceSystemPolicyAllFiles`. Remaining failures were operational (binary drift and per-process context), not a launchd parent-process FDA inheritance problem.

## Decision

Adopt an FDA-scoped iMessage helper sidecar:

1. Run `imsg` as a dedicated user LaunchAgent:
   - label: `com.joel.imsg-rpc`
   - command: `/Applications/imsg-rpc.app/Contents/MacOS/imsg rpc --socket /tmp/imsg.sock`
2. Keep the main gateway daemon non-FDA and communicate only over JSON-RPC Unix socket (`/tmp/imsg.sock`).
3. Treat `/Applications/imsg-rpc.app` (bundle id `com.steipete.imsg`) as the FDA grant target in System Settings.
4. Standardize helper deployment so signature/path stay stable:
   - `~/Code/steipete/imsg/build-local.sh`
   - `~/Code/steipete/imsg/scripts/install-rpc-app.sh`
5. Verify health with three independent signals:
   - `tccd` shows `AUTHREQ_RESULT ... authValue=2` for `com.steipete.imsg`
   - helper PID has `chat.db` handles open
   - OTEL shows `imessage.message.received` for end-to-end inbound flow

## Alternatives Considered

1. Grant FDA to the gateway daemon directly.
   - Rejected: violates least-privilege boundary and couples channel permissions to core orchestration runtime.
2. Launch plain `imsg` binary directly from launchd and grant that path.
   - Rejected: FDA picker and identity stability were less reliable across rebuilds.
3. Move to `SMAppService`/login-item app host immediately.
   - Deferred: viable hardening path, but not required for current user LaunchAgent architecture.
4. MDM PPPC profile deployment.
   - Not applicable on this non-MDM personal machine.

## Consequences

### Positive

- iMessage channel is operational with strict privilege separation.
- FDA blast radius is constrained to `imsg-rpc`, not the gateway daemon.
- Debugging is deterministic: TCC identity, socket state, DB handles, and OTEL all observable.

### Tradeoffs

- Additional local process lifecycle (`com.joel.imsg-rpc`) to monitor.
- App bundle + signing workflow must stay in sync with source binary.
- Rebuild discipline is required (`build-local.sh` instead of ad hoc `make build`).

## Implementation Notes

- Gateway client: `packages/gateway/src/channels/imessage.ts`
- Sidecar source: `~/Code/steipete/imsg`
- LaunchAgent: `~/Library/LaunchAgents/com.joel.imsg-rpc.plist`
- App bundle: `/Applications/imsg-rpc.app`
- Socket: `/tmp/imsg.sock`

## Verification

- [x] `sqlite3 ~/Library/Messages/chat.db` readable from FDA-granted context
- [x] `/Applications/imsg-rpc.app/Contents/MacOS/imsg chats --limit 1` succeeds
- [x] launchd helper PID has `chat.db` + socket open (`lsof`)
- [x] Gateway log shows `[gateway:imessage] message received` → `persisted inbound message` → `response ready` for live inbound iMessage (verified 2026-02-24)
- [ ] `joelclaw otel search "imessage.message.received"` returns recent inbound events — **GAP**: code emits via `emitGatewayOtel()` but search returns 0 hits despite socket-level OTEL (`imessage.socket.connected`) indexing fine. Investigate Typesense indexing or emit timing.

## Known Issues

- **Outbound leading newline** (fixed 2026-02-24): LLM text deltas often start with `\n`. `normalizeMessage()` in `outbound/router.ts` now trims before routing. Affects all channels.
