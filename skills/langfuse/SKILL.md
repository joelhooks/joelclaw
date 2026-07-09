---
name: langfuse
displayName: Langfuse (decommissioned)
description: Langfuse was decommissioned on 2026-07-09 — do not add Langfuse tracing or query Langfuse for usage/cost. Use this skill only to learn where usage observability lives now. Token usage and cost questions route to `joelclaw usage` and ClickHouse otel_events.
version: 1.0.0
author: joel
tags:
  - observability
  - decommissioned
---

# Langfuse — decommissioned 2026-07-09

Langfuse is gone. It was never migrated to Flagg, its traces API 429'd/422'd under real query load (2026-07 backup/self-healing token-drain post-mortem), and every code path was removed from this repo (`grep -ri langfuse packages/ apps/` returns zero).

## Where usage observability lives now

- **CLI:** `joelclaw usage --hours 24 [--source router|agents|all] [--model X] [--machine Y] [--json]`
- **Query layer:** `packages/system-bus/src/lib/clickhouse-usage-query.ts` over ClickHouse `joelclaw.otel_events`
- **Router usage:** `model_router.result` events carry a full `usage` object in `metadata_json` (fixed by passing `--mode json` to pi in `inference.ts`)
- **Agent sessions:** passive tailers (`packages/system-bus/src/lib/agent-usage/`) parse Pi/Claude Code/Codex transcripts into `agent_usage.turn` events every 15 min (`system/agent-usage.scan`)
- **Pricing:** `packages/system-bus/src/lib/model-pricing.ts` — provider-reported cost wins; OpenRouter public pricing is the benchmark fallback (pricing data only, never an inference path)
- **Daily report:** `daily-token-usage-report.ts` reads ClickHouse directly

## Residue

- `pi/extensions/langfuse-cost` still exists but degrades to disabled telemetry (fails soft, by design). Superseded by the agent-usage tailers; removal is a pending follow-up.
- `LANGFUSE_*` secrets in the secrets store are unused and can be revoked.

Project receipts: `.brain/projects/agent-usage-observability-2026-07-09.svx`.
