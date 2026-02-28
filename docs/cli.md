# joelclaw CLI

Canonical operator interface for joelclaw.

## Contract

- JSON envelope output (`ok`, `command`, `result`, `next_actions`)
- Deterministic error codes via `respondError`
- HATEOAS navigation in every command response
- Heavy dependencies loaded lazily when possible
- Capability adapter registry with typed command contracts (`packages/cli/src/capabilities/`)

## Command roots

- `joelclaw status`
- `joelclaw runs`
- `joelclaw agent`
- `joelclaw content`
- `joelclaw gateway`
- `joelclaw loop`
- `joelclaw docs`
- `joelclaw vault`
- `joelclaw skills`
- `joelclaw mail`
- `joelclaw secrets`
- `joelclaw log`
- `joelclaw notify`
- `joelclaw otel`
- `joelclaw recall`
- `joelclaw subscribe`
- `joelclaw inngest`
- `joelclaw capabilities`

## Capability adapter config precedence (ADR-0169 phase 0)

Resolution order is deterministic:

1. CLI flags (e.g. `--adapter`)
2. Environment variables
3. Project config (`.joelclaw/config.toml`)
4. User config (`~/.joelclaw/config.toml`)
5. Built-in defaults

Current env keys:

- `JOELCLAW_CAPABILITY_<CAPABILITY>_ADAPTER`
- `JOELCLAW_CAPABILITY_<CAPABILITY>_ENABLED`

## Capability-backed command roots (ADR-0169 through phase 4)

```bash
joelclaw secrets status
joelclaw secrets lease <name> --ttl 15m
joelclaw secrets revoke <lease-id>
joelclaw secrets revoke --all
joelclaw secrets audit --tail 50
joelclaw secrets env --dry-run [--ttl 1h] [--force]

joelclaw log write --action <action> --tool <tool> --detail <detail> [--reason <reason>]

joelclaw notify send "<message>" [--priority low|normal|high|urgent] [--channel gateway|main|all] [--context '{"k":"v"}']

joelclaw mail {status|register|send|inbox|read|reserve|release|locks|search}

joelclaw otel {list|search|stats}

joelclaw recall <query> [--limit N] [--min-score F] [--raw] [--include-hold] [--include-discard] [--budget auto|lean|balanced|deep] [--category <id|alias>]

joelclaw subscribe {list|add|remove|check|summary}
```

Semantics:

- `log` writes structured system entries (slog backend).
- `logs` reads/analyzes runtime logs.
- `notify` is the canonical operator alert command; `gateway push` remains transport/debug.
- `mail`, `otel`, `recall`, and `subscribe` keep their existing UX/envelopes while now executing through capability registry adapters (`mcp-agent-mail`, `typesense-otel`, `typesense-recall`, `redis-subscriptions`).
- `subscribe check` emits Inngest request events; `response.ids` are event/request IDs (inspect via `joelclaw event <event-id>`), not run IDs unless explicitly returned as `runIds`.

## Skills command tree (ADR-0179)

```bash
joelclaw skills
└── audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]
```

### `joelclaw skills audit` purpose

- triggers the `skill-garden/check` event on-demand
- waits for the corresponding run and returns the findings report in-envelope
- supports `--deep` for LLM staleness checks

## Agent command tree (ADR-0180 phases 2-3)

```bash
joelclaw agent
├── list
├── show <name>
├── run <name> <task> [--cwd <cwd>] [--timeout <seconds>]
└── chain <steps> --task <task> [--cwd <cwd>] [--fail-fast]
```

Semantics:

- `run` emits `agent/task.run` for single roster agent execution and returns `taskId` plus `eventIds` from the Inngest send response.
- `run` `next_actions` are truthful: use `joelclaw event <event-id>` when an event ID exists (or `joelclaw events ...` fallback), and never assume `taskId` is a run ID.
- `chain` emits `agent/chain.run` with comma-separated sequential steps and `+` parallel groups (e.g. `scout,planner+reviewer,coder`).

## Vault command tree

```bash
joelclaw vault
├── read <ref>
├── search <query> [--semantic] [--limit <limit>]
├── ls [section]
├── tree
└── adr
    ├── list [--status <status>] [--limit <limit>]
    ├── collisions
    └── audit
```

### `joelclaw vault adr` purpose

- `list` — inventory ADR metadata with optional status filter
- `collisions` — detect duplicate ADR numeric prefixes
- `audit` — full ADR hygiene check:
  - missing/non-canonical status values
  - number collisions
  - missing `superseded-by` targets
  - README index alignment against ADR files

Canonical statuses:

- `proposed`
- `accepted`
- `shipped`
- `superseded`
- `deprecated`
- `rejected`

## Content command tree (ADR-0168)

```bash
joelclaw content
├── seed
├── verify
└── prune [--apply]
```

Semantics:

- `seed` — full Vault ADR sync to Convex.
- `verify` — strict ADR drift check (fails healthy state on both missing and extra ADR records in Convex).
- `prune` — dry-run report of Convex ADR extras (`status: dry_run`).
- `prune --apply` — removes ADR extras from Convex (`status: pruned`) and should be followed by `joelclaw content verify`.

## Build and verify

```bash
bunx tsc --noEmit
pnpm biome check packages/ apps/
bun test packages/cli/src/commands/*.test.ts
bun build packages/cli/src/cli.ts --compile --outfile ~/.bun/bin/joelclaw
joelclaw status
joelclaw vault
joelclaw vault adr audit
```

## Add a command

1. Create command module in `packages/cli/src/commands/`.
2. Return envelopes with `respond`/`respondError` only.
3. Include useful `next_actions` with param hints.
4. Wire command in `packages/cli/src/cli.ts`.
5. Add/extend tests in `packages/cli/src/commands/*.test.ts`.
6. Update this file when command tree or contracts change.
