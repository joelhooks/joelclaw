# ADR-0010 Loop — Continuation Prompt

Paste this into a fresh session to fire the ADR writing loop.

---

## Context

We generalized the agent loop to support non-code projects via a `checks` field on the PRD. When `checks: ["test"]`, the reviewer skips typecheck and lint, only runs `bun test`. This lets the loop write documents (like ADRs) where the reviewer writes structural tests against markdown content.

## What's ready

- **PRD**: `~/Code/joelhooks/joelclaw/packages/system-bus/prd-adr-0010.json` — 4 stories that build ADR-0010 section by section
- **checks: ["test"]** — reviewer will only run bun test, not typecheck/lint
- **Monorepo**: `joelhooks/joelclaw` on GitHub with system-bus as a package
- **Worker**: 10 Inngest functions registered, running from `packages/system-bus/`
- **Redis PRD**: PRD state stored in Redis, all functions read/write through it
- **Retro**: agent-loop-retro writes reflection to `~/Vault/system/retrospectives/` after completion

## Codebase patterns

- Bun runtime, Inngest v3, typed events
- Worker on port 3111, Inngest server at localhost:8288
- `igs` CLI at `~/Code/joelhooks/igs` (also now `packages/cli` in monorepo)
- Restart worker: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
- Force re-register: `curl -s -X PUT http://localhost:3111/api/inngest`
- Check functions: `cd ~/Code/joelhooks/igs && bun run src/cli.ts functions`
- slog for logging: `slog write --action ACTION --tool TOOL --detail "what" --reason "why"`

## CLI migration loop (may still be running)

Loop `loop-mln0sl5l-y5k32r` was running on the joelclaw monorepo doing CLI-1/2/3 migration. Check status:
```bash
cd ~/Code/joelhooks/igs && bun run src/cli.ts loop status loop-mln0sl5l-y5k32r
```

## Task: Fire ADR-0010 loop

```bash
cd ~/Code/joelhooks/igs && bun run src/cli.ts loop start \
  --project ~/Code/joelhooks/joelclaw \
  --prd packages/system-bus/prd-adr-0010.json \
  --max-retries 3 \
  --max-iterations 6
```

This will:
1. PLANNER creates branch `agent-loop/{loopId}`, seeds PRD to Redis
2. For each story (ADR10-1 through ADR10-4):
   - IMPLEMENTOR: claude writes the ADR section as markdown
   - REVIEWER: writes structural tests (file exists, has required sections, word counts), runs `bun test` only (no typecheck/lint)
   - JUDGE: evaluates, retries with model escalation if needed
3. On completion: retro writes reflection to Vault, recommendations to project

## After the loop

1. Check the ADR: `cat ~/Vault/docs/decisions/0010-system-loop-gateway.md`
2. Check retro: `ls ~/Vault/system/retrospectives/`
3. Check recommendations: `cat ~/Code/joelhooks/joelclaw/.agent-loop-recommendations.json`
4. Review the branch: `cd ~/Code/joelhooks/joelclaw && git log --oneline agent-loop/{loopId}`

## What this validates

- Generalized loop running on a non-code project (ADR/markdown)
- `checks: ["test"]` properly skipping typecheck/lint
- The loop writing its own brain's spec (ADR-0010 designs the system loop)
- Full pipeline: Redis PRD → branch → implement → review(test-only) → judge → retro
