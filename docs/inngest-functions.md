# Inngest Functions

Canonical notes for `packages/system-bus/src/inngest/functions/`.

## Contract

- Durable workflows only (`step.run`, `step.sendEvent`, etc.).
- Retries are mandatory (`retries: 0` is forbidden unless explicitly justified in ADR).
- Every critical branch emits OTEL evidence.
- Health checks should route remediation via `system/self.healing.requested` and carry playbook context.

## Key reliability flows

### System health

- function: `system/check-system-health`
- file: `packages/system-bus/src/inngest/functions/check-system-health.ts`
- inputs:
  - cron heartbeat checks
  - `system/health.check.requested`
- checks include core services (`Inngest`, `Worker`, `Redis`, etc.) and mount probes.

### Self-healing router

- function: `system/self-healing.router`
- file: `packages/system-bus/src/inngest/functions/self-healing-router.ts`
- input event: `system/self.healing.requested`
- responsibility: apply retry/defer/escalate policy and emit target remediation events.

### Inngest runtime remediation (new)

- function: `system/self-healing.inngest-runtime`
- file: `packages/system-bus/src/inngest/functions/self-healing-inngest-runtime.ts`
- triggers:
  - cron: `TZ=America/Los_Angeles */10 * * * *`
  - `system/inngest.runtime.health.requested`
  - `system/self.healing.requested` (domain-filtered)
- behavior:
  1. probe runtime health (`joelclaw inngest status`)
  2. if degraded and not dry run, run `joelclaw inngest restart-worker --register --wait-ms 1500`
  3. re-probe and emit before/after OTEL evidence

## Backup hardening

### Typesense backup + snapshot retention

- function: `system/backup.typesense`
- file: `packages/system-bus/src/inngest/functions/nas-backup.ts`
- snapshot creation supports primary→fallback root selection.
- after successful NAS sync:
  - delete just-created snapshot dir in pod
  - prune old snapshot dirs by retention count

Environment variables:

- `TYPESENSE_SNAPSHOT_ROOT` (default: `/data/snapshots`)
- `TYPESENSE_SNAPSHOT_FALLBACK_ROOT` (default: `/data/snapshots`)
- `TYPESENSE_SNAPSHOT_RETENTION_COUNT` (default: `2`, min `1`)

## Verification

```bash
bunx tsc --noEmit
bun test packages/system-bus/src/inngest/functions/check-system-health.test.ts
joelclaw inngest status
joelclaw otel search "system.self-healing.inngest-runtime" --hours 1
```

## Deploy

```bash
./k8s/publish-system-bus-worker.sh
joelclaw inngest restart-worker --register
joelclaw inngest status
```

## Related ADRs

- `docs/decisions/0010-system-loop-gateway.md`
- `~/Vault/docs/decisions/0088-nas-backed-storage-tiering.md`
