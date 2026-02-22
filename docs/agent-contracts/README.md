# Agent Contracts

This directory holds agent-facing CLI contract artifacts (baseline snapshots, capability maps, and policy contract notes).

## Shared policy workflow contract

Canonical workflow: `.github/workflows/agent-contracts.yml` (job: `policy-validators`).

This is the **single shared policy workflow** for contract/guard enforcement. It must include this validator set:

1. `bun run validate:cli-contracts`
2. `bun run validate:llm-observability-guards`
3. `bun run validate:no-legacy-worker-clone`
4. `bun test packages/cli/src/commands/contract-envelope.test.ts`
5. `bun test packages/cli/src/commands/capabilities.test.ts`
6. `bun test packages/cli/src/commands/search.test.ts`
7. `pnpm --filter @joelclaw/cli check-types`

### Drift policy

- Do **not** split these validators into separate dedicated workflows.
- Any change to this validator set must update:
  - `.github/workflows/agent-contracts.yml`
  - this `docs/agent-contracts/README.md`
  - ADR notes in `0093` (and `0089`/`0101` when applicable)
