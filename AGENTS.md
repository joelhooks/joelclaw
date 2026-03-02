# joelclaw — Agent Instructions

Personal AI infrastructure monorepo. Event-driven pipelines, always-on gateway, CLI tooling, and the joelclaw.com website. Built by Joel Hooks, operated by agents.

## Architecture

```
┌─ Mac Mini "Panda" (M4 Pro, 64GB, always-on) ──────────────────────┐
│                                                                     │
│  Colima VM (VZ framework, aarch64)                                  │
│    └─ Talos v1.12.4 container → k8s v1.35.0 (single node)         │
│        └─ namespace: joelclaw                                       │
│            ├─ inngest-0          (StatefulSet, ports 8288/8289)     │
│            ├─ redis-0            (StatefulSet, port 6379)          │
│            ├─ typesense-0        (StatefulSet, port 8108)          │
│            ├─ system-bus-worker  (Deployment, port 3111)           │
│            ├─ docs-api           (Deployment, port 3838)           │
│            ├─ livekit-server     (Deployment, ports 7880/7881)     │
│            └─ bluesky-pds        (Deployment, port 3000)           │
│                                                                     │
│  Gateway daemon (pi session, always-on, Redis event bridge)         │
│  NAS "three-body" (ASUSTOR, 10GbE NFS, 64TB RAID5 + 1.9TB NVMe)  │
│  Tailscale mesh (all devices)                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Monorepo Layout

```
joelclaw/
├── apps/
│   ├── web/                    # joelclaw.com (Next.js 16, RSC, Vercel)
│   ├── docs/                   # Documentation site
│   └── docs-api/               # PDF/docs REST API (k8s)
├── packages/
│   ├── cli/                    # @joelclaw/cli — `joelclaw` command
│   ├── system-bus/             # @joelclaw/system-bus — 110+ Inngest functions
│   ├── gateway/                # @joelclaw/gateway — multi-channel message routing
│   ├── inference-router/       # @joelclaw/inference-router — model selection catalog
│   ├── model-fallback/         # @joelclaw/model-fallback — provider fallback chains
│   ├── message-store/          # @joelclaw/message-store — Redis message queue
│   ├── vault-reader/           # @joelclaw/vault-reader — Vault context injection
│   ├── markdown-formatter/     # @joelclaw/markdown-formatter — per-platform formatting
│   ├── telemetry/              # @joelclaw/telemetry — OTEL emission interface
│   ├── pi-extensions/          # @joelclaw/pi-extensions — pi agent extensions
│   ├── email/                  # @joelclaw/email — email processing
│   ├── mdx-pipeline/           # @joelclaw/mdx-pipeline — MDX content processing
│   ├── lexicons/               # @joelclaw/lexicons — AT Protocol lexicons
│   ├── discord-ui/             # @joelclaw/discord-ui — Discord components
│   ├── things-cloud/           # @joelclaw/things-cloud — Things integration
│   └── ui/                     # @repo/ui — shared UI components
├── k8s/                        # Kubernetes manifests + deploy scripts
├── skills/                     # Agent skills (canonical, 52 skills)
├── scripts/                    # Utility scripts
├── infra/                      # Infrastructure config
└── AGENTS.md                   # This file
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Package manager | pnpm workspaces |
| Language | TypeScript (strict) |
| Web framework | Next.js 16 (App Router, RSC, PPR) |
| Effect system | Effect, @effect/cli, @effect/schema, @effect/platform |
| Workflows | Inngest (self-hosted, 110+ durable functions) |
| State | Redis (k8s StatefulSet) |
| Search | Typesense (full-text + vector) |
| Video | Mux |
| Observability | OTEL → Typesense + Langfuse |
| Infrastructure | Talos Linux on Colima, k8s v1.35.0 |
| Deployment | Vercel (web), GHCR + k8s (worker) |
| Storage | NAS (NFS over 10GbE), Vault (Obsidian) |

## Hexagonal Architecture (ADR-0144) — MANDATORY

Heavy logic lives in standalone `@joelclaw/*` packages behind interfaces. Consumers (gateway, CLI) are thin composition roots that wire adapters together.

### Package Boundary Rules

- **Import via `@joelclaw/*`**, never via relative paths across package boundaries.
- **DI via interfaces** in library packages. Only composition roots do concrete wiring.
- **New heavy logic → new package** if it's >100 lines and reusable.
- **One telemetry interface** — `TelemetryEmitter` from `@joelclaw/telemetry`.
- **One model resolver** — `@joelclaw/inference-router` catalog for ALL model selection.

```typescript
// ✅ Correct
import { persist, drainByPriority } from "@joelclaw/message-store";
import type { TelemetryEmitter } from "@joelclaw/telemetry";

// ❌ Wrong — cross-package relative import
import { persist } from "../../message-store/src/store";
```

### Validation

After any code change:
```bash
bunx tsc --noEmit
pnpm biome check packages/ apps/
```

### Post-Push Deploy Verification

After every `git push` that touches `apps/web/` or root config (`turbo.json`, `package.json`, `pnpm-lock.yaml`):
1. Wait 60–90s, then: `cd ~/Code/joelhooks/joelclaw && vercel ls --yes 2>&1 | head -10`
2. **● Error** → STOP. Fix the build before pushing anything else.
3. **● Ready** → Continue.
Never stack commits on a broken deploy. This rule exists because a 2026-03-01 session pushed 57 commits without checking — broke production for 45 minutes.

### Mandatory Skill Loading

Before modifying code in any domain, load the relevant skills FIRST:

| Path | Required Skills |
|---|---|
| `apps/web/` | `next-best-practices`, `next-cache-components`, `nextjs-static-shells`, `vercel-debug` |
| `packages/system-bus/` | `inngest-durable-functions`, `inngest-steps`, `inngest-events`, `inngest-flow-control`, `system-bus` |
| `packages/gateway/` | `gateway`, `telegram` |
| `k8s/` | `k8s` |

## CLI — `joelclaw`

The CLI is the primary operator interface. Built with `@effect/cli`, compiled to binary at `~/.bun/bin/joelclaw`. Returns HATEOAS JSON envelopes.

**If the CLI crashes, that's the highest priority fix.** Heavy deps must be lazy-loaded.

### Key Commands

```bash
joelclaw status                        # Health check (server, worker, k8s)
joelclaw runs [--count N] [--hours H]  # Recent Inngest runs
joelclaw run <run-id>                  # Step trace for a run
joelclaw send <event> [-d JSON]        # Send Inngest event
joelclaw logs worker|errors|server     # Service logs
joelclaw subscribe list|add|remove|check|summary  # Feed subscriptions
joelclaw gateway status|events|test    # Gateway operations
joelclaw otel list|search|stats        # Observability
joelclaw loop start|status|cancel      # Agent coding loops
joelclaw discover <url> [-c context]   # Capture discovery
joelclaw recall <query>                # Semantic memory search
joelclaw inngest status|restart-worker # Inngest management
```

### Building

```bash
cd ~/Code/joelhooks/joelclaw
bun build packages/cli/src/cli.ts --compile --outfile ~/.bun/bin/joelclaw
```

Test after every change: `joelclaw status`, `joelclaw send --help`, `joelclaw runs --count 1`.

## System Bus Worker

110+ Inngest functions in `packages/system-bus/src/inngest/functions/`. Deployed to k8s as `system-bus-worker`.

### Deploy

```bash
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh
```

Builds ARM64 image, pushes to GHCR, updates k8s deployment, verifies rollout.

### LLM Inference in Functions

System-bus functions that need LLM calls MUST use:
```typescript
import { infer } from "../../lib/inference";
```

This shells to `pi -p --no-session --no-extensions` — zero config, zero API cost. Never use OpenRouter, never read auth.json directly, never use paid API keys.

## Gateway

Always-on pi session with Redis event bridge. Receives messages from Telegram, Slack, Discord, iMessage. Routes through priority queue. Respects sleep mode.

- Gateway middleware (`packages/system-bus/src/inngest/middleware/gateway.ts`) auto-injects `gateway` context into Inngest functions.
- Channel implementations: `packages/gateway/src/channels/types.ts`

## Observability

Silent failures are bugs. Every pipeline step emits structured telemetry.

```bash
joelclaw otel list --hours 1           # Recent events
joelclaw otel search "error" --hours 24 # Search
joelclaw otel stats --hours 24          # Aggregate stats
```

Storage: Typesense `otel_events` collection.

## Skills

52 skills in `skills/` — **canonical source, fully tracked in git**.

Canonical coordination protocol skill: `skills/clawmail/SKILL.md`.

Home directories symlink in:
- `~/.agents/skills/<name>` → `~/Code/joelhooks/joelclaw/skills/<name>`
- `~/.pi/agent/skills/<name>` → `~/Code/joelhooks/joelclaw/skills/<name>`

**Never** put skill content in dot directories (`.agents/`, `.pi/`, `.claude/`). Those are symlink consumers, not sources. The `skills/` directory is sacred.

When operational reality changes, update the relevant skill immediately.

## Vault

`~/Vault` (Obsidian, PARA method) is the knowledge base:
- `docs/decisions/` — Architecture Decision Records (ADR-0001 through ADR-0157+)
- `system/system-log.jsonl` — structured system log (`slog` CLI)
- `Resources/` — contacts, discoveries, video notes
- `Projects/` — active project notes

## Key ADRs

| ADR | Title | Status |
|-----|-------|--------|
| 0088 | NAS-backed storage tiering | Phase 1-2 ✅, Phase 3-4 open |
| 0127 | Feed subscriptions & resource monitoring | Shipped |
| 0140 | Inference router | Shipped |
| 0144 | Gateway hexagonal architecture | Shipped |
| 0155 | Three-stage story pipeline | Shipped |
| 0156 | Graceful worker restart | Accepted |
| 0157 | Agent lifecycle CLI | Proposed |

## Logging System Changes

Any install, config change, or ops mutation → `slog write`:
```bash
slog write --action configure --tool <tool> --detail "<what changed>" --reason "<why>"
```

## Git Workflow

- Do not use destructive commands (`git reset --hard`) unless explicitly requested.
- Never discard user changes without consent.
- Commit to `main` directly for operational work. PRs for features when loops are involved.

## Model Policy

- Codex tasks MUST use `gpt-5.3-codex`.
- All model selection goes through `@joelclaw/inference-router` catalog.
- Never hardcode model→provider mappings.
