---
name: agent-session-capture-backup
displayName: Agent Session Capture Backup
description: Verify, repair, backfill, and back up Pi/Claude/Codex session capture across active machines. Use when checking whether agent activity is captured, reviewing capture outbox backlogs, backing transcripts up to NAS, or scheduling capture verification.
version: 0.1.0
author: joel
tags:
  - joelclaw
  - sessions
  - backup
  - nas
  - capture
---

# Agent Session Capture Backup

Use this skill when Joel asks whether agent activity is being captured, indexed, or backed up across machines.

## Canonical surfaces

Transcript/raw activity sources:

- Pi: `~/.pi/agent/sessions`, `~/.pi/agent/run-history.jsonl`, `~/.pi/notes-bridge/events.jsonl`
- Claude Code: `~/.claude/projects`
- Codex: `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/session_index.jsonl`
- joelclaw run capture: `~/.joelclaw/runs-dev`
- failed run-capture posts: per-machine, per-runtime capture outboxes; see the private operator map for current paths. `~/.joelclaw/outbox` is the legacy outbox, not complete capture coverage.

NAS audit mirror:

- `/Volumes/services/joelclaw/sessions/<machine>/<source-key>/...`
- receipts: `/Volumes/services/joelclaw/sessions/receipts/*.json`

The separate additive raw archive has full and priority server receipts plus local steward receipts. For its root and receipt paths, see the private operator map. Do not confuse this archive with the cross-machine audit mirror. An hourly priority job, `com.joelclaw.raw-transcript-backup`, is being added; verify its deployment and fresh receipts before treating it as active.

Capture routing:

- Flagg capture uses loopback: `http://127.0.0.1:3111/api/runs`; health: `http://127.0.0.1:3111/api/runs/health`.
- A local capture endpoint override file is being added; see the private operator map for its path and deployment status.
- Satellites need an approved reachable Central address. Never configure a satellite with Flagg's loopback URL.

Panda is retired, not a live capture host, Central, or relay. Remove it from routine host lists. Capture authentication uses Flagg's persistent local `~/.joelclaw/capture-auth.db`; Typesense `machines_dev` is only its enrollment/migration mirror.

## Manual verification / repair

From `~/Code/joelhooks/joelclaw-runtime`, this Flagg-only metadata audit writes a receipt but does not sync, repair environment files, or replay payloads:

```bash
bun scripts/agent-session-audit-backup.ts \
  --hosts flagg \
  --central-url http://127.0.0.1:3111 \
  --backup-root /Volumes/services/joelclaw/sessions \
  --sync=false
```

For satellites, select active hosts and an approved Central URL reachable from each selected host. Do not rely on the script's historical host or endpoint defaults.

Audit script behavior:

1. verifies each host is reachable
2. verifies each host can reach the Central run-capture health endpoint
3. optionally repairs `JOELCLAW_CENTRAL_URL` in `.zshrc`, `.zprofile`, and `~/.config/system-bus.env`
4. optionally rsyncs transcript/run/outbox sources to the NAS without deleting source files
5. writes a JSON receipt with source counts, backup counts, newest mtimes, byte totals, and legacy outbox metadata

`--repair-env` (`repairEnv` in the scheduled event), `--sync=true`, and outbox replay are mutations requiring a repair request. Authorization for verification alone does not authorize them. For metadata-only verification, use `--sync=false` and omit repair and replay flags. Raw transcript content still requires the session evidence receipt.

The audit script rejects its old `--replay-outbox`, `--replay-limit`, and `--replay-max-bytes` flags. Use `scripts/replay-capture-outbox.ts` for separately requested, bounded replay. Review its catalog, checkpoint, and per-batch receipts against stored hashes and index coverage. Preserve queued payloads. Check worker/Inngest health before replay; do not unleash a large backlog.

## Durable scheduled workflow

Host worker function:

- `system/agent-session.capture-backup.verify`
- manual event: `system/agent-session.capture-backup.requested`
- daily cron: `TZ=America/Los_Angeles 15 5 * * *`

Manual trigger for a requested Flagg backup:

```bash
joelclaw send system/agent-session.capture-backup.requested -d '{
  "hosts": "flagg",
  "centralUrl": "http://127.0.0.1:3111",
  "repairEnv": false
}'
```

The scheduled worker syncs backups even with `repairEnv:false`; this is not metadata-only verification. It defaults `repairEnv` to true when omitted. Review cron repair ownership and explicit hosts/routing before relying on it. Replay is separate work, not part of this event.

## Green criteria

- Every active machine reports `centralHealthOk=true`.
- Every local transcript source has a fresh per-source receipt confirming successful backup. Counts and preserved mtimes alone do not prove parity; partial rsync is not verified completion.
- Each active machine/runtime has reconciled namespaced outbox, replay checkpoint, stored hash, and index coverage. An empty legacy outbox is not a green verdict. Covered queued files may remain on disk.
- Audit receipts are written daily under `/Volumes/services/joelclaw/sessions/receipts`. Raw archive coverage needs its separate full/priority and local steward receipts; see the private operator map.
- A recent receipt covers Flagg and Blaine with fresh Pi, Claude, Codex, `runs-dev`, and outbox metadata. An unreachable host or failed source sync remains unverified.

## Gotchas

- Panda is retired. Historical Central/relay instructions do not authorize routing or repair work there.
- Use current service configuration and fresh receipts for capture routing. Historical host names and endpoint examples are not current authority.
- Backups must be copies, not rotations. Do not delete or move live transcript files during backup.
- Outbox replay is a repair operation. Keep it bounded and leave receipts.
- Never print auth tokens from `~/.joelclaw/auth.json`; the script reads them locally on each host.
