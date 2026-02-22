# O11y Implementation Checklist

Use this checklist whenever you touch a pipeline, function, webhook path, or gateway behavior.

## Worker / Inngest Changes

1. Emit structured OTEL events via `emitOtelEvent` or `emitMeasuredOtelEvent`.
2. Record completion outcome (`success`, `error`, `duration_ms`).
3. Keep event names stable:
   - `source`: subsystem (`worker`, `memory`, `webhook`)
   - `component`: module-level owner (`observe`, `content-sync`, `check-system-health`)
   - `action`: dotted action (`memory.observe.completed`)
4. Put high-cardinality fields in `metadata`.
5. Avoid direct Typesense/Convex writes in feature logic for observability.

## Gateway Changes

1. Emit via `emitGatewayOtel` only.
2. Include queue/session identifiers in `metadata`.
3. Keep non-critical chatter at `debug/info`; reserve `warn/error/fatal` for actionable conditions.
4. Preserve backpressure behavior (debug/info drops are acceptable under load; high severity should still flow).

## Schema Rules

- Follow `packages/system-bus/src/observability/otel-event.ts` strictly.
- Required: `level`, `source`, `component`, `action`, `success`.
- Optional but expected where relevant: `duration_ms`, `error`, `metadata`.
- If `success` is `false`, include a meaningful `error`.

## Verification Gate (Run Before Done)

### 1) End-to-end ingest probe

```bash
./skills/o11y-logging/scripts/otel-smoke.sh verification o11y-skill probe.emit
```

### 2) Inspect recent events by source/component

```bash
joelclaw otel list --source verification --component o11y-skill --hours 1 --limit 20
```

### 3) Check error-rate snapshot

```bash
joelclaw otel stats --hours 1
```

### 4) Optional web API confirmation (owner-authenticated context)

```bash
curl -s "http://localhost:3000/api/otel?mode=list&source=verification&hours=1&limit=20"
```

## Escalation-Sensitive Paths

If your change affects health or critical delivery paths (gateway drain, webhook verification, worker startup, check-system-health):

1. Confirm failure emits `error` or `fatal`.
2. Confirm the event is queryable by `source/component/action`.
3. Confirm the behavior is visible to `check-system-health` and/or gateway immediate alert flows when appropriate.

## Anti-Patterns

- Scattered `console.log` replacing canonical events.
- Ad-hoc event field names per module.
- Logging secrets or raw sensitive payloads.
- Unbounded metric-like labels outside `metadata`.
- Marking expected behavior as `error`.
