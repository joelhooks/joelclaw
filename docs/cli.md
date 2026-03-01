# joelclaw CLI

Canonical operator interface for joelclaw.

## Contract

- JSON envelope output (`ok`, `command`, `result`, `next_actions`)
- Deterministic error codes via `respondError`
- HATEOAS navigation in every command response
- Heavy dependencies loaded lazily when possible
- Capability adapter registry with typed command contracts (`packages/cli/src/capabilities/`)

## Health endpoint fallback (ADR-0182)

CLI health probes for Inngest and worker resolve endpoints in this order:

1. `localhost`
2. discovered Colima VM IP (`JOELCLAW_COLIMA_VM_IP`, fallback `192.168.64.2`)
3. k8s service DNS (`*.joelclaw.svc.cluster.local`)

Probe detail strings include the selected endpoint class (`localhost|vm|svc_dns`) and skipped-candidate counts.

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
- `joelclaw webhook`
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

## Webhook command tree (ADR-0185)

```bash
joelclaw webhook
├── subscribe <provider> <event>
│   [--repo <owner/repo>] [--workflow <name>] [--branch <name>] [--conclusion <status>]
│   [--session <session-id>] [--ttl <duration>] [--stream] [--timeout <seconds>] [--replay <count>]
├── unsubscribe <subscription-id>
├── list [--provider <provider>] [--event <event>] [--session <session-id>]
└── stream <subscription-id> [--timeout <seconds>] [--replay <count>]
```

Semantics:

- Subscriptions are Redis-backed and session-scoped (`joelclaw:webhook:*`).
- `subscribe --stream` starts an NDJSON stream immediately after creation.
- `stream` emits ADR-0058 NDJSON (`start`, `log`, `event`, terminal `result|error`).
- Default session target is `gateway` for central gateway role, otherwise `pid-<ppid>`.
- TTL defaults to `24h` and is enforced at match time.

## Skills command tree (ADR-0179)

```bash
joelclaw skills
└── audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]
```

### `joelclaw skills audit` purpose

- triggers the `skill-garden/check` event on-demand
- waits for the corresponding run and returns the findings report in-envelope
- supports `--deep` for LLM staleness checks

## Agent command tree (ADR-0180 phases 2-4)

```bash
joelclaw agent
├── list
├── show <name>
├── run <name> <task> [--cwd <cwd>] [--timeout <seconds>]
├── chain <steps> --task <task> [--cwd <cwd>] [--fail-fast]
└── watch <id> [--timeout <seconds>]
```

Semantics:

- `run` emits `agent/task.run` for single roster agent execution and returns `taskId` plus `eventIds` from the Inngest send response.
- `run` `next_actions` are truthful: use `joelclaw event <event-id>` when an event ID exists (or `joelclaw events ...` fallback), and never assume `taskId` is a run ID.
- `chain` emits `agent/chain.run` with comma-separated sequential steps and `+` parallel groups (e.g. `scout,planner+reviewer,coder`).
- `watch` streams NDJSON progress for a task (`at-...`) or chain (`ac-...`) by subscribing to `joelclaw:notify:gateway`, replaying `joelclaw:events:gateway`, and falling back to Inngest polling.
- `watch` default timeout is 300 seconds for tasks and 900 seconds for chains; terminal events always include `next_actions` on completion, timeout, or interrupt.
- Runtime-proof recipe (ADR-0180):
  1. `joelclaw agent list` (expect builtin `coder/designer/ops`)
  2. `joelclaw agent run coder "reply with OK" --timeout 20`
  3. `joelclaw event <event-id>` (expect `Agent Task Run` status `COMPLETED` with output payload)
- If `Unknown agent roster entry: coder` appears, treat it as worker-runtime drift: deploy latest `system-bus-worker`, restart the host worker, then rerun the three-step proof.

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
    ├── audit
    └── rank [--status <status,status>] [--limit <limit>] [--strict]
```

### `joelclaw vault adr` purpose

- `list` — inventory ADR metadata with optional status filter
- `collisions` — detect duplicate ADR numeric prefixes
- `audit` — full ADR hygiene check:
  - missing/non-canonical status values
  - number collisions
  - missing `superseded-by` targets
  - README index alignment against ADR files
- `rank` — score + rank ADRs by NRC+novelty rubric for daily prioritization:
  - required axes: `priority-need`, `priority-readiness`, `priority-confidence`
  - novelty facet: `priority-novelty` (or alias `priority-interest`), defaults to neutral `3` when missing
  - score formula: `clamp(round(20*(0.5*Need + 0.3*Readiness + 0.2*Confidence)) + round((Novelty-3)*5), 0, 100)`
  - bands: `do-now` (80-100), `next` (60-79), `de-risk` (40-59), `park` (0-39)

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

- `seed` — full Vault ADR sync to Convex for canonical ADR filenames only (`NNNN-*.md`).
- `verify` — strict ADR drift check against canonical ADR files (fails healthy state on both missing and extra ADR records in Convex).
- `prune` — dry-run report of Convex ADR extras (`status: dry_run`).
- `prune --apply` — removes ADR extras from Convex (`status: pruned`) and should be followed by `joelclaw content verify`.

## Inngest source guard (ADR-0089)

```bash
joelclaw inngest source [--repair]
```

Semantics:

- Verifies launchd binding for `com.joel.system-bus-worker` against the canonical `infra/launchd/com.joel.system-bus-worker.plist` values (program + working directory).
- `--repair` copies canonical plist into `~/Library/LaunchAgents`, performs `launchctl bootout`, then `bootstrap` with retry for transient `Bootstrap failed: 5` launchd races.
- Use before `joelclaw inngest restart-worker` when host runtime/source drift is suspected.

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
