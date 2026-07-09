---
name: agent-session-capture-backup
displayName: Agent Session Capture Backup
description: Verify, repair, backfill, and back up Pi/Claude/Codex session capture across Flagg, Blaine, and Panda. Use when checking whether agent activity is captured, clearing joelclaw outbox backlogs, backing transcripts up to three-body NAS, or scheduling capture verification.
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
- failed run-capture posts: `~/.joelclaw/outbox`

NAS backup target:

- `/Volumes/three-body/sessions/<machine>/<source-key>/...`
- receipts: `/Volumes/three-body/sessions/receipts/*.json`

Current live capture endpoint, per 2026-07-09 repair receipt:

- `http://joels-mac-studio.tail7af24.ts.net:3111/api/runs`
- health: `http://joels-mac-studio.tail7af24.ts.net:3111/api/runs/health`

Important drift note: older system-architecture docs say Panda is Central, but Panda's run-capture path currently fails during auth because its local Typesense `machines_dev` lookup resets connections. Flagg/Mac Studio is the working capture endpoint for Blaine right now.

## Manual verification / repair

From `~/Code/joelhooks/joelclaw-runtime`:

```bash
bun scripts/agent-session-audit-backup.ts \
  --hosts flagg,blaine,panda \
  --central-url http://joels-mac-studio.tail7af24.ts.net:3111 \
  --backup-root /Volumes/three-body/sessions \
  --repair-env \
  --sync=true \
  --replay-outbox \
  --replay-limit 250 \
  --replay-max-bytes 10485760
```

What it does:

1. verifies each host is reachable
2. verifies each host can reach the Central run-capture health endpoint
3. optionally repairs `JOELCLAW_CENTRAL_URL` in `.zshrc`, `.zprofile`, and `~/.config/system-bus.env`
4. rsyncs transcript/run/outbox sources to the NAS without deleting source files
5. replays a bounded number of outbox JSON payloads to `/api/runs`
6. writes a JSON receipt with source counts, backup counts, newest mtimes, byte totals, and outbox before/after

Use `--sync=false` for read-only audit.

Use a low `--replay-limit` first when clearing a huge outbox. Do not unleash tens of thousands of run-capture events without checking worker/Inngest health.

## Durable scheduled workflow

Host worker function:

- `system/agent-session.capture-backup.verify`
- manual event: `system/agent-session.capture-backup.requested`
- daily cron: `TZ=America/Los_Angeles 15 5 * * *`

Manual trigger:

```bash
joelclaw send system/agent-session.capture-backup.requested -d '{
  "hosts": "flagg,blaine,panda",
  "centralUrl": "http://joels-mac-studio.tail7af24.ts.net:3111",
  "repairEnv": true,
  "replayLimit": 250,
  "replayMaxBytes": 10485760
}'
```

## Green criteria

- Every active machine reports `centralHealthOk=true`.
- Every transcript source that exists locally has matching or increasing backup file counts on NAS.
- `~/.joelclaw/outbox` count trends toward zero on each machine.
- Receipts are written daily under `/Volumes/three-body/sessions/receipts`.
- A recent receipt includes Flagg and Blaine with fresh Pi, Claude, Codex, `runs-dev`, and outbox counts.

## Gotchas

- Do not use `http://panda:3000`; that endpoint is stale and fails.
- Do not use Panda's `/api/runs` until its local Typesense auth lookup is healthy again.
- Flagg may have live local capture even when docs still say Panda is Central. Verify `system-architecture` and recent receipts before changing authority language.
- Backups must be copies, not rotations. Do not delete or move live transcript files during backup.
- Outbox replay is a repair operation. Keep it bounded and leave receipts.
- Never print auth tokens from `~/.joelclaw/auth.json`; the script reads them locally on each host.
