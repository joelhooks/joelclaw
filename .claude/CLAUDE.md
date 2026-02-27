# joelclaw — Claude Code Instructions

Read `AGENTS.md` at repo root for the full system overview. This file adds Claude Code-specific guidance.

## Quick Context

Personal AI infrastructure monorepo. pnpm workspaces, Bun runtime, Effect ecosystem, Next.js 16 web app, 110+ Inngest durable functions, k8s cluster (Talos on Colima).

## Before Writing Code

1. **Check the relevant skill** — `skills/` has 51 skills covering CLI design, gateway ops, k8s, Inngest patterns, and more. Read the skill before implementing.
2. **Check ADRs** — `~/Vault/docs/decisions/` has 157+ architecture decision records. If your change touches architecture, there should be an ADR backing it.
3. **Understand the package map** — imports cross package boundaries via `@joelclaw/*`, never relative paths. See AGENTS.md § Hexagonal Architecture.

## Validation Checklist

After every code change:
```bash
bunx tsc --noEmit                      # Type check
pnpm biome check packages/ apps/       # Lint + import boundaries
```

After CLI changes:
```bash
bun build packages/cli/src/cli.ts --compile --outfile ~/.bun/bin/joelclaw
joelclaw status                        # Crash test
```

After system-bus changes:
```bash
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh
```

## Style

- TypeScript strict mode, Effect for typed errors and services
- `@effect/cli` for CLI commands, HATEOAS JSON envelopes
- Server Components by default, `"use client"` only when needed
- No fluff in code or comments. Concise, direct.

## Key Paths

| What | Where |
|------|-------|
| CLI entry | `packages/cli/src/cli.ts` |
| CLI commands | `packages/cli/src/commands/` |
| Inngest functions | `packages/system-bus/src/inngest/functions/` |
| Gateway channels | `packages/gateway/src/channels/` |
| Web app | `apps/web/` |
| Skills (canonical) | `skills/` |
| k8s manifests | `k8s/` |
| ADRs | `~/Vault/docs/decisions/` |
| System log | `~/Vault/system/system-log.jsonl` |

## Don't

- Don't import across package boundaries with relative paths
- Don't use OpenRouter or paid API keys — use `pi` for inference
- Don't add skills to dot directories — `skills/` is canonical
- Don't `git reset --hard` without explicit permission
- Don't leave silent failures — emit telemetry
