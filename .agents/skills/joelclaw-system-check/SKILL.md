---
name: joelclaw-system-check
description: "Run a comprehensive health check of the joelclaw system — k8s cluster, worker, Inngest, Redis, Qdrant, tests, TypeScript, repo sync, memory pipeline, pi-tools, git config, active loops, disk, stale tests. Outputs a 1-10 score with per-component breakdown. Use when: 'system health', 'health check', 'is everything working', 'system status', 'how's the system', 'check everything', or at session start to orient."
---

# joelclaw System Health Check

Run `scripts/health.sh` for a full system health report with 1-10 score.

```bash
~/.agents/skills/joelclaw-system-check/scripts/health.sh
```

## What It Checks (13 components)

| Check | What | Green (10) | Yellow (5-7) | Red (1-3) |
|-------|------|-----------|-------------|----------|
| k8s cluster | pods in `joelclaw` namespace | 3/3 Running, 0 restarts | partial pods | no pods |
| worker | system-bus on :3111 | 16+ functions | responding, low count | down |
| inngest server | :8288 reachable | responding | — | down |
| redis | PING/PONG on :6379 | PONG + memory | — | down |
| qdrant | memory_observations collection | points + real vectors | points, zero vectors | no points |
| tests | `bun test` in system-bus | 0 fail | — | failures |
| tsc | `tsc --noEmit` | clean | — | type errors |
| repo sync | worker vs monorepo HEAD | same commit | — | drifted |
| memory pipeline | observations in Redis | 50+ obs, 7+ days | collecting (<50) | none |
| pi-tools | extension deps installed | all 3 deps | — | missing |
| git config | user.name + email set | set | — | missing |
| disk | free space + loop tmp | <80% used | — | >80% |
| stale tests | `__tests__/` + acceptance tests | clean | — | present |

## When to Run

- **Session start** — orient on system state before doing work
- **After loops complete** — verify nothing broke
- **After infra changes** — k8s, worker, Redis config
- **When something feels off** — quick triage

## Fixing Common Issues

**Repo drift**: `cd ~/Code/system-bus-worker && git fetch origin && git reset --hard origin/main`

**pi-tools broken**: `cd ~/.pi/agent/git/github.com/joelhooks/pi-tools && bun add @sinclair/typebox @mariozechner/pi-coding-agent @mariozechner/pi-tui @mariozechner/pi-ai`

**Worker down**: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker && sleep 3 && igs refresh`

**Stale tests**: `rm -rf ~/Code/joelhooks/joelclaw/packages/system-bus/__tests__/ && find ~/Code/joelhooks/joelclaw/packages/system-bus/src -name "*.acceptance.test.ts" -delete`

**Loop tmp bloat**: `rm -rf /tmp/agent-loop/loop-*/` (only when no loops are running)
