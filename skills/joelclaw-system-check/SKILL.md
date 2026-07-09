---
name: joelclaw-system-check
displayName: Joelclaw System Check
description: "Run comprehensive joelclaw health checks, including postboot/daily checks for NAS, MinIO, Convex, Postgres, Typesense, Inngest, Panda/Flagg authority split, k8s, worker, Redis, OTEL, tests, repo sync, memory pipeline, and disk. Use when: 'system health', 'postboot check', 'daily system check', 'health check', 'is everything working', 'system status', 'how's the system', 'check everything', or at session start to orient."
version: 1.1.0
author: Joel Hooks
tags: [joelclaw, health, diagnostics, checks, operations]
---

# joelclaw System Health Check

Run `scripts/postboot.sh` for the read-only postboot/daily topology sweep. It checks the Flagg/Panda authority split, NAS mounts, NFS tuning, custom NAS MinIO, Central Postgres, local Convex, Typesense, Inngest, and shadow Central health without printing secrets. The daily automation also reviews recent Codex infra transcripts so completed work does not stay trapped in chat.

## Migration caveat — 2026-07-09

The current health script is still too Panda-centric: it treats Panda-era k8s/PDS/NodePort surfaces as if they were the whole joelclaw system. That is no longer aligned with the Central migration vision.

Health needs to become lane-based:

- **Central lane**: Flagg/Mac Studio native launchd services, Redis, Typesense, Inngest, system-bus worker, agent-mail, run capture, session NAS backup receipts, reboot-survivable state.
- **Relay lane**: Panda-only leftovers such as iMessage/account-bound relays, legacy webhook/callback surfaces, and explicit decommission blockers.
- **Satellite lane**: Blaine/other Machines' `JOELCLAW_CENTRAL_URL`, outbox backlog, fresh capture timestamps, and transcript backup freshness.

Until that rewrite lands, read red Panda/k8s/PDS checks as migration TODOs, not proof that Flagg Central is dead.

```bash
~/Code/joelhooks/joelclaw-runtime/skills/joelclaw-system-check/scripts/postboot.sh
```

Run `scripts/health.sh` for the older full system health report with 1-10 score. This is heavier because it includes tests and TypeScript.

```bash
~/Code/joelhooks/joelclaw-runtime/skills/joelclaw-system-check/scripts/health.sh
```

## Postboot/Daily Check

Use this after a reboot, after storage/network work, and for the daily automation.

Default command:

```bash
POSTBOOT_NAS_BENCHMARK_MIB=1 \
  ~/Code/joelhooks/joelclaw-runtime/skills/joelclaw-system-check/scripts/postboot.sh
```

Default posture:

- Read-only except for the tiny NAS verifier write probe under the already-designated `s3` proof paths.
- Does not run the Convex write/read/delete smoke unless `POSTBOOT_HEAVY=1`.
- Does not run the legacy full `health.sh` unless `POSTBOOT_RUN_FULL_HEALTH=1`.
- Never prints raw `.env`, MinIO keys, Convex admin keys, or Postgres URLs with passwords.
- Treats custom NAS MinIO on `100.67.156.41:39000` as canonical.
- Treats ASUSTOR MinIO CE on `29990` as a warning/reference surface only.
- On Flagg, expects `JOELCLAW_CENTRAL_URL` and direct Typesense helpers to still point at Panda until explicit Central cutover.

Critical checks:

| Check | What Green Means |
| --- | --- |
| authority split env | Flagg still points Central capture/search at Panda while Flagg is shadow |
| Inngest direct health | the authoritative Inngest endpoint responds on `/health`; on Flagg this falls back to `http://panda:8288` if `INNGEST_URL` is unset |
| Run capture health | Panda `/api/runs/health` returns `ok=true` with local Machine auth |
| Typesense configured health | configured Typesense endpoint responds on `/health` |
| NAS launchd label | `system/com.joelclaw.central.nas-mounts` is loaded with no failing last exit |
| NAS route 10GbE/MTU | route to `192.168.1.163` uses `en0` and MTU `8192` |
| NAS mounts status | `/Volumes/nas-nvme` and `/Volumes/three-body` are mounted from LAN IP exports |
| NAS verifier write probe | service checkout `verify-nas.sh` passes |
| NFS tuned options | live mounts show `rsize=524288,wsize=524288,readahead=128` |
| custom MinIO ready/live | custom NAS MinIO responds on `39000` |
| Central Postgres | socket, TCP, and readiness checks pass |
| local Convex | backend `/version` and dashboard respond |

Warning/reference checks:

- custom MinIO console TCP on `39001`
- ASUSTOR MinIO CE readiness on `29990`
- aggregate `joelclaw status` and `joelclaw inngest status` CLI wrappers, because those can reveal local env drift even when the authoritative endpoint is healthy
- Convex LAN and tailnet forwards
- local Convex LAN forwarder LaunchAgent
- Flagg shadow Central health
- gated heavy checks

If `postboot.sh` fails, fix critical failures first. Do not chase warning/reference failures before the required path is green.

## Recent Codex Transcript Review

The daily automation should review recent Codex infra sessions after the health script runs.

Preferred indexed search:

```bash
joelclaw sessions search \
  "NAS three-body MTU MinIO Convex Postgres Typesense Inngest Panda Flagg Central postboot" \
  --source typesense \
  --machine all \
  --runtime codex \
  --limit 10 \
  --extract
```

If indexed Codex results are stale, irrelevant, or missing today's work, use a bounded local raw fallback:

```bash
tail -n 80 ~/.codex/session_index.jsonl
find ~/.codex -type f -name "rollout-*.jsonl" -mtime -2
```

Review only bounded snippets, final answers, commands, and receipts. Do not dump full transcripts or secrets.

Promote durable facts into the right surface:

- system topology and Panda/Flagg authority -> `skills/system-architecture/SKILL.md`
- NAS access, LAN/MTU/NFS behavior -> `skills/three-body/SKILL.md`
- custom NAS MinIO behavior -> `skills/minio/SKILL.md`
- local Convex exposure and daily-use shape -> `skills/local-convex/SKILL.md`
- dated receipts and decisions -> `.brain/resources/*.svx`

Treat in-progress subagent threads and sessions without a final answer as leads, not architecture truth.

Active Codex automation:

- ID: `daily-joelclaw-postboot-system-check`
- Schedule: daily at 08:15 local time
- Workspace: `/Users/joel/Code/joelhooks/joelclaw-runtime`
- Command intent: run `POSTBOOT_NAS_BENCHMARK_MIB=1 skills/joelclaw-system-check/scripts/postboot.sh`, summarize failures/warnings, review recent Codex infra transcripts, report uncaptured durable facts, and avoid secret output.

## Full Health Check (16 components)

| Check | What | Green (10) | Yellow (5-7) | Red (1-3) |
|-------|------|-----------|-------------|----------|
| k8s cluster | pods in `joelclaw` namespace | 4/4 Running, 0 restarts | partial pods | no pods |
| pds | AT Proto PDS on :9627 | version + collections | pod running, host publish degraded | pod not running |
| worker | system-bus on :3111 | 16+ functions | responding, low count | down |
| inngest server | :8288 reachable | responding | — | down |
| agent-mail | Flagg-local MCP mail on :8765 | alive + mailbox visible | degraded counts/search | unavailable |
| redis/gateway | Redis + gateway session queues | connected, low pending queue | connected, backlog rising | unavailable |
| typesense/otel | Typesense health + OTEL query path | healthy + queryable | healthy, query degraded | unavailable |
| tests | isolated per-file `bun test` in system-bus | 0 fail | — | failures |
| tsc | `tsc --noEmit` | clean | — | type errors |
| repo sync | monorepo HEAD vs `origin/main` | in sync | ahead/behind | repo unavailable |
| memory pipeline | `joelclaw inngest memory-health` | healthy checks | degraded checks | failing checks |
| pi-tools | extension deps installed | all 3 deps | — | missing |
| git config | user.name + email set | set | — | missing |
| active loops | `joelclaw loop list` | queryable | query degraded | unavailable |
| gogcli | Google Workspace auth | account authed, token valid | token stored, no password | not configured |
| disk | free space + loop tmp | <80% used | — | >80% |
| stale tests | `__tests__/` + acceptance tests | clean | — | present |

## Agent Session Capture + NAS Backup Check

Use the `agent-session-capture-backup` skill when the check needs proof that Pi/Claude/Codex transcript activity is captured and backed up across Flagg, Blaine, and Panda.

Fast audit/repair command from `~/Code/joelhooks/joelclaw`:

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

Daily durable workflow:

- function: `system/agent-session.capture-backup.verify`
- event: `system/agent-session.capture-backup.requested`
- cron: `TZ=America/Los_Angeles 15 5 * * *`
- receipts: `/Volumes/three-body/sessions/receipts/*.json`

Treat stale or empty `/Volumes/three-body/sessions` as a critical backup failure even when `runs_dev` Typesense indexes are fresh. Typesense is derived; raw transcripts and run blobs are the source of truth.

## When to Run

- **Session start** — orient on system state before doing work
- **After loops complete** — verify nothing broke
- **After infra changes** — k8s, worker, Redis config
- **When something feels off** — quick triage

## Fixing Common Issues

**Repo drift**: `cd ~/Code/joelhooks/joelclaw && git fetch origin && git status -sb`

**pi-tools broken**: `cd ~/.pi/agent/git/github.com/joelhooks/pi-tools && bun add @sinclair/typebox @mariozechner/pi-coding-agent @mariozechner/pi-tui @mariozechner/pi-ai`

**PDS unreachable**: `curl -fsS http://localhost:9627/xrpc/_health` then `kubectl get deploy,svc,pods,pvc -n joelclaw | rg 'bluesky-pds|NAME'` (or if pod down: `kubectl rollout restart deployment/bluesky-pds -n joelclaw`)

**Worker down**: `joelclaw inngest restart-worker --register`

**Stale tests**: `rm -rf ~/Code/joelhooks/joelclaw/packages/system-bus/__tests__/ && find ~/Code/joelhooks/joelclaw/packages/system-bus/src -name "*.acceptance.test.ts" -delete`

**System-bus test false reds**: the health script runs each `src/**/*.test.ts` file in its own Bun process because several legacy tests monkey-patch globals or use `mock.module`. If the aggregate health check is green but raw `bun test` is red, suspect inter-file mock leakage before treating runtime code as broken.

**Loop tmp bloat**: `rm -rf /tmp/agent-loop/loop-*/` (only when no loops are running)

## Inngest Hung-Run Quick Triage

When a run appears stuck after first step:

```bash
joelclaw run <run-id>
```

If trace shows `Finalization` failure with `"Unable to reach SDK URL"`:

1. Verify registration/health:
`joelclaw inngest status`

2. Verify function is present where expected:
`joelclaw functions | rg -i "manifest-archive|<function-name>"`

3. Check for stale app registrations in Inngest UI/API and remove stale SDK URLs.

4. Assume possible handler blocking (not just network):
review recent step code for filesystem/Redis/subprocess blocking before step response.
